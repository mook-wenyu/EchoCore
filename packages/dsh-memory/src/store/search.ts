/**
 * @module @echocore/dsh-memory/store/search
 *
 * 检索与评分子模块：从 God Class store.ts 抽离的 search/withScore/RRF/IDF + tokenCache 职责。
 * 保持 100% 行为不变，仅拆文件并细化函数（每函数 <40 行、圈复杂度 <10）。
 *
 * 设计：
 * - Token 缓存：进程内 Map<id, Set<string>>，命中复用、超限整体清空（M7）。
 * - 候选过滤、IDF 加权、RRF 融合、访问追踪均拆为独立小函数，主流程仅编排。
 * - 本模块为纯函数集合（除缓存 Map 与访问节流 Map 需外部传入），不持有 MemoryStore 私有态，
 *   由 store.ts 传入 table/cache/lastTrackedAt 等可变容器，保持单向依赖（store→search）。
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import { cosine } from '../embedding.js'
import { idfWeightedRelevance, MIN_RELEVANCE_SCORE, relevanceScore, rrfScore, timeImportanceFactor, tokenize } from '../scoring.js'
import type { MemoryEntry, MemoryKind, MemoryStatus } from '../types.js'

// ──────────────────────────────────────────────────────────────────────────────
// 类型与常量
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 检索选项（与原 store.ts:SearchOptions 完全一致，抽至此文件以避免 store↔search 循环依赖）。
 * store.ts 将重导出本类型，保证 `import { SearchOptions } from '../store.js'` 仍可用。
 */
export interface SearchOptions {
  /** 查询文本（空串时若存在过滤条件则按创建时间倒序返回，否则空结果） */
  query: string
  /** workspace 过滤 */
  workspace?: string
  /** 分类过滤 */
  kind?: MemoryKind
  /** 标签过滤（命中任一标签） */
  tag?: string
  /** 状态过滤（缺省仅 active，除非 includeArchived） */
  status?: MemoryStatus
  /** 返回条数上限 */
  limit?: number
  /** 最低综合分（默认 0.15；仅在有查询文本时生效） */
  minScore?: number
  /** 是否包含归档条目（默认否；与 status 互斥时以 status 为准） */
  includeArchived?: boolean
  /** 是否包含被覆盖条目（默认否） */
  includeSuperseded?: boolean
  /** 查询向量（语义融合检索，可选） */
  queryEmbedding?: ArrayLike<number>
  /** 是否返回带分数条目 */
  withScore?: boolean
  /** 条目向量查找（id → 向量；缺省走 semanticRank） */
  lookupEmbedding?: (id: string) => number[] | undefined
  /** 语义榜来源（sqlite-vec KNN 排名器） */
  semanticRank?: (queryEmbedding: ArrayLike<number>, k: number) => Array<{ id: string; cosine: number }>
}

/** 访问追踪节流窗口（毫秒）：60s 内同会话+记忆至多落盘一次（O6） */
export const ACCESS_TRACK_WINDOW_MS = 60_000

/** 语义榜缓存上限（与原 TOKEN_CACHE_MAX 共用阈值，防无界增长）与超限清空策略 M7 */
export const TOKEN_CACHE_MAX = 5000

// ──────────────────────────────────────────────────────────────────────────────
// 基础工具：语义榜宽度、Token 缓存、来源校验
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 语义榜宽度（KNN top-k 的 k）：按返回条数 limit 放大×8，下限 50。
 * 保证语义榜足够宽以覆盖 RRF 有效融合区间（检索 limit=5 时仍取 50 名）。
 */
export function semanticTopK(limit: number | undefined): number {
  // 放大因子 8 与下限 50 来自原 store.ts:100-102，保持数值不变
  return Math.max((limit ?? 50) * 8, 50)
}

/**
 * source 锚点完整性校验（R4-1 读路径防篡改）。
 * 仅校验字段存在与类型，内容格式宽容，避免误伤合法旧数据。
 */
