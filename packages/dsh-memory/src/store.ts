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

import { cosine } from './embedding.js'
import { idfWeightedRelevance, relevanceScore, rrfScore, timeImportanceFactor, tokenize } from './scoring.js'
import {
  dedupKeyOf,
  newMemoryId,
  normalizeContent,
  type AuditActor,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStats,
  type MemoryStatus,
  type NewMemoryInput,
} from './types.js'
import { EXTRACTOR_IMPORTANCE_FLOOR, EXTRACTOR_MIN_TOKENS } from './constants.js'

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
  /**
   * 语义融合检索（P4，可选）：提供查询向量与条目向量查找时，评分切换为
   * `RRF(关键词榜, 语义榜) × 时间 × 重要性`（B1：排名融合，免疫两路分数尺度
   * 差异）——关键词零重合但语义相关的条目可单榜上榜被召回。
   * 任一项缺失则退回纯关键词路径。
   */
  queryEmbedding?: ArrayLike<number>
  /** P1（2026-08-16 三档注入）：置真时返回带综合分的条目（`{ entry, score }[]`）——
   * 注入器需要按分数分档（≥0.7 全量 / 0.4-0.7 摘要 / <0.4 跳过） */
  withScore?: boolean
  /** 条目向量查找（id → 384 维向量；undefined = 尚无嵌入，该条目只用关键词分） */
  lookupEmbedding?: (id: string) => number[] | undefined
  /**
   * 语义榜来源（甲方案，2026-08-17 用户拍板 sqlite-vec）：注入的 KNN 排名器
   * （vec0 虚拟表 top-k，cosine 降序）——替代老的全量内存余弦榜。提供时语义榜
   * = 该排名器返回的 top-k（k 由 store 按榜单宽度派生）；缺省走
   * queryEmbedding+lookupEmbedding 全量路径（兼容既有调用/测试）。
   */
  semanticRank?: (queryEmbedding: ArrayLike<number>, k: number) => Array<{ id: string; cosine: number }>
}

/**
 * D-A 后向引用判定阈值：新记忆与候选旧记忆的 token 集合 Jaccard 重合度 ≥ 该值且创建于其后，
 * 则视为「新表述覆盖旧表述」，将旧条目标记 supersededBy。
 */
const JACCARD_SIMILARITY_THRESHOLD = 0.7

/**
 * F4 supersede 时间窗口（毫秒）：30 天。
 * 新表述只在窗口内覆盖同主题旧记忆；超过窗口的旧表述——即便 Jaccard≥0.7——
 * 也不再被自动覆盖。依据：时间跨度大的同主题记忆可能是不同阶段产生的
 * 独立事实（旧的未必"错"），自动覆盖会误删历史脉络；仅 30 天内的高重合
 * 微调才视为对同一事实的更新（supersede / D-A 前向引用只作用于近期表述）。
 */
const SUPERSEDE_WINDOW_MS = 30 * 86_400_000

/**
 * 访问追踪节流窗口（毫秒）：同一「会话 + 记忆」在该窗口内最多落盘一次，
 * 避免高频检索反复回写 lastAccessAt/accessCount（O6 性能）。
 */
const ACCESS_TRACK_WINDOW_MS = 60_000

/**
 * 语义榜宽度（KNN top-k 的 k）：语义榜需要"足够宽"以覆盖 RRF 与关键词榜的
 * 有效融合区间——k 过小会漏掉语义命中的长尾。按返回条数 limit 放大（×8），
 * 下限 50（检索 limit=5 时仍取 50 名——榜首融合区间不受限）。
 */
function semanticTopK(limit: number | undefined): number {
  return Math.max((limit ?? 50) * 8, 50)
}

