/**
 * @module @echocore/dsh-memory/store
 *
 * MemoryStore：记忆条目的 CRUD、去重合并、评分检索与统计。
 * 底层为 storageDomain 的 KvTable（写操作经领域写链串行化、先持久后更新内存）；
 * 本类只依赖 KvTable 结构类型，测试可用内存假表注入，不依赖 Cordis 运行时。
 *
 * 设计要点：
 * - 去重：dedupKey（内容规范化哈希）→ id 的进程内索引，创建时 O(1) 查重；
 * - 合并：同 workspace 同 dedupKey 的重复记忆合并来源事件序号、提升重要性，
 *   保留先入条目的内容（避免提取抖动反复改写正文）；
 * - 检索：同步读 + 评分排序（数百条量级，KISS）；访问追踪为尽力而为的
 *   异步写回（失败只记录，不影响检索结果与主流程）。
 */

import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'

import { scoreEntry, tokenize } from './scoring.js'
import {
  dedupKeyOf,
  newMemoryId,
  type AuditActor,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStats,
  type MemoryStatus,
  type NewMemoryInput,
} from './types.js'

/** 检索选项 */
export interface SearchOptions {
  /** 查询文本（空串时若存在过滤条件则按创建时间倒序返回，否则空结果） */
  query: string
  /** workspace 过滤（跨会话聚合时限定当前会话所属 workspace） */
  workspace?: string
  /** 分类过滤（可选） */
  kind?: MemoryKind
  /** 标签过滤（命中任一标签，可选） */
  tag?: string
  /** 状态过滤（可选；缺省仅 active，除非 includeArchived） */
  status?: MemoryStatus
  /** 返回条数上限 */
  limit?: number
  /** 最低综合分（默认 0.15；仅在有查询文本时生效） */
  minScore?: number
  /** 是否包含归档条目（默认否；与 status 互斥时以 status 为准） */
  includeArchived?: boolean
  /** 是否包含被覆盖条目（D-A；默认否——被 superseded 的条目对检索隐藏，置真时可见用于审计） */
  includeSuperseded?: boolean
}

/**
 * D-A 后向引用判定阈值：新记忆与候选旧记忆的 token 集合 Jaccard 重合度 ≥ 该值且创建于其后，
 * 则视为「新表述覆盖旧表述」，将旧条目标记 supersededBy。
 */
const JACCARD_SIMILARITY_THRESHOLD = 0.7

/**
 * 访问追踪节流窗口（毫秒）：同一「会话 + 记忆」在该窗口内最多落盘一次，
 * 避免高频检索反复回写 lastAccessAt/accessCount（O6 性能）。
 */
const ACCESS_TRACK_WINDOW_MS = 60_000

/** 创建时去重合并的合并结果描述（供审计 detail 使用） */
export interface MergeOutcome {
  /** 是否发生合并（false 表示新建） */
  merged: boolean
  /** 命中的既有条目 id */
  existingId?: string
}

/** 时间戳生成（集中管理，便于测试注入固定时间） */
export type NowFn = () => number

/**
 * source 锚点完整性校验（R4-1：记忆投毒轻量防线——读路径防篡改）。
 * memory.json 是人类可读文件：手工编辑可能产生畸形 source（或注入无来源伪记忆）。
 * 检索/浏览路径跳过畸形条目并告警，getById 仍放行（审计必须能看到原始内容）。
 * 校验只要求字段存在与类型（宽容），不校验内容格式——避免误伤合法旧数据。
 */
export function isSourceWellFormed(source: unknown): source is { sessionId: string; eventSeqs: number[]; excerpt: string } {
  if (typeof source !== 'object' || source === null) return false
  const record = source as Record<string, unknown>
  return (
    typeof record.sessionId === 'string' &&
    record.sessionId !== '' &&
    Array.isArray(record.eventSeqs) &&
    record.eventSeqs.every((n) => typeof n === 'number') &&
    typeof record.excerpt === 'string'
  )
}

