/**
 * @module @echocore/dsh-memory/scoring
 *
 * 记忆检索评分：相关性 × 时间衰减 × 重要性（纯函数，无 IO，确定性）。
 * 借鉴 Generative Agents（arXiv:2304.03442）三维评分思想，公式自研简化：
 *   score = relevance(query, entry) × (0.6 + 0.4 × recency) × (0.5 + importance / 20)
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
 * 时间衰减因子：以 lastAccessAt 为基准的半衰期指数衰减（默认半衰期 7 天）。
 * 返回 1（刚访问）到趋近 0（久未访问）之间的值。
 */
export function recencyFactor(lastAccessAt: string, now: number, halfLifeDays = 7): number {
  const days = (now - Date.parse(lastAccessAt)) / 86_400_000
  if (!Number.isFinite(days) || days <= 0) return 1
  return Math.exp((-Math.LN2 / halfLifeDays) * days)
}

/** 重要性权重：importance 0-10 映射到 0.5..1.0 的乘数 */
export function importanceFactor(importance: number): number {
  return 0.5 + Math.min(Math.max(importance, 0), 10) / 20
}

/**
 * 综合评分（0..1）：相关性主导，时间衰减与重要性为调制因子。
 * 供检索排序与阈值过滤使用；结果确定可单测。
 */
export function memoryScore(entry: MemoryEntry, queryTokens: string[], now: number): number {
  const entryTokens = new Set(tokenize(`${entry.content} ${entry.tags.join(' ')}`))
  const relevance = relevanceScore(queryTokens, entryTokens)
  if (relevance <= 0) return 0
  const recency = recencyFactor(entry.lastAccessAt, now)
  return relevance * (0.6 + 0.4 * recency) * importanceFactor(entry.importance)
}

/** 便捷入口：从原始查询文本与条目直接计算综合评分 */
export function scoreEntry(entry: MemoryEntry, query: string, now: number): number {
  return memoryScore(entry, tokenize(query), now)
}
