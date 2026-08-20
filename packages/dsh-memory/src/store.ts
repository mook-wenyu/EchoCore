/**
 * @module @echocore/dsh-memory/store
 *
 * MemoryStore 骨架：仅保留 byDedupKey / revision / get / update / archive 与基础列表/统计。
 * 检索（search/withScore/RRF/IDF + tokenCache）与创建（create/supersede）已分别抽至
 * `src/store/search.ts` 与 `src/store/create.ts`，本文件通过委托保持 100% 行为不变。
 *
 * 约束兑现：
 * - 每函数 <40 行、圈复杂度 <10、详细中文注释；
 * - 仅拆文件与补测试，不改行为；不碰 client/reflect/causal。
 */

import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'

import { effectiveImportance, tokenize } from './scoring.js'
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
// 检索子模块（token 缓存、过滤、IDF/RRF、访问追踪等纯函数）
import {
  filterCandidates,
  getCachedTokens,
  handleEmptyQuery,
  invalidateTokenCache,
  isSourceWellFormed,
  scoreWithIdf,
  scoreWithRrf,
  sortScored,
  trackAccess,
} from './store/search.js'
// 创建子模块（写端门、去重键、Jaccard、supersede 扫描/标记等）
import {
  buildNewEntry,
  buildRejectedPlaceholder,
  checkWriteGate,
  dedupIndexKey,
  findSupersededTargets,
  markSuperseded,
  unionSeqs,
} from './store/create.js'

// 对外重导出：保持 `import { SearchOptions, isSourceWellFormed } from '../store.js'` 可用
export type { SearchOptions } from './store/search.js'
export { isSourceWellFormed } from './store/search.js'

// 额外重导出缓存上限（供外部观测或测试）
export { TOKEN_CACHE_MAX } from './store/search.js'

/** 创建时去重合并的合并结果描述（供审计 detail 使用） */
export interface MergeOutcome {
  /** 是否发生合并（false 表示新建） */
  merged: boolean
  /** 命中的既有条目 id */
  existingId?: string
  /** P2 写端门：extractor 通道的输入被质量门拒绝（未落库、无审计记录） */
  rejected?: boolean
  /** P2 写端门拒绝原因（rejected 为 true 时存在） */
  reason?: string
}

/** 时间戳生成（集中管理，便于测试注入固定时间） */
export type NowFn = () => number

/**
 * MemoryStore：依赖一个 entries 表句柄。
 * 表句柄来自 `Domain.table('entries')`（装配处）或测试假表。
 */
export class MemoryStore {
  private readonly table: KvTable<string, MemoryEntry>
  private readonly now: NowFn
  /** 去重索引：`workspace::kind::dedupKey` → id（进程内，构造时从表重建） */
  private readonly byDedupKey = new Map<string, string>()
  /** 访问追踪节流表：`sessionId::memoryId` → 上次落盘时刻（ms） */
  private readonly lastTrackedAt = new Map<string, number>()
  /** 内容变更版本（进程内）：create/update/archive（含 supersede 回写）后递增 */
  private revisionValue = 0
  /** R1：条目 token 集合预计算缓存（content + tags），超限整体清空 */
  private readonly entryTokenCache = new Map<string, Set<string>>()
  /** R2：P2 写端门累计拒绝次数 */
  private rejectedCountValue = 0
  /** 维护游标预留（未来滚动游标分片用，当前仅占位） */
  private lastMaintenanceCursor: string | null = null

  constructor(
    table: KvTable<string, MemoryEntry>,
    now: NowFn = () => Date.now(),
    private readonly onCorruptSource?: (id: string) => void,
    private readonly hooks?: { onCreate?: (entry: MemoryEntry) => void; onArchive?: (id: string) => void; onSupersede?: (targetId: string) => void },
  ) {
    this.table = table
    this.now = now
    // 构造时重建去重索引（遍历全表）
    for (const [, entry] of table.entries()) {
      this.byDedupKey.set(dedupIndexKey(entry.workspace, entry.kind, entry.dedupKey), entry.id)
    }
  }

  /** 当前时刻 ISO 字符串（集中生成，保证同一操作内时间一致） */
  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** 当前内容变更版本（供稳定快照失效判定） */
  get revision(): number {
    return this.revisionValue
  }

  /** P2 写端门累计拒绝次数（单调不归零，供 memory_status 观测） */
  get rejectedCount(): number {
    return this.rejectedCountValue
  }

  /**
   * 取条目 token 集合（委托 search 模块的缓存助手）。
   * 未命中时计算 `tokenize(content + tags)` 并缓存；超限整体清空。
   */
  private cachedTokens(entry: MemoryEntry): Set<string> {
    // 委托 search 模块，保持行为与原 store.cachedTokens 完全一致
    return getCachedTokens(this.entryTokenCache, entry)
  }