/**
 * MemoryStore：依赖一个 entries 表句柄。
 * 表句柄来自 `Domain.table('entries')`（装配处）或测试假表。
 */
export class MemoryStore {
  private readonly table: KvTable<string, MemoryEntry>
  private readonly now: NowFn
  /**
   * 去重索引：`workspace::kind::dedupKey` → id（进程内，构造时从表重建）。
   * 键含 kind（O3）：同内容不同分类不再合并；键含 workspace：跨项目同内容不合并。
   */
  private readonly byDedupKey = new Map<string, string>()
  /**
   * 访问追踪节流表：`sessionId::memoryId` → 上次落盘时刻（ms）。
   * 内存 Map，键随条目数变化、量级可控（数百条 × 数十会话），KISS 不做上限重建；
   * 记忆被归档后其键不再新增，空间可复用给新键。
   */
  private readonly lastTrackedAt = new Map<string, number>()
  /**
   * 内容变更版本（进程内）：create/update/archive（含 supersede 回写）落盘
   * 成功后递增。供稳定快照（stable-snapshot）判断缓存是否失效；**访问追踪
   * 回写（lastAccessAt/accessCount）不递增**——它不改变记忆内容，不应触发
   * 快照重建（否则高频检索会让快照永不稳定）。进程内计数足够：快照缓存同
   * 为进程内，重启后一并清空。
   */
  private revisionValue = 0

  constructor(
    table: KvTable<string, MemoryEntry>,
    now: NowFn = () => Date.now(),
    /** R4-1：畸形 source 条目被检索过滤时的告警回调（装配层注入 logger；无回调则静默过滤） */
    private readonly onCorruptSource?: (id: string) => void,
  ) {
    this.table = table
    this.now = now
    for (const [, entry] of table.entries()) {
      this.byDedupKey.set(dedupIndexKey(entry.workspace, entry.kind, entry.dedupKey), entry.id)
    }
  }

  /** 当前时刻 ISO 字符串 */
  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** 当前内容变更版本（稳定快照失效判定用；见 revisionValue 注释） */
  get revision(): number {
    return this.revisionValue
  }