export function isSourceWellFormed(source: unknown): source is { sessionId: string; eventSeqs: number[]; excerpt: string } {
  // 严格空与类型守卫，满足“字段存在且类型正确”即可放行
  if (typeof source !== 'object' || source === null) return false
  const r = source as Record<string, unknown>
  return (
    typeof r.sessionId === 'string' &&
    r.sessionId !== '' &&
    Array.isArray(r.eventSeqs) &&
    r.eventSeqs.every((n) => typeof n === 'number') &&
    typeof r.excerpt === 'string'
  )
}

/**
 * 超限淘汰最旧 1/4（P1 缓存命中优化，2026-08-20 用户拍板）：
 * 旧策略整体清空在库规模（~8882 条）超过上限（5000）时使缓存命中率归零——
 * 每轮检索/维护都对全量条目重切 jieba（同步 CPU 浪费）。改为按 Map 插入序
 * （即最旧优先）淘汰 ⌈MAX/4⌉ 条，保留 75% 热条目，摊销重建成本且上界不变。
 */
function evictOldestQuarter(cache: Map<string, Set<string>>): void {
  const evictCount = Math.ceil(TOKEN_CACHE_MAX / 4)
  let removed = 0
  for (const key of cache.keys()) {
    cache.delete(key)
    if (++removed >= evictCount) break
  }
}

/**
 * 取条目 token 集合（缓存命中直接返回；未命中则计算并缓存）。
 * 超限（≥ TOKEN_CACHE_MAX）时淘汰最旧 1/4（见 evictOldestQuarter），防无界常驻。
 */
export function getCachedTokens(cache: Map<string, Set<string>>, entry: MemoryEntry): Set<string> {
  // 先查缓存，命中即返回零重建
  let tokens = cache.get(entry.id)
  if (tokens !== undefined) return tokens
  // 未命中且超限：淘汰最旧四分位（保留热条目，非整体清空）
  if (cache.size >= TOKEN_CACHE_MAX) evictOldestQuarter(cache)
  // 计算：content + tags 拼接后分词（与原 cachedTokens 等价）
  tokens = new Set(tokenize(`${entry.content} ${entry.tags.join(' ')}`))
  cache.set(entry.id, tokens)
  return tokens
}

/**
 * 失效指定条目的 token 缓存（update tags 后调用，因 tag 参与分词输入）。
 */
export function invalidateTokenCache(cache: Map<string, Set<string>>, id: string): void {
  // 仅删该 id，细粒度失效（create 合并/archive/markSuperseded 不改 content，无需失效）
  cache.delete(id)
}

// ──────────────────────────────────────────────────────────────────────────────
// 候选过滤
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 过滤候选条目：按状态/覆盖/类型/标签/workspace/source 完整性过滤。
 * 与原 search 的前半段过滤完全一致，抽为独立函数以降低圈复杂度。
 */
