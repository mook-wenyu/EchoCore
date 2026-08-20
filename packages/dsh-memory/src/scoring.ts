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
import { Jieba } from '@node-rs/jieba'
// 显式 .js 子路径：包无 exports 字段，ESM 的 NodeNext 严格解析要求扩展名
// （裸子路径 '@node-rs/jieba/dict' 在 ESM 下 ERR_MODULE_NOT_FOUND——副本运行时实测）
import { dict } from '@node-rs/jieba/dict.js'

const BASE_HALF_LIFE_DAYS = 7

/** 半衰期重要度敏感度：importance 每 +2，半衰期翻倍（2^((imp-5)/2)） */
const HALF_LIFE_IMPORTANCE_STEP = 2

/** salience floor 触发的重要度下限（≥ 此值保活） */
export const SALIENCE_FLOOR_IMPORTANCE = 8

/** salience floor 的时间因子下限（recency ≥ 0.5 → 时间调制因子 ≥ 0.8） */
export const SALIENCE_FLOOR_RECENCY = 0.5

/**
 * salience floor 的活跃窗口（ms；G4 防霸榜）：
 * imp≥8 的记忆仅当"最近创建或访问在此窗口内"才保活——90 天未触碰的高重要度
 * 记忆允许衰减软降权。审计实测：991 条 imp≥8 全部无差别保活 → 检索/快照长期
 * 霸榜、压制新知识；活跃性门槛让"旧高重要度"按时间自然退出前排。
 */
export const SALIENCE_FLOOR_ACTIVE_WINDOW_MS = 90 * 86_400_000

/**
 * 相关性硬门槛（F2，防上下文污染）：relevance 低于此值的记忆视为与查询无关，
 * 宁可不注入（弱相关注入 > 无注入）。
 *
 * 依据：
 * - 行业门槛实践——mem0 0.65-0.75（embedding 分数）、magic-context
 *   auto_search.score_threshold=0.6；本实现语义评分与关键词评分非同一量纲，
 *   此处仅约束关键词路径的 relevance；
 * - "低质注入会摧毁精确能力"有量化支撑：noisy retrieval 使已知答案准确率
 *   下降 51-64%，宁缺毋滥；
 * - 关键词路径的 relevance 是 query token 命中比例（relevanceScore），
 *   0.3 ≈ 10-token 查询命中 3 个 token——低于此通常只是同片段巧合重合，
 *   不构成真正的语义相关。
 *
 * 语义融合路径（P4/B1 RRF）为**两条独立门槛**（Q4 接线，修 2026-08-17 注释漂移）：
 * - 关键词路径噪声下限 = 本常量：store.search 对每条 keyword relevance 单独门控
 *   （rel < MIN_RELEVANCE_SCORE 直接跳过，不入检索）；
 * - 融合分门槛 = store.search 的 minScore（缺省 0.15）作用于 rrf×timeImportance；
 * 语义单榜靠前条目（单榜分 = 1/(k+1)/归一化 ≈ 0.5）不受下限影响，零重合的高
 * 语义相关条目仍可单榜召回——下限只筛"弱关键词命中 + 未上榜语义"的杂音。
 */
export const MIN_RELEVANCE_SCORE = 0.3

/** CJK 统一表意文字区段（含扩展 A） */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0x3400 && code <= 0x4dbf) // 扩展 A
  )
}

/**
 * 文本分词（J1 升级，2026-08-15）：英文单词（小写）+ jieba 中文词（真实词边界）
 * + 中文 2-gram（任意 2 字子串兜底）——**并集语义**：
 * - jieba 词：真实词边界（修 2-gram 的"项目/项目偏"重叠歧义，语义质量）；
 * - 2-gram 兜底：jieba 对未登录词会切碎成单字（OOV 缺陷），2-gram 保证
 *   任意 2 字组合必命中——召回不丢失（"项目偏好"中"目偏"仍可检索）；
 * - 输出去重（jieba 词与 2-gram 重叠只留一个——relevance 分母不稀释）。
 * 例："记忆系统架构设计" → ["记忆系统", "架构设计", "记忆", "忆系", "系统", ...]
 * jieba 单例惰性初始化（Jieba.withDict 默认词典；cut 同步 0.4ms/次）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 英文/数字单词
  for (const match of lower.matchAll(WORD_RE)) {
    tokens.push(match[0])
  }

  // J1：jieba 中文词（真实词边界；过滤空白；英文词与 WORD_RE 重复由末尾去重收敛）。
  // 中文单字丢弃——jieba 对 OOV 会切碎成单字，单字无检索价值且稀释 relevance
  // 分母（实测 '怎么用' → '用' 单字使命中率 0.5→0.4 跌破门槛）；单字场景由
  // 下方 2-gram 路径的退化分支覆盖（连续 CJK 段长度 1 时 push 单字）。
  for (const word of jieba().cut(text)) {
    const w = word.trim()
    if (w === '') continue
    if (isCjk(w[0] ?? '')) {
      if (w.length >= 2) tokens.push(w.toLowerCase())
    } else if (/^[a-z0-9]+$/i.test(w)) {
      tokens.push(w.toLowerCase())
    }
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

  // J1 去重：jieba 词与 2-gram/英文重叠只留一个（relevance 分母不稀释；
  // 顺序保持——先英文、再 jieba 词、后 2-gram 兜底）
  return [...new Set(tokens)]
}

/**
 * jieba 分词器单例（J1）：@node-rs/jieba N-API 预编译（Windows x64 免编译），
 * 默认词典随包（Jieba.withDict）；惰性初始化——首次 tokenize 才加载词典
 * （~10ms 一次性；cut 同步 ~0.4ms/次）。
 */