  /**
   * 新建或去重合并一条记忆。
   * 合并（同 workspace 同 kind 同 dedupKey）：并集来源事件序号、importance 取更大者、
   * excerpt 取【新来源】摘录（信息更新而非保留旧摘录）、追加 merge 审计，保留既有内容与 id。
   * 新建（非合并，O3/D-A）：扫描同 workspace 同 kind 的 active 条目，Jaccard 重合度 ≥ 0.7
   * 且创建不晚于新条目的，全部标记 supersededBy=新id、新条目 supersedes=其中最早创建者。
   */
  /**
   * 创建（或去重合并）一条记忆。
   *
   * 并发边界（显式声明，非防御代码）：本方法**非并发安全**——dedup 索引
   * `byDedupKey` 在 `await table.put` 之后才落位（先持久后索引），两个并发
   * create 同 dedupKey 会在索引落位前各自判定 miss，产生两条重复条目
   * （检索仍可用，由 O8-M 重复合并兜底）。当前全部调用方（extractor 串行链、
   * 工具顺序调用、RPC 只读）均串行 await 本方法，单进程内无真实并发路径；
   * 若未来引入并发写入，需先加写入互斥。
   */
  async create(input: NewMemoryInput): Promise<{ entry: MemoryEntry; outcome: MergeOutcome }> {
    const dedupKey = dedupKeyOf(input.content)
    // 归并索引粒度含 kind：跨分类的同内容不合并（O3）
    const indexKey = dedupIndexKey(input.workspace, input.kind, dedupKey)
    const existingId = this.byDedupKey.get(indexKey)
    if (existingId !== undefined) {
      const existing = this.table.get(existingId)
      // 归档守卫（O3/H6）：不与被归档条目合并——否则新信息被吞进不可见条目；
      // 归档条目不占索引（此处相当于放行新建）。被覆盖条目仍为 active，可正常合并。
      if (existing !== undefined && existing.workspace === input.workspace && existing.status === 'active') {
        const merged = await this.table.update(existingId, (current) => ({
          ...current,
          importance: Math.max(current.importance, input.importance ?? 5),
          source: {
            ...current.source,
            eventSeqs: unionSeqs(current.source.eventSeqs, input.source.eventSeqs),
            // 摘录取新来源：反映最新一次表述所在的原文上下文
            excerpt: input.source.excerpt,
          },
          updatedAt: this.iso(),
          audit: [
            ...current.audit,
            {
              action: 'merge' as const,
              at: this.iso(),
              by: input.by,
              detail: `合并来源会话 ${input.source.sessionId}`,
            },
          ],
        }))
        this.revisionValue++
        return { entry: merged, outcome: { merged: true, existingId } }
      }
    }

    const nowIso = this.iso()
    const newId = newMemoryId()
    // 候选扫描（新建路径）：标记被本次新表述覆盖的旧条目（可多条，一条新事实推翻多条旧表述）
    const supersededTargets = this.findSupersededTargets(input, nowIso)
    const entry: MemoryEntry = {
      id: newId,
      workspace: input.workspace,
      sessionId: input.sessionId,
      kind: input.kind,
      content: input.content,
      importance: input.importance ?? 5,
      tags: input.tags ?? [],
      source: input.source,
      dedupKey,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastAccessAt: nowIso,
      accessCount: 0,
      status: 'active',
      // 覆盖了多条时取最早创建者作为直接覆盖引用（单字段，只指向最根基的一条）
      supersedes: supersededTargets.length > 0 ? supersededTargets[0]!.id : undefined,
      audit: [{ action: 'create', at: nowIso, by: input.by }],
    }
    await this.table.put(entry.id, entry)
    this.revisionValue++
    this.byDedupKey.set(indexKey, entry.id)
    // 已落库后再回写旧条目（避免未持久化的新条目被误判为候选）
    for (const target of supersededTargets) {
      await this.markSuperseded(target.id, entry.id, input.by)
    }
    return { entry, outcome: { merged: false } }
  }

