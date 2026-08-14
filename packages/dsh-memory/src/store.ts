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

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import { scoreEntry } from './scoring.js'
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
}

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
 * MemoryStore：依赖一个 entries 表句柄。
 * 表句柄来自 `Domain.table('entries')`（装配处）或测试假表。
 */
export class MemoryStore {
  private readonly table: KvTable<string, MemoryEntry>
  private readonly now: NowFn
  /** dedupKey → id 进程内索引（构造时从表重建） */
  private readonly byDedupKey = new Map<string, string>()

  constructor(table: KvTable<string, MemoryEntry>, now: NowFn = () => Date.now()) {
    this.table = table
    this.now = now
    for (const [, entry] of table.entries()) {
      this.byDedupKey.set(entry.dedupKey, entry.id)
    }
  }

  /** 当前时刻 ISO 字符串 */
  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /**
   * 新建或去重合并一条记忆。
   * 同 workspace 且 dedupKey 相同时：合并来源事件序号、importance 取更大者、
   * 追加 merge 审计，保留既有内容与 id。
   */
  async create(input: NewMemoryInput): Promise<{ entry: MemoryEntry; outcome: MergeOutcome }> {
    const dedupKey = dedupKeyOf(input.content)
    const existingId = this.byDedupKey.get(dedupKey)
    if (existingId !== undefined) {
      const existing = this.table.get(existingId)
      if (existing !== undefined && existing.workspace === input.workspace) {
        const merged = await this.table.update(existingId, (current) => ({
          ...current,
          importance: Math.max(current.importance, input.importance ?? 5),
          source: {
            ...current.source,
            eventSeqs: unionSeqs(current.source.eventSeqs, input.source.eventSeqs),
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
        return { entry: merged, outcome: { merged: true, existingId } }
      }
    }

    const nowIso = this.iso()
    const entry: MemoryEntry = {
      id: newMemoryId(),
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
      audit: [{ action: 'create', at: nowIso, by: input.by }],
    }
    await this.table.put(entry.id, entry)
    this.byDedupKey.set(dedupKey, entry.id)
    return { entry, outcome: { merged: false } }
  }

  /** 读一条（同步，内存权威态） */
  getById(id: string): MemoryEntry | undefined {
    return this.table.get(id)
  }

  /** 更新条目部分字段（追加 update 审计，更新时间戳） */
  async update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'kind' | 'importance' | 'tags'>>, by: AuditActor): Promise<MemoryEntry | undefined> {
    try {
      return await this.table.update(id, (current) => ({
        ...current,
        ...patch,
        updatedAt: this.iso(),
        audit: [...current.audit, { action: 'update' as const, at: this.iso(), by }],
      }))
    } catch {
      return undefined // missing-key：不存在则返回 undefined（由调用方决定是否告警）
    }
  }

  /** 归档（软删除）：从检索结果中消失，审计与来源保留 */
  async archive(id: string, by: AuditActor): Promise<boolean> {
    try {
      await this.table.update(id, (current) => ({
        ...current,
        status: 'archived' as const,
        updatedAt: this.iso(),
        audit: [...current.audit, { action: 'archive' as const, at: this.iso(), by }],
      }))
      return true
    } catch {
      return false
    }
  }

  /** 恢复归档 */
  async restore(id: string, by: AuditActor): Promise<boolean> {
    try {
      await this.table.update(id, (current) => ({
        ...current,
        status: 'active' as const,
        updatedAt: this.iso(),
        audit: [...current.audit, { action: 'restore' as const, at: this.iso(), by }],
      }))
      return true
    } catch {
      return false
    }
  }

  /** 物理删除（保留审计语义由调用方保证：先 archive 再 delete 的流程在工具层约束） */
  async hardDelete(id: string, by: AuditActor): Promise<boolean> {
    const entry = this.table.get(id)
    if (entry === undefined) return false
    // 删除前写入最终审计（领域写链保证顺序：update 完成后 delete）
    await this.table.update(id, (current) => ({
      ...current,
      audit: [...current.audit, { action: 'delete' as const, at: this.iso(), by }],
    }))
    const removed = await this.table.delete(id)
    if (removed) this.byDedupKey.delete(entry.dedupKey)
    return removed
  }

  /**
   * 检索（同步返回）。
   * - 有查询文本：综合评分降序（最低分过滤）；
   * - 无查询文本但有过滤条件：按创建时间倒序（工具浏览场景）；
   * - 两者皆无：空结果。
   * 命中条目异步回写 lastAccessAt/accessCount（尽力而为，失败仅告警）。
   */
  search(options: SearchOptions): MemoryEntry[] {
    const query = options.query.trim()
    const limit = options.limit ?? 8
    const minScore = options.minScore ?? 0.15
    const now = this.now()

    const matches: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (options.status !== undefined) {
        if (entry.status !== options.status) continue
      } else if (entry.status !== 'active' && !(options.includeArchived && entry.status === 'archived')) {
        continue
      }
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
      matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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

    // 访问追踪：异步回写，不阻塞检索调用方（注入/工具热路径）
    for (const entry of top) {
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

  /** 某会话产出的全部条目（含归档；按创建时间升序） */
  listBySession(sessionId: string): MemoryEntry[] {
    const result: MemoryEntry[] = []
    for (const [, entry] of this.table.entries()) {
      if (entry.sessionId === sessionId) result.push(entry)
    }
    result.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return result
  }

  /** 统计快照 */
  stats(): MemoryStats {
    const byKind: Record<MemoryKind, number> = { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 }
    let active = 0
    let archived = 0
    let deleted = 0
    let total = 0
    for (const [, entry] of this.table.entries()) {
      total++
      byKind[entry.kind]++
      if (entry.status === 'active') active++
      else if (entry.status === 'archived') archived++
      else deleted++
    }
    return { total, active, archived, deleted, byKind }
  }
}

/** 事件序号并集（保持升序去重） */
function unionSeqs(a: number[], b: number[]): number[] {
  const set = new Set<number>([...a, ...b])
  return [...set].sort((x, y) => x - y)
}
