/**
 * @module @echocore/dsh-memory/scoring
 *
 * 记忆检索评分：相关性 × 时间衰减 × 重要性（纯函数，无 IO，确定性）。
 * 借鉴 Generative Agents（arXiv:2304.03442）三维评分思想，公式自研简化：
 *   score = relevance(query, entry) × (0.6 + 0.4 × recency) × (0.5 + importance / 20)
 *
 * P3 衰减增强（OPTIMIZATION_PLAN_3，依据 Scrub Jay arXiv:2608.04746 /
 * Learning What to Remember arXiv:2606.12945 / Adaptive Recall / Mem0）：
 * - importance 感知半衰期：高重要度记忆衰减更慢（magic-context decay-curve
 *   的 D 语义）——无差别时间衰减会伤害"旧但重要"的项目规则/决策；
 * - salience floor：重要度 ≥ 8 的记忆时间因子下限 0.5（保活）——高价值
 *   事实不允许单凭时间被压出注入/检索前排。
 *
 * 设计约束：
 * - 全部纯函数：输入输出确定，便于单测与调试；
 * - 无向量库：会话级记忆量级（数百条）下关键词重合评分足够（决策 D4）；
 * - 分词同时覆盖英文单词与中文二元组，适配混合语言会话。
 */

import type { MemoryEntry } from './types.js'

/** 中文二元组分词窗口大小 */
const CJK_GRAM = 2

/** 英文/数字分词：小写字母数字连续段 */
const WORD_RE = /[a-z0-9]+/g

/** 基础半衰期（天）：importance 5 时的半衰期（与 P3 前默认一致） */
const BASE_HALF_LIFE_DAYS = 7

/** 半衰期重要度敏感度：importance 每 +2，半衰期翻倍（2^((imp-5)/2)） */
const HALF_LIFE_IMPORTANCE_STEP = 2

/** salience floor 触发的重要度下限（≥ 此值保活） */
export const SALIENCE_FLOOR_IMPORTANCE = 8

/** salience floor 的时间因子下限（recency ≥ 0.5 → 时间调制因子 ≥ 0.8） */
export const SALIENCE_FLOOR_RECENCY = 0.5

/** CJK 统一表意文字区段（含扩展 A） */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0x3400 && code <= 0x4dbf) // 扩展 A
  )
}

/**
 * 文本分词：英文单词（小写）+ 中文连续段按二元组切分。
 * 例："使用 pnpm workspace" → ["pnpm", "workspace", "使用", "用p", "pn"（前两个来自"使用"的 2-gram）...]
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 英文/数字单词
  for (const match of lower.matchAll(WORD_RE)) {
    tokens.push(match[0])
  }

  // 中文二元组：连续 CJK 字符按滑动窗口切分（长度 1 时退化为单字）
  let run = ''
  for (const ch of lower) {
    if (isCjk(ch)) {
      run += ch
    } else if (run.length > 0) {
      appendCjkTokens(tokens, run)
      run = ''
    }
  }
  if (run.length > 0) appendCjkTokens(tokens, run)

  return tokens
}

/** 把一段连续 CJK 文本追加为二元组 token */
function appendCjkTokens(tokens: string[], run: string): void {
  if (run.length === 1) {
    tokens.push(run)
    return
  }
  for (let i = 0; i + CJK_GRAM <= run.length; i++) {
    tokens.push(run.slice(i, i + CJK_GRAM))
  }
}

/**
 * 相关性得分：查询 token 中被条目命中的比例（0..1）。
 * 命中判定为 token 精确包含于条目 token 集合；空查询得 0 分。
 */
export function relevanceScore(queryTokens: string[], entryTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0
  let matched = 0
  for (const token of queryTokens) {
    if (entryTokens.has(token)) matched++
  }
  return matched / queryTokens.length
}