export function filterCandidates(
  table: KvTable<string, MemoryEntry>,
  options: SearchOptions,
  onCorrupt?: (id: string) => void,
): MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const [, entry] of table.entries()) {
    // 畸形 source 直接过滤并告警（注入面最后防线，getById 仍放行审计）
    if (!isSourceWellFormed(entry.source)) {
      onCorrupt?.(entry.id)
      continue
    }
    // 状态过滤：显式 status 优先，否则仅 active（includeArchived 放行归档）
    if (options.status !== undefined) {
      if (entry.status !== options.status) continue
    } else if (entry.status !== 'active' && !(options.includeArchived && entry.status === 'archived')) {
      continue
    }
    // 默认隐藏被覆盖条目（D-A），仅审计时放行
    if (entry.supersededBy !== undefined && !(options.includeSuperseded ?? false)) continue
    if (options.kind !== undefined && entry.kind !== options.kind) continue
    if (options.tag !== undefined && !entry.tags.includes(options.tag)) continue
    if (options.workspace !== undefined && entry.workspace !== options.workspace) continue
    out.push(entry)
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────────
// IDF / RRF 评分
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 构建 IDF 文档频率表：统计 queryTokens 在候选集中的 df（每 token 出现的条目数）。
 * 零维护设计：检索时按候选集现算，df=0 的 token 在 scoring 侧按最大 idf 保底。
 */
export function buildDfMap(
  matches: MemoryEntry[],
  queryTokens: string[],
  cache: Map<string, Set<string>>,
): Map<string, number> {
  const df = new Map<string, number>()
  for (const entry of matches) {
    const tokens = getCachedTokens(cache, entry)
    for (const t of queryTokens) {
      if (tokens.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  return df
}

/**
 * 带分检索行（Q1=A 解耦，2026-08-20 用户拍板）：
 * - relevance：**纯相关性**（RRF 归一化 0..1 / IDF 加权 relevance）——minScore
 *   门槛与注入三档置信档位建在其上；时间重要性不再稀释召回面（修复 imp<6 的
 *   完美相关记忆单榜即被丢弃的缺陷：0.5×0.75=0.375<0.4）；
 * - score：排序分 = relevance × timeImportanceFactor——时间/重要度只影响先后，
 *   不再参与门槛。
 */
export interface ScoredEntry {
  entry: MemoryEntry
  score: number
  relevance: number
}

/**
 * IDF 加权关键词评分（保留 0-1 标定，轻量 BM25 化）。
 * 对每条候选计算 idfWeightedRelevance，过噪声下限与 minScore 门槛后返回；
 * 排序分 = relevance × timeImportanceFactor（解耦语义见 ScoredEntry）。
 */
export function scoreWithIdf(
  matches: MemoryEntry[],
  queryTokens: string[],
  cache: Map<string, Set<string>>,
  now: number,
  minScore: number,
): ScoredEntry[] {
  // 先一次性统计 df（候选集内分布），再逐条算分
  const df = buildDfMap(matches, queryTokens, cache)
  const scored: ScoredEntry[] = []
  for (const entry of matches) {
    const relevance = idfWeightedRelevance(queryTokens, getCachedTokens(cache, entry), (t) => df.get(t) ?? 0, matches.length)
    // 噪声下限：原始 relevance < 0.3 的弱命中不入检索（F3 BM25 噪声下限）
    if (relevance < MIN_RELEVANCE_SCORE) continue
    // Q1=A 解耦：门槛建在纯相关性上；时间/重要度只调排序
    if (relevance < minScore) continue
    scored.push({ entry, relevance, score: relevance * timeImportanceFactor(entry, now) })
  }
  return scored
}

/**
 * 构建关键词排名表（relevance ≥ 阈值的条目按 relevance 降序，同分按 id 稳定）。
 */
export function buildKeywordRank(
  matches: MemoryEntry[],
  queryTokens: string[],
  cache: Map<string, Set<string>>,
): Map<string, number> {
  const withRel = matches.map((entry) => ({ entry, rel: relevanceScore(queryTokens, getCachedTokens(cache, entry)) }))
  const kwRanked = withRel
    .filter((item) => item.rel >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.rel - a.rel || a.entry.id.localeCompare(b.entry.id))
  const kwRank = new Map<string, number>()
  kwRanked.forEach((item, index) => kwRank.set(item.entry.id, index + 1))
  return kwRank
}

/**
 * 构建语义排名表：优先使用注入的 KNN 排名器（sqlite-vec top-k），否则全量余弦。
 * 过滤 cosine≤0 的负相似条目，保持与关键词路径“未上榜不贡献”语义对齐。
 */
export function buildSemanticRank(
  matches: MemoryEntry[],
  options: SearchOptions,
  limit: number | undefined,
): Map<string, number> {
  let semList: Array<{ id: string; cosine: number }>
  // 有 semanticRank 且有 queryEmbedding 时走 KNN 榜（榜宽由 semanticTopK 派生）
  if (options.semanticRank !== undefined && options.queryEmbedding !== undefined) {
    semList = options
      .semanticRank(options.queryEmbedding, semanticTopK(limit))
      .filter((item) => item.cosine > 0)
  } else {
    // 全量路径：lookupEmbedding 逐条算余弦，缺向量/负相似不上榜
    semList = matches
      .map((entry) => ({
        id: entry.id,
        cosine: (() => {
          const v = options.lookupEmbedding?.(entry.id)
          return v === undefined ? 0 : cosine(options.queryEmbedding!, v)
        })(),
      }))
      .filter((item) => item.cosine > 0)
      .sort((a, b) => b.cosine - a.cosine || a.id.localeCompare(b.id))
  }
  const semRank = new Map<string, number>()
  semList.forEach((item, index) => semRank.set(item.id, index + 1))
  return semRank
}

/**
 * RRF 融合评分（B1 排名融合，免疫两路分数尺度差异）。
 * Q1=A 解耦：relevance = rrfScore 纯分（门槛建在其上）；排序分 = relevance × TIF。
 */
export function scoreWithRrf(
  matches: MemoryEntry[],
  queryTokens: string[],
  cache: Map<string, Set<string>>,
  now: number,
  options: SearchOptions,
  limit: number | undefined,
  minScore: number,
): ScoredEntry[] {
  // 关键词榜排名（用于 RRF）
  const kwRank = buildKeywordRank(matches, queryTokens, cache)
  // 语义榜排名（KNN 或全量余弦）
  const semRank = buildSemanticRank(matches, options, limit)
  // 为每条候选算 RRF 融合分（未上榜 rank=undefined 视为 0 贡献）
  const scored: ScoredEntry[] = []
  for (const entry of matches) {
    const relevance = rrfScore(kwRank.get(entry.id), semRank.get(entry.id))
    if (relevance < minScore) continue
    scored.push({ entry, relevance, score: relevance * timeImportanceFactor(entry, now) })
  }
  return scored
}

// ──────────────────────────────────────────────────────────────────────────────
// 排序与访问追踪
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 按分数降序排序（同分保持原序稳定，已由上游按 id 稳定）。
 */
export function sortScored(scored: Array<{ entry: MemoryEntry; score: number }>): void {
  scored.sort((a, b) => b.score - a.score)
}

/**
 * 访问追踪节流回写：同会话+记忆 60s 内至多落盘一次，避免高频检索反复写盘。
 * 异步 fire-and-forget，失败仅经 onError 上报（缺省 console——生产装配层注入
 * 插件 logger），不影响检索结果与主流程。
 * 节流表超限：淘汰最旧 1/4（与 getCachedTokens 同策略）——整体 clear 会让节流
 * 窗口频繁失效、放大写盘次数。
 */
export function trackAccess(
  top: MemoryEntry[],
  ctx: {
    table: KvTable<string, MemoryEntry>
    lastTrackedAt: Map<string, number>
    now: number
    iso: () => string
    /** 回写失败上报（生产传 logger.warn；缺省 console.warn 兜底可见性） */
    onWriteError?: (error: unknown) => void
  },
): void {
  for (const entry of top) {
    const key = `${entry.sessionId}::${entry.id}`
    const last = ctx.lastTrackedAt.get(key)
    if (last !== undefined && ctx.now - last < ACCESS_TRACK_WINDOW_MS) continue
    // 节流表上限保护：淘汰最旧四分位（保留近期节流窗口，防无界增长）
    if (ctx.lastTrackedAt.size >= TOKEN_CACHE_MAX) {
      const evictCount = Math.ceil(TOKEN_CACHE_MAX / 4)
      let removed = 0
      for (const staleKey of ctx.lastTrackedAt.keys()) {
        ctx.lastTrackedAt.delete(staleKey)
        if (++removed >= evictCount) break
      }
    }
    ctx.lastTrackedAt.set(key, ctx.now)
    // 异步回写 lastAccessAt/accessCount（尽力而为）
    const reportError = ctx.onWriteError ?? ((error: unknown) => console.warn(`[dsh-memory] 访问追踪回写失败（记忆 ${entry.id}）：`, error))
    void ctx.table
      .update(entry.id, (current) => ({
        ...current,
        lastAccessAt: ctx.iso(),
        accessCount: current.accessCount + 1,
      }))
      .catch((error: unknown) => {
        reportError(error)
      })
  }
}

/**
 * 空查询分支：无查询也无过滤→空结果；有过滤→按创建时间倒序（稳定排序同刻按 id）。
 */
export function handleEmptyQuery(
  matches: MemoryEntry[],
  options: SearchOptions,
  limit: number,
): MemoryEntry[] {
  // 无查询也无任何过滤：不返回无差别结果
  if (options.kind === undefined && options.tag === undefined && options.status === undefined && options.workspace === undefined) {
    return []
  }
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  return matches.slice(0, limit)
}