/** 创建时去重合并的合并结果描述（供审计 detail 使用） */
export interface MergeOutcome {
  /** 是否发生合并（false 表示新建） */
  merged: boolean
  /** 命中的既有条目 id */
  existingId?: string
  /** P2 写端门：extractor 通道的输入被质量门拒绝（未落库、无审计记录）。 */
  rejected?: boolean
  /** P2 写端门拒绝原因（rejected 为 true 时存在，供观测方计数/诊断） */
  reason?: string
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
  /**
   * R1（2026-08-15 检索优化）：条目 token 集合预计算缓存（content + tags）。
   * 检索热路径每轮对全部候选重建 token Set（实测 1266-3488 个 Set、
   * 24-58ms/次）是读路径主成本；缓存后重复检索零重建。
   * 失效策略（精确，非整体清空）：
   * - update（tags 白名单可变更 → tokenize 输入变化）→ 删该 id；
   * - create 合并路径不改 content（tokenize 输入不变）→ 缓存保持有效；
   * - archive/markSuperseded 不改 content → 缓存保持有效。
   * M7（2026-08-16）：上限保护——缓存超限且未命中时整体清空重建
   * （防 10 万条规模无界内存：每条 token Set ≈ 1-1.5KB，超限清空代价
   * 一次全量重建 vs 常驻 100-150MB）。
   */
  private readonly entryTokenCache = new Map<string, Set<string>>()
  /** M7：缓存条数上限（超限未命中 → 整体清空重建） */
  private static readonly TOKEN_CACHE_MAX = 5000

  /** R1：取条目 token 集合（缓存命中返回；未命中计算并缓存） */
  private cachedTokens(entry: MemoryEntry): Set<string> {
    let tokens = this.entryTokenCache.get(entry.id)
    if (tokens === undefined) {
      if (this.entryTokenCache.size >= MemoryStore.TOKEN_CACHE_MAX) {
        // M7：超限清空（下次检索全量重建；防止随库增长无界常驻）
        this.entryTokenCache.clear()
      }
      tokens = new Set(tokenize(`${entry.content} ${entry.tags.join(' ')}`))
      this.entryTokenCache.set(entry.id, tokens)
    }
    return tokens
  }

  constructor(
    table: KvTable<string, MemoryEntry>,
    now: NowFn = () => Date.now(),
    /** R4-1：畸形 source 条目被检索过滤时的告警回调（装配层注入 logger；无回调则静默过滤） */
    private readonly onCorruptSource?: (id: string) => void,
    /** P4：嵌入索引联动钩子（onCreate 新建成功后触发、onArchive 归档后触发、onSupersede 被覆盖标记后触发；fire-and-forget 由调用方负责） */
    private readonly hooks?: { onCreate?: (entry: MemoryEntry) => void; onArchive?: (id: string) => void; onSupersede?: (targetId: string) => void },
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
    // P2 写端门（Selective Memory arXiv:2603.15994：写时质量门结构性优于读时过滤）。
    // 只拦 extractor 通道（LLM 提取）的明显噪声——它是唯一可能产生噪声的写入通道；
    // note/tool、snapshot/system 等显式意图通道不设门。被拒不抛错（提取失败不应
    // 中断提取链路），由 outcome.rejected 向调用方暴露。被拒不是记忆生命周期事件：
    // 不落库、不建去重索引、不写审计、不递增 revision——观测仅来自该 outcome 标记。
    if (input.by === 'extractor') {
      const importance = input.importance ?? 5
      if (importance < EXTRACTOR_IMPORTANCE_FLOOR) {
        return this.rejectedOutcome(
          input,
          `写端门：零价值（importance=${importance} < ${EXTRACTOR_IMPORTANCE_FLOOR}，LLM 明确判无价值）`,
        )
      }
      if (tokenize(normalizeContent(input.content)).length < EXTRACTOR_MIN_TOKENS) {
        return this.rejectedOutcome(
          input,
          `写端门：纯噪声（规范化后 token 数 < ${EXTRACTOR_MIN_TOKENS}）`,
        )
      }
    }

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
    // P4：嵌入索引联动（新建内容已落库；合并路径内容不变不触发）
    this.hooks?.onCreate?.(entry)
    return { entry, outcome: { merged: false } }
  }