/**
 * importance 感知半衰期（天）：7 × 2^((imp-5)/2)。
 * importance 5 → 7 天（与 P3 前一致）；7 → 14 天；9 → 28 天；10 → ~39.6 天。
 * 语义对齐 magic-context decay-curve 的 D 参数（importance 越高衰减越慢），
 * 避免高重要度项目规则/决策被时间衰减压出检索前排。imp 先钳制 0..10。
 */
export function adaptiveHalfLifeDays(importance: number): number {
  const clamped = Math.min(Math.max(importance, 0), 10)
  return BASE_HALF_LIFE_DAYS * 2 ** ((clamped - 5) / HALF_LIFE_IMPORTANCE_STEP)
}

/**
 * 时间衰减因子：以 lastAccessAt 为基准的半衰期指数衰减（半衰期可注入）。
 * 返回 1（刚访问）到趋近 0（久未访问）之间的值。
 */
export function recencyFactor(lastAccessAt: string, now: number, halfLifeDays = BASE_HALF_LIFE_DAYS): number {
  const days = (now - Date.parse(lastAccessAt)) / 86_400_000
  if (!Number.isFinite(days) || days <= 0) return 1
  return Math.exp((-Math.LN2 / halfLifeDays) * days)
}

/** 重要性权重：importance 0-10 映射到 0.5..1.0 的乘数 */
export function importanceFactor(importance: number): number {
  return 0.5 + Math.min(Math.max(importance, 0), 10) / 20
}

/**
 * 时间 × 重要性调制因子（0.5..1.0）：memoryScore 与语义融合路径共用。
 * P3：半衰期随 importance 自适应 + 重要度 ≥ 8 的 salience floor（保活）。
 */
export function timeImportanceFactor(entry: MemoryEntry, now: number): number {
  let recency = recencyFactor(entry.lastAccessAt, now, adaptiveHalfLifeDays(entry.importance))
  if (entry.importance >= SALIENCE_FLOOR_IMPORTANCE) {
    recency = Math.max(recency, SALIENCE_FLOOR_RECENCY)
  }
  return (0.6 + 0.4 * recency) * importanceFactor(entry.importance)
}

/**
 * 综合评分（0..1）：相关性主导，时间衰减与重要性为调制因子。
 * 结果确定可单测。
 */
export function memoryScore(entry: MemoryEntry, queryTokens: string[], now: number): number {
  const entryTokens = new Set(tokenize(`${entry.content} ${entry.tags.join(' ')}`))
  const relevance = relevanceScore(queryTokens, entryTokens)
  if (relevance <= 0) return 0
  return relevance * timeImportanceFactor(entry, now)
}

/** 便捷入口：从原始查询文本与条目直接计算综合评分 */
export function scoreEntry(entry: MemoryEntry, query: string, now: number): number {
  return memoryScore(entry, tokenize(query), now)
}

/** RRF 平滑常数（业界标准 k=60：cuuun/lin 2019，RRF 论文推荐） */
const RRF_K = 60

/**
 * RRF（Reciprocal Rank Fusion）排名融合分（B1：2026 混合检索默认栈）。
 * 两路排名（关键词 relevance 榜 / 语义 cosine 榜）按 1/(k+rank) 叠加后归一化：
 * - 双榜第一 = 1（上界）；单榜第一 = 0.5（半权）；双榜均不在榜 = 0；
 * - rank 为 1-based；undefined = 该路未上榜（relevance=0 或 cosine≤0）→ 0 贡献。
 * 与分数加权（w×rel+(1-w)×cos）的差异：RRF 只用排名不用分值，天然免疫两路
 * 分数尺度差异（rel 0..1 vs cos -1..1），且零重合高语义相关条目可单榜上榜。
 */
export function rrfScore(kwRank: number | undefined, semRank: number | undefined, k = RRF_K): number {
  let score = 0
  if (kwRank !== undefined) score += 1 / (k + kwRank)
  if (semRank !== undefined) score += 1 / (k + semRank)
  return score / (2 / (k + 1))
}