  /**
   * 扫描被本次新建表述覆盖的旧条目（D-A 后向引用候选）。
   * 条件：同 workspace 同 kind、active、tokenize 集合 Jaccard 重合度 ≥ 0.7、创建不晚于新条目。
   * 返回按创建时间升序（同刻按 id 升序）排列的命中列表，供 supersedes 引用与逐条标记。
   */
  private findSupersededTargets(input: NewMemoryInput, nowIso: string): MemoryEntry[] {
    const matched: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (entry.workspace !== input.workspace) continue
      if (entry.kind !== input.kind) continue
      if (entry.status !== 'active') continue
      // “创建不晚于新条目”：新建条目的 createdAt=now，所有既有条目皆早于或同时，恒真；
      // 保留该判断以显式表达「只覆盖先于/同时存在的事实」语义（并发同刻创建时亦覆盖更早落库者）。
      if (entry.createdAt > nowIso) continue
      if (jaccardTokenSimilarity(entry.content, input.content) < JACCARD_SIMILARITY_THRESHOLD) continue
      matched.push(entry)
    }
    matched.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return matched
  }

  /** 标记某旧条目被新条目覆盖：追加 supersede 审计（status 不变，仍 active，仅检索隐藏） */
  private async markSuperseded(targetId: string, newId: string, by: AuditActor): Promise<void> {
    await this.table.update(targetId, (current) => ({
      ...current,
      supersededBy: newId,
      updatedAt: this.iso(),
      audit: [...current.audit, { action: 'supersede' as const, at: this.iso(), by, detail: `被记忆 #${newId} 覆盖` }],
    }))
    this.revisionValue++
  }

  /** 读一条（同步，内存权威态） */
  getById(id: string): MemoryEntry | undefined {
    return this.table.get(id)
  }

  /**
   * 更新条目部分字段（追加 update 审计，更新时间戳）。
   * 白名单【不含 content】（O3）：改正文必须走 create 新建条目——content 关联 dedupKey，
   * 直接改 content 会使 dedupKey 索引与正文漂移、破坏去重。
   * R2-2（B2）：只把"missing-key"（业务缺失）转换为 undefined；真实异常
   * （IO 失败、schema 校验、领域关闭）原样上抛——禁止 catch 混吞掩盖存储故障。
   */
  async update(id: string, patch: Partial<Pick<MemoryEntry, 'kind' | 'importance' | 'tags'>>, by: AuditActor): Promise<MemoryEntry | undefined> {
    try {
      const updated = await this.table.update(id, (current) => ({
        ...current,
        ...patch,
        updatedAt: this.iso(),
        audit: [...current.audit, { action: 'update' as const, at: this.iso(), by }],
      }))
      this.revisionValue++
      return updated
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') return undefined
      throw error
    }
  }

  /** 归档（软删除）：从检索结果中消失，审计与来源保留（D-D 裁决：无 restore——恢复=重建，审计可溯源） */
  async archive(id: string, by: AuditActor): Promise<boolean> {
    try {
      await this.table.update(id, (current) => ({
        ...current,
        status: 'archived' as const,
        updatedAt: this.iso(),
        audit: [...current.audit, { action: 'archive' as const, at: this.iso(), by }],
      }))
      this.revisionValue++
      return true
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') return false
      throw error
    }
  }

  /**
   * 检索（同步返回）。
   * - 有查询文本：综合评分降序（最低分过滤）；
   * - 无查询文本但有过滤条件：按创建时间倒序（工具浏览场景）；
   * - 两者皆无：空结果。
   * 默认排除被覆盖条目（D-A）；includeSuperseded 置真时可见。
   * 命中条目节流回写 lastAccessAt/accessCount（O6，60s 窗口内同会话+记忆至多落盘一次）。
   */
  search(options: SearchOptions): MemoryEntry[] {
    const query = options.query.trim()
    const limit = options.limit ?? 8
    const minScore = options.minScore ?? 0.15
    const now = this.now()

    const matches: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      // R4-1：畸形 source（手工篡改 memory.json 的伪记忆）不进检索结果——注入面最后防线
      if (!isSourceWellFormed(entry.source)) {
        this.onCorruptSource?.(entry.id)
        continue
      }
      if (options.status !== undefined) {
        if (entry.status !== options.status) continue
      } else if (entry.status !== 'active' && !(options.includeArchived && entry.status === 'archived')) {
        continue
      }
      // D-A：默认隐藏被覆盖条目，仅审计（includeSuperseded）时放行
      if (entry.supersededBy !== undefined && !(options.includeSuperseded ?? false)) continue
      if (options.kind !== undefined && entry.kind !== options.kind) continue
      if (options.tag !== undefined && !entry.tags.includes(options.tag)) continue
      if (options.workspace !== undefined && entry.workspace !== options.workspace) continue
      matches.push(entry)
    }

    let top: MemoryEntry[]
    if (query === '') {
      if (options.kind === undefined && options.tag === undefined && options.status === undefined && options.workspace === undefined) {
        return [] // 无查询也无过滤：不返回无差别结果
      }
      // 相同 createdAt 按 id 稳定排序（O3 tie-breaker），整体降序
      matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      top = matches.slice(0, limit)
    } else {
      const scored: Array<{ entry: MemoryEntry; score: number }> = []
      for (const entry of matches) {
        const score = scoreEntry(entry, query, now)
        if (score >= minScore) scored.push({ entry, score })
      }
      scored.sort((a, b) => b.score - a.score)
      top = scored.slice(0, limit).map((item) => item.entry)
    }

    // 访问追踪：节流 + 异步回写，不阻塞检索调用方（注入/工具热路径）
    for (const entry of top) {
      // 每会话+每记忆 60s 窗口内仅落盘一次（O6），避免高频检索反复写盘
      const key = `${entry.sessionId}::${entry.id}`
      const last = this.lastTrackedAt.get(key)
      if (last !== undefined && now - last < ACCESS_TRACK_WINDOW_MS) continue
      this.lastTrackedAt.set(key, now)
      void this.table
        .update(entry.id, (current) => ({
          ...current,
          lastAccessAt: this.iso(),
          accessCount: current.accessCount + 1,
        }))
        .catch((error: unknown) => {
          console.warn(`[dsh-memory] 访问追踪回写失败（记忆 ${entry.id}）：`, error)
        })
    }
    return top
  }

  /** 某会话产出的全部条目（含归档与被覆盖；按创建时间升序，同刻按 id 稳定） */
  listBySession(sessionId: string): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (entry.sessionId === sessionId) result.push(entry)
    }
    result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return result
  }

  /**
   * 最近条目浏览（面板场景）：按创建时间倒序（同刻按 id 稳定），可选状态过滤。
   * 默认排除被覆盖条目（D-A），includeSuperseded 置真时可见。
   */
  listRecent(limit: number, status?: MemoryStatus, includeSuperseded = false): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      // R4-1：畸形 source 不进浏览列表（与 search 同防线）
      if (!isSourceWellFormed(entry.source)) {
        this.onCorruptSource?.(entry.id)
        continue
      }
      if (status !== undefined && entry.status !== status) continue
      if (entry.supersededBy !== undefined && !includeSuperseded) continue
      result.push(entry)
    }
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    return result.slice(0, limit)
  }

  /**
   * 按重要度取条目（稳定快照取数）：同 workspace、active、未覆盖的条目按
   * importance 降序（同分按创建时间倒序、同刻按 id 稳定）。与 listRecent
   * （最近优先）不同——快照服务于"全局重要记忆稳定前缀"，必须按重要度选，
   * 否则早期高重要度项目规则会被新产生的低重要度条目挤出。
   */
  listByImportance(workspace: string, limit: number): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (!isSourceWellFormed(entry.source)) {
        this.onCorruptSource?.(entry.id)
        continue
      }
      if (entry.workspace !== workspace) continue
      if (entry.status !== 'active') continue
      if (entry.supersededBy !== undefined) continue
      result.push(entry)
    }
    result.sort(
      (a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
    return result.slice(0, limit)
  }

  /** 统计快照（deleted 已随 D-D 裁决移除——物理删除不留状态，无 deleted 计数） */
  stats(): MemoryStats {
    const byKind: Record<MemoryKind, number> = { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 }
    let active = 0
    let archived = 0
    let total = 0
    for (const [, entry] of this.table.entries()) {
      total++
      byKind[entry.kind]++
      if (entry.status === 'active') active++
      else archived++
    }
    return { total, active, archived, byKind }
  }
}

/** 事件序号并集（保持升序去重） */
function unionSeqs(a: number[], b: number[]): number[] {
  const set = new Set<number>([...a, ...b])
  return [...set].sort((x, y) => x - y)
}

/** 去重索引键：`workspace::kind::dedupKey`，将合并粒度提升到「workspace + kind + 内容」（O3） */
function dedupIndexKey(workspace: string, kind: MemoryKind, dedupKey: string): string {
  return `${workspace}::${kind}::${dedupKey}`
}

/**
 * 两段文本的 token 集合 Jaccard 重合度（交集大小 / 并集大小，范围 0..1）。
 * 用于 D-A 后向引用：重合度越高越可能是同一表述的不同版本。
 */
function jaccardTokenSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}