  /**
   * P2 写端门拒绝结果：返回带 `rejected: true` 的 outcome，且**不持久化**——
   * 不调 table.put、不建 byDedupKey 索引、不写 audit、不递增 revision、不触发任何
   * hooks（onCreate/onSupersede）。返回的 `entry` 仅为满足 create 返回类型契约
   * （extractor 忽略返回值；note/snapshot 为显式意图通道永不触门，不会读到该占位）；
   * 调用方必须以 outcome.rejected 为权威判定"未落库"，绝不可把该占位当作真实条目。
   */
  private rejectedOutcome(input: NewMemoryInput, reason: string): { entry: MemoryEntry; outcome: MergeOutcome } {
    // R2（2026-08-16 观测闭环）：拒绝计数（memory_status/RPC status 可观测——
    // P2 门"拦了多少/门是否生效"不再黑洞）
    this.rejectedCountValue++
    const nowIso = this.iso()
    const placeholder: MemoryEntry = {
      id: newMemoryId(),
      workspace: input.workspace,
      sessionId: input.sessionId,
      kind: input.kind,
      content: input.content,
      importance: input.importance ?? 5,
      tags: input.tags ?? [],
      source: input.source,
      dedupKey: dedupKeyOf(input.content),
      createdAt: nowIso,
      updatedAt: nowIso,
      lastAccessAt: nowIso,
      accessCount: 0,
      status: 'active',
      audit: [],
    }
    return { entry: placeholder, outcome: { merged: false, rejected: true, reason } }
  }

  /** R2：P2 写端门累计拒绝次数（计数单调不归零——memory_status 观测） */
  get rejectedCount(): number {
    return this.rejectedCountValue
  }

  private rejectedCountValue = 0