  // ────────────────────────────────────────────────────────────────────────
  // 创建与去重合并（委托 create 子模块）
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 新建或去重合并一条记忆（骨架：编排 create 子模块的纯函数）。
   * 每分支均 <40 行：写端门、合并、扫描 supersede、新建落库、回写旧条目。
   */
  async create(input: NewMemoryInput): Promise<{ entry: MemoryEntry; outcome: MergeOutcome }> {
    // 1) 写端门：仅 extractor 通道可能被拒（纯噪声/零价值）
    const gateReason = checkWriteGate(input)
    if (gateReason !== undefined) return this.rejectedOutcome(input, gateReason)

    // 2) 去重键与索引键（含 kind 粒度，跨分类不合并）
    const dedupKey = dedupKeyOf(input.content)
    const indexKey = dedupIndexKey(input.workspace, input.kind, dedupKey)
    const existingId = this.byDedupKey.get(indexKey)

    // 3) 命中 active 同 workspace 条目 → 合并（来源并集、重要性取大、excerpt 取新）
    if (existingId !== undefined) {
      const existing = this.table.get(existingId)
      if (existing !== undefined && existing.workspace === input.workspace && existing.status === 'active') {
        return this.mergeExisting(existingId, input)
      }
    }

    // 4) 未命中 → 新建路径（含 supersede 扫描）
    return this.createNew(input, dedupKey, indexKey)
  }

  /**
   * 合并既有条目：来源序号并集、重要性取大、excerpt 取新来源。
   * 单独抽为 <40 行函数，降低 create 主流程圈复杂度。
   */
  private async mergeExisting(existingId: string, input: NewMemoryInput): Promise<{ entry: MemoryEntry; outcome: MergeOutcome }> {
    const merged = await this.table.update(existingId, (current) => ({
      ...current,
      importance: Math.max(current.importance, input.importance ?? 5),
      source: {
        ...current.source,
        eventSeqs: unionSeqs(current.source.eventSeqs, input.source.eventSeqs),
        excerpt: input.source.excerpt,
      },
      updatedAt: this.iso(),
      audit: [...current.audit, { action: 'merge' as const, at: this.iso(), by: input.by, detail: `合并来源会话 ${input.source.sessionId}` }],
    }))
    this.revisionValue++
    return { entry: merged, outcome: { merged: true, existingId } }
  }

  /**
   * 新建条目路径：扫描 supersede 候选、组装新条目、落库、回写被覆盖旧条目。
   */
  private async createNew(input: NewMemoryInput, dedupKey: string, indexKey: string): Promise<{ entry: MemoryEntry; outcome: MergeOutcome }> {
    const nowIso = this.iso()
    const newId = newMemoryId()
    // 扫描被覆盖旧条目（Jaccard≥0.7 且窗口内）
    const supersededTargets = findSupersededTargets(this.table, input, nowIso)
    // 组装新条目（纯函数）
    const entry = buildNewEntry(input, dedupKey, nowIso, newId, supersededTargets)
    await this.table.put(entry.id, entry)
    this.revisionValue++
    this.byDedupKey.set(indexKey, entry.id)
    // 已落库后再逐条回写旧条目（避免未持久化新条目被误判为候选）
    for (const target of supersededTargets) {
      await this.markSupersededInternal(target.id, entry.id, input.by)
    }
    this.hooks?.onCreate?.(entry)
    return { entry, outcome: { merged: false } }
  }

  /**
   * 被拒绝时的占位结果（不落库、不建索引、不递增 revision、不触发 hooks）。
   */
  private rejectedOutcome(input: NewMemoryInput, reason: string): { entry: MemoryEntry; outcome: MergeOutcome } {
    this.rejectedCountValue++
    const nowIso = this.iso()
    const placeholder = buildRejectedPlaceholder(input, nowIso)
    return { entry: placeholder, outcome: { merged: false, rejected: true, reason } }
  }

  /**
   * 内部 supersede 标记：委托 create 模块并递增 revision、处理钩子。
   */
  private async markSupersededInternal(targetId: string, newId: string, by: AuditActor): Promise<void> {
    await markSuperseded(this.table, targetId, newId, by, () => this.iso(), this.hooks)
    this.revisionValue++
  }

  // ────────────────────────────────────────────────────────────────────────
  // 读与更新
  // ────────────────────────────────────────────────────────────────────────

  /** 读一条（同步，内存权威态） */
  getById(id: string): MemoryEntry | undefined {
    return this.table.get(id)
  }

