/**
 * @module @echocore/dsh-memory/store/create
 *
 * 创建与覆盖子模块：从 God Class store.ts 抽离 create/rejectedOutcome/findSupersededTargets/markSuperseded。
 * 保持 100% 行为不变，仅拆文件并细化函数（每函数 <40 行、圈复杂度 <10，详细中文注释）。
 *
 * 职责：
 * - 写端门校验（P2 Selective Memory：写时质量门结构性优于读时过滤）。
 * - 去重合并判定与占位构造。
 * - D-A 后向引用：Jaccard≥0.7 且 30 天窗口内标记被覆盖条目。
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import { EXTRACTOR_IMPORTANCE_FLOOR, EXTRACTOR_MIN_TOKENS } from '../constants.js'
import { jaccard, tokenize } from '../scoring.js'
import { dedupKeyOf, newMemoryId, normalizeContent, type AuditActor, type MemoryEntry, type MemoryKind, type NewMemoryInput } from '../types.js'

// ──────────────────────────────────────────────────────────────────────────────
// 常量与基础工具
// ──────────────────────────────────────────────────────────────────────────────

/**
 * D-A 后向引用判定阈值：新旧记忆 token 集合 Jaccard ≥ 该值且创建于其后视为覆盖。
 */
export const JACCARD_SIMILARITY_THRESHOLD = 0.7

/**
 * F4 supersede 时间窗口（毫秒）：30 天。
 * 超窗旧表述可能是不同阶段的独立事实，不应被自动覆盖（防误删历史脉络）。
 */
export const SUPERSEDE_WINDOW_MS = 30 * 86_400_000

/**
 * 去重索引键：`workspace::kind::dedupKey`（粒度含 kind 与 workspace，跨分类/跨项目不合并）。
 */
export function dedupIndexKey(workspace: string, kind: MemoryKind, dedupKey: string): string {
  return `${workspace}::${kind}::${dedupKey}`
}

/**
 * 事件序号并集：升序去重（用于合并路径来源事件序号）。
 */
export function unionSeqs(a: number[], b: number[]): number[] {
  const set = new Set<number>([...a, ...b])
  return [...set].sort((x, y) => x - y)
}

/**
 * 两段文本的 token 集合 Jaccard 重合度（0..1）。
 * 用于 D-A 后向引用：重合度越高越可能是同一表述的不同版本。
 * 复用 scoring.jaccard 纯函数，仅负责 tokenize + 委托。
 */
export function jaccardTokenSimilarity(a: string, b: string): number {
  return jaccard(new Set(tokenize(a)), new Set(tokenize(b)))
}

// ──────────────────────────────────────────────────────────────────────────────
// 写端门与占位
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 写端门校验（仅 extractor 通道）：LLM 提取是唯一可能产生噪声的写入通道。
 * 返回拒绝原因（字符串）或 undefined（通过）。纯函数，无副作用。
 */
export function checkWriteGate(input: NewMemoryInput): string | undefined {
  // 仅拦截 extractor 通道，其他显式意图（tool/user/system）不设门
  if (input.by !== 'extractor') return undefined
  const importance = input.importance ?? 5
  // 零价值：LLM 明确判无价值（importance < 阈值）
  if (importance < EXTRACTOR_IMPORTANCE_FLOOR) {
    return `写端门：零价值（importance=${importance} < ${EXTRACTOR_IMPORTANCE_FLOOR}，LLM 明确判无价值）`
  }
  // 纯噪声：规范化后 token 数过少（空串/纯标点/单字）
  if (tokenize(normalizeContent(input.content)).length < EXTRACTOR_MIN_TOKENS) {
    return `写端门：纯噪声（规范化后 token 数 < ${EXTRACTOR_MIN_TOKENS}）`
  }
  return undefined
}

/**
 * 构建被拒绝时的占位条目（满足 create 返回类型契约，但调用方必须以 outcome.rejected 为权威）。
 * 占位不落库、不建索引、不写审计、不递增 revision，hooks 也不触发。
 */
export function buildRejectedPlaceholder(input: NewMemoryInput, nowIso: string): MemoryEntry {
  // 占位 id 仍用真实生成（满足类型契约），但永不持久化
  return {
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
}

// ──────────────────────────────────────────────────────────────────────────────
// supersede 扫描与标记
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 扫描被本次新建表述覆盖的旧条目（D-A 后向引用候选）。
 * 条件：同 workspace 同 kind、active、Jaccard≥0.7、创建不晚于新条目、且在 30 天窗口内。
 * 返回按创建时间升序（同刻按 id 升序）排列的命中列表。
 */
export function findSupersededTargets(
  table: KvTable<string, MemoryEntry>,
  input: NewMemoryInput,
  nowIso: string,
): MemoryEntry[] {
  // 窗口下界：本次新表述创建时刻往前 30 天；超窗旧记忆不参与覆盖
  const windowFloor = Date.parse(nowIso) - SUPERSEDE_WINDOW_MS
  const matched: MemoryEntry[] = []
  for (const [, entry] of table.entries()) {
    if (entry.workspace !== input.workspace) continue
    if (entry.kind !== input.kind) continue
    if (entry.status !== 'active') continue
    // 显式语义：只覆盖先于/同时存在的事实（并发同刻亦覆盖更早落库者）
    if (entry.createdAt > nowIso) continue
    if (Date.parse(entry.createdAt) < windowFloor) continue
    if (jaccardTokenSimilarity(entry.content, input.content) < JACCARD_SIMILARITY_THRESHOLD) continue
    matched.push(entry)
  }
  // 稳定排序：创建时间升序，同刻按 id
  matched.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return matched
}

/**
 * 标记某旧条目被新条目覆盖：追加 supersede 审计，触发 onSupersede 钩子。
 * 调用方负责 revision 递增与错误处理（与原 markSuperseded 行为一致）。
 */
export async function markSuperseded(
  table: KvTable<string, MemoryEntry>,
  targetId: string,
  newId: string,
  by: AuditActor,
  iso: () => string,
  hooks?: { onSupersede?: (targetId: string) => void },
): Promise<void> {
  // 回写旧条目：supersededBy 指向新 id，追加审计
  await table.update(targetId, (current) => ({
    ...current,
    supersededBy: newId,
    updatedAt: iso(),
    audit: [...current.audit, { action: 'supersede' as const, at: iso(), by, detail: `被记忆 #${newId} 覆盖` }],
  }))
  // 嵌入向量联动清理（被覆盖条目不再参与检索，防索引无限增长）
  hooks?.onSupersede?.(targetId)
}

/**
 * 构建新条目（新建路径，非合并）：填充 id、时间戳、审计、supersedes 引用等。
 * 纯函数，不触 table，仅组装对象。
 */
export function buildNewEntry(
  input: NewMemoryInput,
  dedupKey: string,
  nowIso: string,
  newId: string,
  supersededTargets: MemoryEntry[],
): MemoryEntry {
  // supersedes 取最早创建者（单字段，只指向最根基的一条）
  const supersedes = supersededTargets.length > 0 ? supersededTargets[0]!.id : undefined
  return {
    id: newId,
    workspace: input.workspace,
    sessionId: input.sessionId,
    kind: input.kind,
    content: input.content,
    importance: input.importance ?? 5,
    selfRelevance: input.selfRelevance,
    tags: input.tags ?? [],
    source: input.source,
    dedupKey,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastAccessAt: nowIso,
    accessCount: 0,
    status: 'active',
    supersedes,
    audit: [{ action: 'create', at: nowIso, by: input.by }],
  }
}