  /**
   * 扫描被本次新建表述覆盖的旧条目（D-A 后向引用候选）。
   * 条件：同 workspace 同 kind、active、tokenize 集合 Jaccard 重合度 ≥ 0.7、
   * 创建不晚于新条目、且创建时间落在 30 天窗口内（F4：超窗旧表述可能是
   * 不同阶段的独立事实，不参与自动覆盖）。
   * 返回按创建时间升序（同刻按 id 升序）排列的命中列表，供 supersedes 引用与逐条标记。
   */
  private findSupersededTargets(input: NewMemoryInput, nowIso: string): MemoryEntry[] {
    // F4 窗口下界：本次新表述创建时刻往前推 30 天；候选旧记忆必须创建于该时刻之后
    const windowFloor = Date.parse(nowIso) - SUPERSEDE_WINDOW_MS
    const matched: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (entry.workspace !== input.workspace) continue
      if (entry.kind !== input.kind) continue
      if (entry.status !== 'active') continue
      // “创建不晚于新条目”：新建条目的 createdAt=now，所有既有条目皆早于或同时，恒真；
      // 保留该判断以显式表达「只覆盖先于/同时存在的事实」语义（并发同刻创建时亦覆盖更早落库者）。
      if (entry.createdAt > nowIso) continue
      // F4：超窗旧记忆不参与 supersede 判定——时间跨度大的同主题可能是独立阶段事实
      if (Date.parse(entry.createdAt) < windowFloor) continue
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
    // P2-1：被覆盖条目已从检索隐藏，其嵌入向量不再有检索价值——联动移除，
    // 防止索引文件随 supersede 链无限增长（与 onArchive 同路径）。
    this.hooks?.onSupersede?.(targetId)
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
      // R1：tags 白名单可变更 → tokenize 输入变化 → 失效该条目 token 缓存
      this.entryTokenCache.delete(id)
      return updated
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') return undefined
      throw error
    }
  }

  /**
   * 归档（软删除）：从检索结果中消失，审计与来源保留（D-D 裁决：无 restore——
   * 恢复=重建，审计可溯源）。
   * detail 为可选依据说明（自进化/因果模块传入"为什么归档"——审计 detail 是
   * 追加式审计的可读字段；既有调用不传则与原行为完全一致，向后兼容）。
   */
  async archive(id: string, by: AuditActor, detail?: string): Promise<boolean> {
    try {
      await this.table.update(id, (current) => ({
        ...current,
        status: 'archived' as const,
        updatedAt: this.iso(),
        audit: [
          ...current.audit,
          { action: 'archive' as const, at: this.iso(), by, ...(detail !== undefined ? { detail } : {}) },
        ],
      }))
      this.revisionValue++
      // P4：嵌入索引联动（归档条目不再参与检索，移除向量防陈旧占用）
      this.hooks?.onArchive?.(id)
      return true
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') return false
      throw error
    }
  }

  /**
   * 检索（同步返回）。withScore 置真时返回 `Array<{ entry, score }>`（P1 三档
   * 注入分档用）——排序后 Top-K 保留综合分；其余语义与无分数路径完全一致
   * （含访问追踪回写）。
   * - 有查询文本：综合评分降序（最低分过滤）；
   * - 无查询文本但有过滤条件：按创建时间倒序（工具浏览场景；withScore 时分数恒 0）；
   * - 两者皆无：空结果。
   * 默认排除被覆盖条目（D-A）；includeSuperseded 置真时可见。
   * 命中条目节流回写 lastAccessAt/accessCount（O6，60s 窗口内同会话+记忆至多落盘一次）。
   */
  search(options: SearchOptions & { withScore: true }): Array<{ entry: MemoryEntry; score: number }>
  search(options: SearchOptions): MemoryEntry[]
  search(options: SearchOptions): MemoryEntry[] | Array<{ entry: MemoryEntry; score: number }> {
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
    // P1：评分数组（withScore 时与 top 同序同截取——分数与条目一一对应）
    let scored: Array<{ entry: MemoryEntry; score: number }> = []
    if (query === '') {
      if (options.kind === undefined && options.tag === undefined && options.status === undefined && options.workspace === undefined) {
        return [] // 无查询也无过滤：不返回无差别结果
      }
      // 相同 createdAt 按 id 稳定排序（O3 tie-breaker），整体降序
      matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      top = matches.slice(0, limit)
    } else {
      // P4+B1 语义融合：提供查询向量与语义榜来源时，两路排名（关键词
      // relevance / 语义 cosine）经 RRF 融合——排名融合免疫两路分数尺度差异，
      // 零重合高语义相关条目可单榜上榜（P4 意图保持）。
      const semantic =
        options.semanticRank !== undefined ||
        (options.queryEmbedding !== undefined && options.lookupEmbedding !== undefined)
      const queryTokenList = tokenize(query)
      if (semantic) {
        // 关键词榜：relevance > 0 的条目降序（同分按 id 稳定；relevance=0 不上榜）
        // R1：缓存 token 集合（entryTokenCache）替代每轮重建
        const withRel = matches.map((entry) => ({ entry, rel: relevanceScore(queryTokenList, this.cachedTokens(entry)) }))
        const kwRanked = withRel
          .filter((item) => item.rel > 0)
          .sort((a, b) => b.rel - a.rel || a.entry.id.localeCompare(b.entry.id))
        const kwRank = new Map<string, number>()
        kwRanked.forEach((item, index) => kwRank.set(item.entry.id, index + 1))
        // 语义榜：注入 KNN 排名器（sqlite-vec top-k）或全量余弦（老路径）——
        // 均按 cosine 降序（同分按 id 稳定）；无向量/负相似不占榜
        let semList: Array<{ id: string; cosine: number }>
        if (options.semanticRank !== undefined && options.queryEmbedding !== undefined) {
          // KNN 榜：vec0 返回 top-k（始终有结果——无"零匹配空"语义），
          // 过滤 cosine≤0 的负相似条目（与全量路径的 cos>0 上榜语义对齐）
          semList = options
            .semanticRank(options.queryEmbedding, semanticTopK(options.limit))
            .filter((item) => item.cosine > 0)
        } else {
          semList = matches
            .map((entry) => ({
              id: entry.id,
              cosine: (() => {
                const vector = options.lookupEmbedding?.(entry.id)
                return vector === undefined ? 0 : cosine(options.queryEmbedding!, vector)
              })(),
            }))
            .filter((item) => item.cosine > 0)
            .sort((a, b) => b.cosine - a.cosine || a.id.localeCompare(b.id))
        }
        const semRank = new Map<string, number>()
        semList.forEach((item, index) => semRank.set(item.id, index + 1))
        for (const { entry } of withRel) {
          const score = rrfScore(kwRank.get(entry.id), semRank.get(entry.id)) * timeImportanceFactor(entry, now)
          if (score >= minScore) scored.push({ entry, score })
        }
      } else {
        // 轻量 IDF 加权关键词路径（保留 0-1 标定，注入分档不受影响）：
        // 1) 先一次性统计 query tokens 在候选集（matches）中的文档频率 df——
        //    零维护（无写路径改动，检索时按候选集现算）；df=0 的 token 由 scoring
        //    侧按最大 idf 保底（只进分母，稀释弱相关）；
        // 2) 再逐条目算 idfWeightedRelevance：稀有词命中权重大于常见词，同命中
        //    数下 IDF 可区分条目——全命中仍 = 1.0、零命中 = 0、0-1 尺度保持。
        const df = new Map<string, number>()
        for (const entry of matches) {
          const tokens = this.cachedTokens(entry)
          for (const t of queryTokenList) {
            if (tokens.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
          }
        }
        for (const entry of matches) {
          // R1：缓存 token 集合替代 memoryScore 内部重复 tokenize（计算等价：
          // memoryScore = relevance × timeImportanceFactor，relevance=0 → 0 < minScore 不过）
          const score =
            idfWeightedRelevance(queryTokenList, this.cachedTokens(entry), (t) => df.get(t) ?? 0, matches.length) *
            timeImportanceFactor(entry, now)
          if (score >= minScore) scored.push({ entry, score })
        }
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
      // M7：节流表上限（只增不减的键随库增长无界——超限清空，节流失效一次无碍）
      if (this.lastTrackedAt.size >= MemoryStore.TOKEN_CACHE_MAX) {
        this.lastTrackedAt.clear()
      }
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
    // P1：withScore 返回带分条目（top 与 scored 同序同截取——分数一一对应）
    if (options.withScore === true) {
      const topScored = scored.slice(0, limit)
      return top.map((entry, index) => ({ entry, score: topScored[index]?.score ?? 0 }))
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
  /**
   * O2（2026-08-16）：条目对 token Jaccard——复用 entryTokenCache（维护合并
   * 路径原每对双方各 tokenize 一次 ≈39,800 次/批 ≈16s CPU；缓存后 O(n²)
   * 集合比较 ≈40ms）。与模块级 jaccardTokenSimilarity（supersede 扫描用）
   * 语义一致，但走缓存。
   */
  tokenJaccard(a: MemoryEntry, b: MemoryEntry): number {
    const setA = this.cachedTokens(a)
    const setB = this.cachedTokens(b)
    if (setA.size === 0 || setB.size === 0) return 0
    let intersection = 0
    for (const token of setA) {
      if (setB.has(token)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  stats(): MemoryStats {    const byKind: Record<MemoryKind, number> = { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 }
    let active = 0
    let archived = 0
    let total = 0
    for (const [, entry] of this.table.entries()) {
      total++
      byKind[entry.kind]++
      if (entry.status === 'active') active++
      else archived++
    }
    // O1：健康字段占位（store 不感知写链/嵌入/维护——装配层经 runtime 覆盖）
    // R2：P2 写端门拒绝计数由 store 自身可观测（rejectedCount getter 直读）
    return { total, active, archived, byKind, writeFailures: 0, embeddingState: 'unknown', lastMaintenanceAt: null, rejectedCount: this.rejectedCount }
  }
}

/** 事件序号并集（保持升序去重） */
function unionSeqs(a: number[], b: number[]): number[] {
  const set = new Set<number>([...a, ...b])
  return [...set].sort((x, y) => x - y)
}

/**
 * 去重索引键：`workspace::kind::dedupKey`，将合并粒度提升到「workspace + kind + 内容」（O3） */
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