let jiebaInstance: Jieba | undefined
function jieba(): Jieba {
  if (jiebaInstance === undefined) {
    jiebaInstance = Jieba.withDict(dict)
  }
  return jiebaInstance
}

/**
 * jieba 中文词列表（J2 预分词列数据源；装配层派生 content_tokens 用）。
 * 过滤空白与中文单字（与 tokenize 的 jieba 路径同语义——单字无索引价值）；
 * 英文词不含（FTS5 unicode61 对英文按词边界天然切分，预分词列只补中文）。
 */
export function jiebaWords(text: string): string[] {
  const words: string[] = []
  for (const word of jieba().cut(text)) {
    const w = word.trim()
    if (w === '' || w.length === 0) continue
    if (isCjk(w[0] ?? '')) {
      if (w.length >= 2) words.push(w)
    }
  }
  return words
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
 * 注：为关键词路径的默认（无 df 上下文）打分保留——store 关键词分支现改用
 * idfWeightedRelevance（轻量 IDF 加权），本函数仍供其他无候选集场景使用。
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
 * BM25 逆文档频率：max(0, ln((N - df + 0.5) / (df + 0.5) + 1))。
 * - df=0 时自动取得最大值（df 越小 idf 越大）——"缺失"查询 token 用最大 idf 保底，
 *   无需特判；这些 token 只出现在分母（条目不包含即永不命中），稀释弱相关；
 * - df=N（所有候选都含）时 idf→趋近 0 而不取负（对数内 +1 保证 ln>1 恒正）；
 * - 返回严格 > 0（N ≥ df ≥ 0 时对数内 > 1），不会造成除零。
 */
export function bm25Idf(n: number, df: number): number {
  return Math.max(0, Math.log((n - df + 0.5) / (df + 0.5) + 1))
}

/**
 * 轻量 IDF 加权相关性（0..1）——关键词路径的 BM25 化，保留 0-1 绝对标定：
 *   分子 = Σ(命中 query token 的 idf)；分母 = Σ(df>0 的 query token 的 idf)。
 * - 全命中（候选集内所有 query token 都命中）→ 分子 = 分母 = 1.0（0-1 上界不受
 *   IDF 影响——注入三档 0.7/0.4 语义保持）；
 * - 零命中 → 0；部分命中 → 命中的 idf 占比（稀有词命中权重大于常见词，同命中数下
 *   IDF 可区分条目）；
 * - **df=0 的 query token 不进分母**（2026-08-16 修复）：候选集完全无此词时它对
 *   候选集无区分意义——若进分母（最大 idf），长查询（P3 拼接/含噪声词）会把命中
 *   条目的分砸到注入阈值以下（既有测试实证：'pnpm workspace 怎么' 的 '怎么'、
 *   3 段拼接的 2-gram 使相关记忆跌破 0.4）。分数语义 = 候选集内的相对匹配度。
 * - 分母为 0（全部 query token 均 df=0）→ 0（候选集内无任何匹配面）。
 *
 * df 与 N 由调用方在检索时对候选集统计（零维护——无写路径改动）：
 *   df = 某 query token 在候选集中出现的条目数；N = 候选集大小。
 * df(token) 对未出现 token 应返回 0。用传入的 df 回调逐 token 查询，避免建立全量表。
 */
export function idfWeightedRelevance(
  queryTokens: string[],
  entryTokens: ReadonlySet<string>,
  df: (token: string) => number,
  n: number,
): number {
  if (queryTokens.length === 0 || n <= 0) return 0
  let numerator = 0
  let denominator = 0
  for (const token of queryTokens) {
    const tokenDf = df(token)
    if (tokenDf <= 0) continue // 候选集外词：不进分母（见函数注释）
    const idf = bm25Idf(n, tokenDf)
    denominator += idf
    if (entryTokens.has(token)) numerator += idf
  }
  // 全部 token 均候选集外 → 候选集内无匹配面
  return denominator <= 0 ? 0 : numerator / denominator
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
 * 访问频率调制半衰期（天）（B2，Elastic agent memory / FadeMem 落地模式）：
 * 访问次数越多衰减越慢——召回行为本身把记忆"抬回"前排（被频繁使用的记忆
 * 更有价值）。调制因子 1 + log2(1 + accessCount)：0 次 → 1×；1 次 → 2×；
 * 3 次 → 3×；7 次 → 4×（对数增长，防止高频访问无限放大）。
 * 与 importance 感知叠加：高重要度 + 高频访问的记忆衰减最慢。
 */
export function modulatedHalfLifeDays(importance: number, accessCount: number): number {
  const frequencyFactor = 1 + Math.log2(1 + Math.max(0, Math.floor(accessCount)))
  return adaptiveHalfLifeDays(importance) * frequencyFactor
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
 * 有效重要度（Q1/2c 轻量融合，2026-08-17 用户拍板；W2 扩展 2026-08-18）：保留 LLM 单次 1-10 作为
 * 主因子，叠加「访问频率证据」——对被频繁召回/引用的记忆按对数式增益抬重要度：
 *   evidenceBoost = accessCount>0 ? min(2, floor(log2(1+accessCount))) : 0
 *   → 1 次 = +1；3 次 = +2；≥7 次 = +2（封顶 +2，防高频访问无界放大/霸榜；
 *      与 B2 半衰期访问调制的对数压缩同源）。
 * 再叠加 W2「self/user 相关性初始因子」（Learning What to Remember arXiv:2606.12945
 * 主导因子之一；提取时 LLM 一次性评定，见 types.MemoryEntry.selfRelevance）：
 *   initialBoost = selfRelevance>=8 ? 2 : selfRelevance>=6 ? 1 : 0
 *   → 极高自相关 +2、高自相关 +1、其余 +0（同样封顶，防自评分过度支配保留面）。
 * 仅用于「保留/提升」决策面（listByImportance / 快照取数）——**不动检索主路径**
 * （search 评分仍用存储 importance + 半衰期访问调制，避免同一访问证据双重计入）。
 * 依据：LexWisdom 盲区实证 多因子 0.770 vs 单因子 0.518（arXiv:2606.12945）。
 * **Echo-Gap 红线（arXiv:2608.00017）**：selfRelevance 是创建期一次性初始因子，
 * 与访问证据一样**绝不**由后续 LLM 自评/反思结果重写或回写 stored importance——
 * 防止自评分误差被反复强化复合放大。**不训学习权重**（YAGNI）。
 */
export function effectiveImportance(importance: number, accessCount: number, selfRelevance = 0): number {
  const evidence = accessCount > 0 ? Math.min(2, Math.floor(Math.log2(1 + accessCount))) : 0
  const initial = selfRelevance >= 8 ? 2 : selfRelevance >= 6 ? 1 : 0
  return Math.min(10, Math.max(0, importance + evidence + initial))
}

/**
 * 时间 × 重要性调制因子（0.5..1.0）：memoryScore 与语义融合路径共用。
 * P3：半衰期随 importance 自适应 + 重要度 ≥ 8 的 salience floor（保活）。
 * B2：半衰期再乘访问频率调制（高频访问衰减更慢，召回抬回）。
 * G4：floor 仅对活跃记忆生效（90 天内创建/访问）——旧高重要度允许软降权。
 */
export function timeImportanceFactor(entry: MemoryEntry, now: number): number {
  let recency = recencyFactor(entry.lastAccessAt, now, modulatedHalfLifeDays(entry.importance, entry.accessCount))
  if (entry.importance >= SALIENCE_FLOOR_IMPORTANCE && isRecentlyActive(entry, now)) {
    recency = Math.max(recency, SALIENCE_FLOOR_RECENCY)
  }
  return (0.6 + 0.4 * recency) * importanceFactor(entry.importance)
}

/** G4：记忆是否"活跃"——最近创建或访问在 SALIENCE_FLOOR_ACTIVE_WINDOW_MS 内 */
function isRecentlyActive(entry: MemoryEntry, now: number): boolean {
  const lastAccess = Date.parse(entry.lastAccessAt)
  const created = Date.parse(entry.createdAt)
  return now - lastAccess <= SALIENCE_FLOOR_ACTIVE_WINDOW_MS || now - created <= SALIENCE_FLOOR_ACTIVE_WINDOW_MS
}

/**
 * RRF 平滑常数（业界标准 k=60：cuuun/lin 2019，RRF 论文推荐） */
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

/**
 * 集合 Jaccard 相似度（0..1）：交集大小 / 并集大小。
 * - 供 reflect / store 复用，输入为已分词的 token 集合（与 tokenize 语义一致）；
 * - 空集合按 0 处理（与既有 jaccardOf 行为对齐，避免除零）。
 */
export function jaccard(aTokens: ReadonlySet<string>, bTokens: ReadonlySet<string>): number {
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  let intersection = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection++
  }
  const union = aTokens.size + bTokens.size - intersection
  return union === 0 ? 0 : intersection / union
}