  /**
   * 更新条目部分字段（白名单不含 content，防 dedupKey 漂移）。
   * 仅把 missing-key 转为 undefined，其他异常原样上抛。
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
      // tags 变更会改变 tokenize 输入，需失效缓存
      if (patch.tags !== undefined) invalidateTokenCache(this.entryTokenCache, id)
      return updated
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') return undefined
      throw error
    }
  }

  /**
   * 归档（软删除）：从检索消失，审计保留；可附 detail 说明依据。
   */
  async archive(id: string, by: AuditActor, detail?: string): Promise<boolean> {
    try {
      await this.table.update(id, (current) => ({
        ...current,
        status: 'archived' as const,
        updatedAt: this.iso(),
        audit: [...current.audit, { action: 'archive' as const, at: this.iso(), by, ...(detail !== undefined ? { detail } : {}) }],
      }))
      this.revisionValue++
      this.hooks?.onArchive?.(id)
      return true
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') return false
      throw error
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 检索（委托 search 子模块，保持 100% 行为）
  // ────────────────────────────────────────────────────────────────────────

  search(options: { query: string; workspace?: string; kind?: MemoryKind; tag?: string; status?: MemoryStatus; limit?: number; minScore?: number; includeArchived?: boolean; includeSuperseded?: boolean; queryEmbedding?: ArrayLike<number>; withScore: true; lookupEmbedding?: (id: string) => number[] | undefined; semanticRank?: (q: ArrayLike<number>, k: number) => Array<{ id: string; cosine: number }> }): Array<{ entry: MemoryEntry; score: number }>
  search(options: { query: string; workspace?: string; kind?: MemoryKind; tag?: string; status?: MemoryStatus; limit?: number; minScore?: number; includeArchived?: boolean; includeSuperseded?: boolean; queryEmbedding?: ArrayLike<number>; withScore?: boolean; lookupEmbedding?: (id: string) => number[] | undefined; semanticRank?: (q: ArrayLike<number>, k: number) => Array<{ id: string; cosine: number }> }): MemoryEntry[]
  search(options: import('./store/search.js').SearchOptions): MemoryEntry[] | Array<{ entry: MemoryEntry; score: number }> {
    const query = options.query.trim()
    const limit = options.limit ?? 8
    const minScore = options.minScore ?? 0.15
    const now = this.now()
    // 1) 候选过滤（委托 search 模块）
    const matches = filterCandidates(this.table, options, this.onCorruptSource)
    // 2) 空查询分支（有过滤→倒序，无过滤→空）
    if (query === '') return this.handleEmptySearch(matches, options, limit)
    // 3) 有查询：评分→排序→截取→访问追踪→withScore 分流
    const queryTokens = tokenize(query)
    const scored = this.scoreMatches(matches, queryTokens, now, options, minScore)
    sortScored(scored)
    const top = scored.slice(0, limit).map((item) => item.entry)
    trackAccess(top, { table: this.table, lastTrackedAt: this.lastTrackedAt, now, iso: () => this.iso() })
    if (options.withScore === true) {
      const topScored = scored.slice(0, limit)
      return top.map((entry, i) => ({ entry, score: topScored[i]?.score ?? 0 }))
    }
    return top
  }

  /** 空查询搜索：委托 handleEmptyQuery 并处理 withScore 分流 */
  private handleEmptySearch(matches: MemoryEntry[], options: import('./store/search.js').SearchOptions, limit: number): MemoryEntry[] | Array<{ entry: MemoryEntry; score: number }> {
    const top = handleEmptyQuery(matches, options, limit)
    if (options.withScore === true) return top.map((entry) => ({ entry, score: 0 }))
    return top
  }

  /** 有查询评分：按是否语义分流（IDF vs RRF），每分支 <40 行 */
  private scoreMatches(
    matches: MemoryEntry[],
    queryTokens: string[],
    now: number,
    options: import('./store/search.js').SearchOptions,
    minScore: number,
  ): Array<{ entry: MemoryEntry; score: number }> {
    const useSemantic =
      options.semanticRank !== undefined || (options.queryEmbedding !== undefined && options.lookupEmbedding !== undefined)
    if (useSemantic) {
      return scoreWithRrf(matches, queryTokens, this.entryTokenCache, now, options, options.limit, minScore)
    }
    return scoreWithIdf(matches, queryTokens, this.entryTokenCache, now, minScore)
  }

  // ────────────────────────────────────────────────────────────────────────
  // 列表与统计（保留在骨架，逻辑简单）
  // ────────────────────────────────────────────────────────────────────────

  /** 某会话产出的全部条目（含归档与被覆盖；按创建时间升序） */
  listBySession(sessionId: string): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (entry.sessionId === sessionId) result.push(entry)
    }
    result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return result
  }

  /** 最近条目浏览（按创建时间倒序，可选状态过滤，默认排除被覆盖） */
  listRecent(limit: number, status?: MemoryStatus, includeSuperseded = false): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
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

  /** 按重要度取条目（稳定快照取数）：同 workspace、active、未覆盖按有效重要度降序 */
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
      (a, b) =>
        effectiveImportance(b.importance, b.accessCount, b.selfRelevance ?? 0) -
          effectiveImportance(a.importance, a.accessCount, a.selfRelevance ?? 0) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    return result.slice(0, limit)
  }

  /** 条目对 token Jaccard（复用缓存，O(n²) 集合比较） */
  tokenJaccard(a: MemoryEntry, b: MemoryEntry): number {
    const setA = this.cachedTokens(a)
    const setB = this.cachedTokens(b)
    if (setA.size === 0 || setB.size === 0) return 0
    let inter = 0
    for (const token of setA) if (setB.has(token)) inter++
    const union = setA.size + setB.size - inter
    return union === 0 ? 0 : inter / union
  }

  /** 统计快照（按 kind 与状态计数，健康字段占位） */
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
    return { total, active, archived, byKind, writeFailures: 0, embeddingState: 'unknown', lastMaintenanceAt: null, rejectedCount: this.rejectedCount }
  }
}
