/**
 * @module @echocore/dsh-memory/reflect
 *
 * 基于 LLM 的反思自进化：周期性/按需审视已有记忆条目之间的「语义近似重复」与
 * 「跨条目矛盾」，一旦判定成立，仅执行「保留较新者、归档较旧者」的可逆动作
 * （archive 非 delete，审计 by:'system'）。
 *
 * 域内拍板：只做「可逆归档一侧」动作。
 * - 严禁：内容改写、单次 importance 重打分（仅合并时取两者更大值）、新建/合成
 *   insight、操作被 supersede / 已归档 / 跨 workspace 的条目。
 * - 每对判定必须经 store.getById 重读（防归档/被覆盖竞态，与 maintenance 同模式）。
 * - 全程自收容：任何异常 warn 后返回，后台任务绝不逃逸 rejection；失败不更新
 *   lastRunAt/route 缓存（可观测"上次成功反思"）。
 * - 审计 detail：store.archive 已扩展可选 detail 参数（集成时改，向后兼容），
 *   反思归档/合并动作将"依据引用（保留侧短 id）+ 理由"写入归档审计 detail，
 *   保证每次动作可溯源、可回滚（依据引用是"只操作有来源条目"护栏的可审计面）。
 *
 * 覆盖范围补盲：既有规则合并已覆盖 tokenJaccard ≥ 0.85 的近似重复（maintenance
 * 任务 a）与 create 的 supersede（≥0.7）——本模块只补 [0.08, 0.85) 的语义盲区
 * （2026-08-18 调优后下界由 0.15 降至 0.08，并加 minTokenOverlap≥2 辅助门）。
 */

import { BlockAssembler, createUserMessage, type LlmRuntime, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

// P0 卡死修复后 pairSim 改用预取向量+预计算范数的内联点积（与 cosineSimilarity 数学
// 恒等），本模块不再直接依赖 embed-index 运行时导出
import { MEMORY_PLUGIN_ID } from './constants.js'
import { jaccard, tokenize } from './scoring.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'
import { extractBalancedJson } from './utils/balanced-json.js'

/** 自动周期门控：距上次成功执行未满该间隔则跳过（不打 LLM） */
export const REFLECT_INTERVAL_MS = 6 * 3_600_000

/**
 * 候选窗口：listRecent 拉取量（只审最新前 N 条，控制单次负载）
 * 2026-08-18 调优：8705 规模下 200 窗仅覆盖 2.3%，旧重复永不进窗；
 * 扩大至 400 并保持 maxSim 优先，使旧重复有机会被审（分层采样思想的轻量实现）。
 */
export const REFLECT_WINDOW = 400

/**
 * 每批「焦点」条目数上限。
 * 2026-08-20 P2 拍板（完整多批流水线）：20→60——配合 REFLECT_BATCH_SIZE 分批送审，
 * 单轮覆盖翻三倍；批内规模不变（每批 ≤10 焦点），单次 prompt 负载反而低于旧单批 20。
 */
export const REFLECT_FOCUS_BUDGET = 60

/**
 * P2 多批流水线：每批送审焦点数上限（每批独立一次 LLM 调用）。
 * 依据：小批 prompt 让模型注意力集中在少量候选对上（旧单批 20 焦点×4 行/焦点
 * 的长尾易被忽略）；批间串行执行，applyDecision 的 getById 重读保证跨批竞态安全。
 */
export const REFLECT_BATCH_SIZE = 10

/** 每个焦点的候选对比条目数 */
export const REFLECT_PEERS_PER_FOCUS = 3

/**
 * C34（2026-08-18 拍板）：语义合并门——双侧有向量时 cosine ≥ 该值才算候选对
 * （对齐 ai-memory `CONSOLIDATE_COSINE_THRESHOLD=0.75`：抓语义近等价表述，
 * 不并仅主题相邻；任一侧无向量 → 回退 token-Jaccard 带）。随 C33 覆盖补齐扩大生效。
 * 2026-08-18 调优：按维度区分阈值（384 维本地 bge-m3/MiniLM 实测技术文档 paraphrase
 * 在 0.70-0.78 区间被截掉，0.72 更宽松；1024 维远程保持 0.75 严谨）。
 */
export const REFLECT_SEMANTIC_THRESHOLD = 0.75
/** 本地 384 维语义阈值（更宽松，避免技术文档类改写被截） */
export const REFLECT_SEMANTIC_THRESHOLD_LOCAL = 0.72
/** 远程 1024 维语义阈值（保持权威值） */
export const REFLECT_SEMANTIC_THRESHOLD_REMOTE = 0.75

/**
 * 根据向量维度返回语义阈值（显式降级语义+中文注释：非防御性兜底）
 * - 维度 384 → 0.72（本地 MiniLM/bge-m3 小模型区间宽松）
 * - 其他（如 1024 远程）→ 0.75（维持权威阈值）
 * 若无法得知维度（如向量缺失）调用方应走 Jaccard 回退，不调用此函数。
 */
export function getSemanticThresholdForDim(dim: number): number {
  // 显式判断：仅 384 走宽松阈值，其余一律 0.75（不过严也不过松）
  // 若已自适应，384 维走自适应阈值（见 adjustThresholdByHitRate）
  if (dim === 384 && adaptiveLocalThreshold !== REFLECT_SEMANTIC_THRESHOLD_LOCAL) {
    return adaptiveLocalThreshold
  }
  return dim === 384 ? REFLECT_SEMANTIC_THRESHOLD_LOCAL : REFLECT_SEMANTIC_THRESHOLD_REMOTE
}

/** 自适应后本地阈值（初始 0.72，hitRate 驱动动态调整） */
let adaptiveLocalThreshold = REFLECT_SEMANTIC_THRESHOLD_LOCAL

/**
 * 阈值自适应：基于语义向量覆盖率动态调整本地语义阈值
 * - hitRate < 0.1 向量稀缺 → 阈值 0.72→0.68 放宽召回
 * - hitRate > 0.3 覆盖良好 → 阈值 0.72→0.75 收紧控噪
 * - 中间区间保持 0.72
 * 中文注释：覆盖率来自 memory_status/semanticHitRate，经维护周期采样
 */
export function adjustThresholdByHitRate(hitRate: number): number {
  // 低覆盖：语义信号稀缺，放宽阈值提升召回
  let next: number
  if (hitRate < 0.1) next = 0.68
  // 中覆盖 [0.1,0.3]：原 0.72 中间档不动作（21.8% 命中无放宽），增 0.70 中间档使 21.8% 走放宽
  else if (hitRate <= 0.3) next = 0.70
  // 高覆盖：语义充足，收紧阈值控制噪声
  else next = 0.75
  adaptiveLocalThreshold = next
  return next
}

/** LLM 输出上限 */
export const REFLECT_MAX_TOKENS = 1024

/**
 * peer 相似带下界：低于此值语义关联太弱，交由纯函数时剔除
 * 2026-08-18 调优：由 0.15 降至 0.08（短文本如 "pnpm workspace" vs "pnpm 管理多包"
 * 实测 Jaccard≈0.08 曾被漏，降阈召回；配合 minTokenOverlap≥2 防短文本噪声放大）。
 */
export const PEER_MIN_JACCARD = 0.08

/** peer 相似带上界：≥ 此值属既有规则合并域（maintenance 任务 a），本模块不重复 */
export const PEER_MAX_JACCARD = 0.85

/** 短文本噪声辅助门：Jaccard 带内仍需至少 2 个 token 重合才算候选 */
export const PEER_MIN_TOKEN_OVERLAP = 2

/** 反思依赖（store/llm/logger/now 注入，便于单测） */
export interface ReflectionDeps {
  store: MemoryStore
  llm: Pick<LlmRuntime, 'stream'>
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
  now: () => number
  /**
   * C34：语义门取向量（有向量时 cosine≥阈值 为主门；缺省无向量 → Jaccard 带回退）。
   * 使用 getter 函数延迟读取 holder.index——构造时可能为 undefined（异步初始化未完成），
   * 热换后新索引即生效（与 store hooks/injector 同模式）。
   */
  embedding?: { getVector(id: string): Float32Array | undefined }
  /** 延迟取向量索引（hot-swap 守卫；非测试场景由装配层注入） */
  getEmbeddingIndex?: () => { getVector(id: string): Float32Array | undefined } | undefined
  /**
   * 水位线持久化表（P1，2026-08-20 用户拍板；可选）：SqliteKvTable meta 表实例。
   * 键 REFLECT_CURSOR_KEY='reflectCursor'，值 JSON {createdAt,id}——上次成功反思窗口
   * 最新条目游标。自动路径只审严格新于游标的焦点（peer 全窗不变），避免每轮把同一
   * 窗口重复送 LLM（Mem0 arXiv:2504.19413 增量处理范式同构）；手动 force 无视水位线
   * 全窗复审。缺省（未注入）= 水位线关闭，行为与旧版全窗一致（测试兼容面）。
   */
  metaTable?: KvTable<string, string>
}

/** 反思水位线在 meta 表中的键名（与维护游标 lastCursor 同表不同键，互不干扰） */
export const REFLECT_CURSOR_KEY = 'reflectCursor'

/** 本轮反思观察量 */
export interface ReflectionSummary {
  /** 进入提示词的 focus 数 */
  reviewed: number
  /** LLM 提出的动作总数 */
  decisions: number
  /** 实际执行成功：语义重复 → 归档旧者 + 重要度取更大值 */
  merged: number
  /** 实际执行成功：矛盾 → 归档旧者 */
  archived: number
  /** none 或拒绝执行（已归档/被覆盖/跨域等）数量 */
  skipped: number
  /**
   * 可观测：语义向量覆盖率（0..1），用于度量"向量覆盖仅 21.8% 双侧命中 p²≈3.5% 导致救援失效"
   * 计算 = 候选窗口内有向量条目数 / 窗口总条目数；无 embedding 时 undefined。
   * 低成本可观测，不引入直方图日志的额外复杂度亦可（此处同时在 runReflection 中 info 日志）。
   */
  semanticHitRate?: number
}

/** 一轮反思裁决 */
export interface ReflectionDecision {
  focusId: string
  peerId: string
  action: 'merge' | 'archive' | 'none'
  reason: string
}

/**
 * 反思累计观测量（Q4/2b 拍板 2026-08-17：轻量质量钩子——跨轮累计，度量"反思是否
 * 在收敛"：如 archived/merged 逐轮递减 → 近似重复与矛盾已清完；skipped 持续偏高 →
 * 候选对噪声大。进程内态（重启归零），经 memory_status/RPC status 透出。
 * 显式边界：不做"被反思归档条目的后续被 supersede 追踪"——被反思归档（archive）
 * 的条目不参与 supersede 语义，跨链路追踪超出轻量范畴（可观测底座先立，深度
 * 归因留给 F3 建议的探测集评估立项下轮）。
 */
export interface ReflectionCumulative {
  /** 已成功执行批次（含空批次；失败批次不计入） */
  runs: number
  decisions: number
  merged: number
  archived: number
  skipped: number
  /** 连续空轮计数：reviewed>0 且 decisions==0 的连续轮数，命中非空即重置 */
  emptyRounds: number
}

import { REFLECTION_PROMPT_VERSION, JSON_OUTPUT_INSTRUCTION, SECURITY_INSTRUCTION } from './constants.js'

/**
 * 反思系统提示词 v1.1（P0：统一输出格式 + 安全防护；P1：增加边界示例）
 */
export const REFLECTION_SYSTEM_PROMPT = `你是一个记忆反思器，审视已有记忆条目之间的语义近似重复与跨条目矛盾。
${SECURITY_INSTRUCTION}

输入说明：下列记忆对已由相似度预筛（语义余弦≥阈值或 Jaccard∈[0.08,0.85)且重合token≥2），多数对确实存在近似重复或矛盾，请倾向于判 merge/archive；仅当两条确实无关或证据不足时判 none，避免过度保守。

判断规则：
1. 语义近似重复（action: merge）：两条记忆表述同一事实，仅措辞/详略不同
2. 矛盾（action: archive）：两条记忆针对同一主题给出相互冲突的结论
3. 无关或不足以判定（action: none）

禁止：不得建议改写、调整重要性、新建记忆；只允许在都来自记忆库的条目之间判定；每条裁决必须引用 focus 与 peer 的完整 id（#<id>）。

示例1（merge——同一事实的措辞改写）：
焦点 #dupOld kind=fact content=CourtGrantTypes 迁至 Project persistence
对比 #dupNew kind=fact content=CourtGrantTypes 已迁移到 Project 持久化机制
→ {"focusId":"dupOld","peerId":"dupNew","action":"merge","reason":"同一事实的措辞改写"}

示例2（none——主题无关）：
焦点 #aaa kind=fact content=优先使用 pnpm 管理依赖
对比 #bbb kind=fact content=项目部署在 Vercel 平台
→ {"focusId":"aaa","peerId":"bbb","action":"none","reason":"主题无关，无重复或矛盾"}

示例3（none——看似相关但实际不同方法）：
焦点 #ccc kind=insight content=使用 TDD 提升代码质量
对比 #ddd kind=insight content=使用 Code Review 提升代码质量
→ {"focusId":"ccc","peerId":"ddd","action":"none","reason":"都是质量实践但方法不同，非重复"}

${JSON_OUTPUT_INSTRUCTION}
{"decisions":[{"focusId":"<focus 完整 id>","peerId":"<peer 完整 id>","action":"merge|archive|none","reason":"简短中文理由"}]}
没有需要处理的输出：{"decisions":[]}

<!-- ${REFLECTION_PROMPT_VERSION} -->`

/** 反思用户消息尾部指令 */
const REFLECT_USER_RULES = `请依据上述规则审视下列记忆条目对，只输出 JSON。`

/** 复用单源 extractBalancedJson（见 utils/balanced-json）；本地不再重复实现 */

/** 解析单条裁决项：非法/未知 action/字段缺失 → undefined（丢弃该条） */
function parseDecisionItem(item: unknown): ReflectionDecision | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  if (typeof record.focusId !== 'string' || record.focusId === '') return undefined
  if (typeof record.peerId !== 'string' || record.peerId === '') return undefined
  if (record.action !== 'merge' && record.action !== 'archive' && record.action !== 'none') return undefined
  if (typeof record.reason !== 'string') return undefined
  return { focusId: record.focusId, peerId: record.peerId, action: record.action, reason: record.reason }
}

/**
 * 严格解析 LLM 反思输出：取首个平衡 JSON 对象，期望 {"decisions":[...]}。
 * 任何非法/未知 action/字段缺失 → 丢弃该条；非 JSON → 返回 []（不抛错）。
 */
export function parseReflectionDecisions(text: string): ReflectionDecision[] {
  const match = extractBalancedJson(text)
  if (match === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(match)
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  const decisions = (raw as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions)) return []
  const result: ReflectionDecision[] = []
  for (const item of decisions) {
    const parsed = parseDecisionItem(item)
    if (parsed !== undefined) result.push(parsed)
  }
  return result
}

/**
 * 已收敛至 scoring.jaccard：本地 jaccardOf / jaccardWithOverlap 已删除，
 * selectReflectionPairs 内直接以 tokenize + scoring.jaccard 计算并另计 overlap。
 */

/**
 * 选取反思焦点 + 各自的候选对比条目（纯函数语义 + 协作式让出，供测试）。
 *
 * P0 卡死修复（2026-08-20 用户拍板方案 B）：
 * - 旧实现每对 pairSim 内联调用 embedding.getVector()（每次一条 SQLite vec0 虚拟表
 *   查询，2560 维 ≈10KB BLOB，实测 ~260µs/次）与 tokenize()（jieba 同步分词），
 *   O(n²)=~17.6 万次调用致主线程冻结实测 45.8s（test/reflect-bench.test.ts 场景 D）；
 * - 现改为【预取层】：向量每条目至多取一次（Map 缓存）、范数预计算（余弦由 3 次遍历
 *   降为单次点积，累加顺序与 cosineSimilarity 一致保证结果位级相同）、token 惰性
 *   预取每条目至多切一次——O(n²) 内循环零 IO、零分词；
 * - 【协作式让出】：每 REFLECT_YIELD_ROWS 行 await setImmediate 挂起一次宏任务，
 *   任意窗口规模下宿主事件循环单次停顿有界（本函数因此为 async）。
 *
 * - 焦点策略（2026-08-18 实证修复 + C34 语义门 + 2026-08-18 调优）：
 *   ① 焦点 = window 内"存在 ≥1 个合格对比对"的条目，按【最强对相似度降序 → 重要度
 *      降序 → 创建时间倒序 → id 稳定】取前 REFLECT_FOCUS_BUDGET；无 peer 的孤条目
 *      不占焦点（无对可审，喂 LLM 纯浪费 token）。
 *   ② 对级合格判定（相似度来源二选一）：
 *      - 双侧有向量（embedding.getVector）→ **语义余弦 ≥ 按维度区分的阈值
 *        (384→0.72, 其他→0.75)**（2026-08-18 调优：技术文档类 paraphrase 实测
 *        0.70-0.78 区间，本地小模型需更宽松）；
 *      - 任一侧无向量 → 回退 token-Jaccard ∈ [0.08, 0.85) 且 overlap≥2（2026-08-18
 *        调优：下界由 0.15 降至 0.08 召回短文本如 "pnpm workspace"；重合≥2 防噪声）。
 * - 每焦点的 peers = 同 workspace 合格对，按相似度降序取前 REFLECT_PEERS_PER_FOCUS。
 * 注意：≥0.85（Jaccard）由既有规则合并/覆盖域处理，本函数只补盲区。
 */
export const REFLECT_YIELD_ROWS = 16

/** 让出事件循环：setImmediate 宏任务（无 setTimeout 的 ≥1ms 钳制，让出粒度最细） */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function selectReflectionPairs(
  entries: MemoryEntry[],
  embedding?: { getVector(id: string): Float32Array | undefined },
  opts?: {
    /** 分片让出行数（默认 REFLECT_YIELD_ROWS；测试可注入更小值驱动多轮让出） */
    yieldEveryRows?: number
    /**
     * 焦点资格集（水位线增量反思用）：提供时仅集合内条目可作焦点（peer 资格不变）。
     * 缺省 = 全部条目可作焦点。空集 ⇒ 无焦点 ⇒ 调用方自然走"无新增候选"快路径。
     */
    focusEligible?: ReadonlySet<string>
  },
): Promise<Array<{ focus: MemoryEntry; peers: MemoryEntry[] }>> {
  const yieldEvery = Math.max(1, opts?.yieldEveryRows ?? REFLECT_YIELD_ROWS)
  // ── 预取层①：向量每条目至多一次 getVector（旧实现每对 2 次 ≈ 数万次 SQL）。
  // 预取本身也分片让出：400 次 vec0 查询同步执行实测 ~104ms 停顿，每 128 条挂起一次
  // 宏任务后单段停顿降至 ~33ms 以内（与行扫描让出同粒度策略）。──
  const vectors = new Map<string, Float32Array | undefined>()
  if (embedding !== undefined) {
    let fetched = 0
    for (const entry of entries) {
      vectors.set(entry.id, embedding.getVector(entry.id))
      if (++fetched % 128 === 0) await yieldToEventLoop()
    }
  }
  // ── 预取层②：范数预计算（累加顺序与 cosineSimilarity 的 na/nb 循环一致，
  // dot/sqrt(na)/sqrt(nb) 数学恒等 ⇒ sim 与旧实现位级相同，阈值行为不漂移）──
  const norms = new Map<string, number>()
  for (const [id, vec] of vectors) {
    if (vec === undefined) continue
    let sumSq = 0
    for (let i = 0; i < vec.length; i++) sumSq += vec[i]! * vec[i]!
    norms.set(id, Math.sqrt(sumSq))
  }
  // ── 预取层③：token 惰性缓存（Jaccard 回退路径每条目至多切一次 jieba）──
  const tokens = new Map<string, Set<string>>()
  const tokensOf = (entry: MemoryEntry): Set<string> => {
    const cached = tokens.get(entry.id)
    if (cached !== undefined) return cached
    const fresh = new Set(tokenize(`${entry.content} ${entry.tags.join(' ')}`))
    tokens.set(entry.id, fresh)
    return fresh
  }
  // 对级相似度：{ sim 排序值, ok 是否合格 }。双侧有预取向量 → 余弦（阈值按维度区分）；否则 Jaccard+overlap。
  const pairSim = (a: MemoryEntry, b: MemoryEntry): { sim: number; ok: boolean } => {
    const va = vectors.get(a.id)
    const vb = vectors.get(b.id)
    if (va !== undefined && vb !== undefined) {
      // 单次点积 + 预计算范数（与 cosineSimilarity 全等的数学分解，见预取层②注释）
      const len = Math.min(va.length, vb.length)
      let dot = 0
      for (let i = 0; i < len; i++) dot += va[i]! * vb[i]!
      const denom = (norms.get(a.id) ?? 0) * (norms.get(b.id) ?? 0)
      const sim = denom === 0 ? 0 : dot / denom
      // 2026-08-18 调优：阈值按模型维度区分（向量长度判断：384→0.72, 其他→0.75）
      // 显式降级语义+中文注释：非防御性兜底，维度即模型身份
      // 若两向量维度不一致（极端异常），取更严格者（显式说明不一致时的取严策略）
      const finalThreshold = Math.max(getSemanticThresholdForDim(va.length), getSemanticThresholdForDim(vb.length))
      return { sim, ok: sim >= finalThreshold }
    }
    // 收敛至 scoring.jaccard：复用预取 token 集合（每条目至多 tokenize 一次），并另计 overlap 满足辅助门
    const setA = tokensOf(a)
    const setB = tokensOf(b)
    let overlap = 0
    for (const token of setA) if (setB.has(token)) overlap++
    const j = jaccard(setA, setB)
    // 2026-08-18 调优：下界 0.08 + overlap≥2 双门控
    return { sim: j, ok: j >= PEER_MIN_JACCARD && j < PEER_MAX_JACCARD && overlap >= PEER_MIN_TOKEN_OVERLAP }
  }
  // 每条目 → 其同 workspace 最强合格对相似度（maxSim；无合格对为 0，不参与焦点）
  const maxSim = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]
    if (a === undefined) continue
    for (let k = i + 1; k < entries.length; k++) {
      const b = entries[k]
      if (b === undefined || a.workspace !== b.workspace) continue
      const { sim, ok } = pairSim(a, b)
      if (ok) {
        const set = (id: string) => maxSim.set(id, Math.max(maxSim.get(id) ?? 0, sim))
        set(a.id)
        set(b.id)
      }
    }
    // 协作式让出：每 yieldEvery 行挂起一次宏任务（宿主事件循环保持响应）
    if ((i + 1) % yieldEvery === 0) await yieldToEventLoop()
  }
  const focusList = entries
    .filter((entry) => (maxSim.get(entry.id) ?? 0) > 0)
    // 水位线增量：仅资格集内条目可作焦点（缺省全量；peer 不受限）
    .filter((entry) => opts?.focusEligible?.has(entry.id) ?? true)
    .sort(
      (a, b) =>
        (maxSim.get(b.id) ?? 0) - (maxSim.get(a.id) ?? 0) ||
        b.importance - a.importance ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, REFLECT_FOCUS_BUDGET)
  const result: Array<{ focus: MemoryEntry; peers: MemoryEntry[] }> = []
  for (let fi = 0; fi < focusList.length; fi++) {
    const focus = focusList[fi]
    if (focus === undefined) continue
    const scored: Array<{ peer: MemoryEntry; sim: number }> = []
    for (const entry of entries) {
      if (entry.id === focus.id) continue
      // 跨 workspace 不构成对比对（Q6⑦ 拍板）：LLM 只审同 workspace 内的语义近重复/
      // 矛盾——跨域对在 applyDecision 也会被 skip，喂 LLM 纯属浪费 token。
      if (entry.workspace !== focus.workspace) continue
      const { sim, ok } = pairSim(focus, entry)
      if (ok) scored.push({ peer: entry, sim })
    }
    scored.sort((x, y) => y.sim - x.sim)
    result.push({ focus, peers: scored.slice(0, REFLECT_PEERS_PER_FOCUS).map((s) => s.peer) })
    // 焦点复核阶段同样协作式让出（foci×entries 仍可达数千次点积）
    if ((fi + 1) % yieldEvery === 0) await yieldToEventLoop()
  }
  return result
}

/** 渲染单条条目为紧凑行（含完整 id 以便裁决可定位——trade-off 见模块头） */
function formatEntry(label: string, entry: MemoryEntry): string {
  const content = entry.content.replace(/\s+/g, ' ').slice(0, 200)
  return `- ${label} #${entry.id} kind=${entry.kind} content=${content}`
}

/** 把 focus+peers 渲染为提示词文本（仅渲染有 peer 的焦点，无 peer 无判定依据） */
function renderReflectionText(pairs: Array<{ focus: MemoryEntry; peers: MemoryEntry[] }>): string {
  const lines: string[] = []
  for (const { focus, peers } of pairs) {
    if (peers.length === 0) continue
    lines.push(formatEntry('焦点', focus))
    for (const peer of peers) lines.push(formatEntry('对比', peer))
  }
  return lines.join('\n')
}

/** 新者判定：createdAt 大者为新，同刻按 id 字典序大者为新（tie-breaker 与 maintenance 一致） */
function newerOf(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  return a.createdAt === b.createdAt ? (a.id >= b.id ? a : b) : a.createdAt > b.createdAt ? a : b
}

/**
 * 反思任务。maintenance 自动调用（带周期门控）；工具/RPC 手动触发可置 force。
 * 全程自收容：任何异常 warn 后返回 undefined，失败不更新 lastRunAt/route 缓存。
 */
export class MemoryReflector {
  private readonly deps: ReflectionDeps
  /** 上次成功执行时刻（ISO；未运行 null） */
  private lastRunAtValue: string | null = null
  /** 上次成功执行时刻（ms，周期门控用） */
  private lastRunAtMs: number | null = null
  /** 缓存的上次 route（路由缺省时回退） */
  private lastRoute: { provider: string; model: string } | undefined
  /** 最近一次成功执行的观察量（memory_status/RPC status 透出；未运行 null） */
  private lastSummaryValue: ReflectionSummary | null = null
  /** 2b：跨轮累计观测量（轻量质量钩子，见 ReflectionCumulative 说明；进程内态） */
  private cumulativeValue: ReflectionCumulative = { runs: 0, decisions: 0, merged: 0, archived: 0, skipped: 0, emptyRounds: 0 }
  /**
   * 水位线游标（P1）：上次成功反思窗口最新条目 (createdAt,id)。
   * 懒加载自 metaTable（跨重启持久）；未注入 metaTable 时恒 null（水位线关闭）。
   */
  private reflectCursorValue: { createdAt: string; id: string } | null = null
  /** 游标是否已尝试懒加载（防每轮重复读表） */
  private cursorLoaded = false

  constructor(deps: ReflectionDeps) {
    this.deps = deps
  }

  /** 当前水位线游标（可观测；未注入 metaTable 或从未成功反思时 null） */
  get reflectCursor(): { createdAt: string; id: string } | null {
    return this.reflectCursorValue
  }

  /** 懒加载持久化游标（首次 runOnce 前执行一次；损坏/缺失不阻断，视为无水位线） */
  private loadCursorIfNeeded(): void {
    if (this.cursorLoaded) return
    this.cursorLoaded = true
    const meta = this.deps.metaTable
    if (meta === undefined) return
    try {
      const raw = meta.get(REFLECT_CURSOR_KEY)
      if (raw === undefined || raw === null || raw === '') return
      const parsed = JSON.parse(raw as unknown as string) as { createdAt?: unknown; id?: unknown }
      if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
        this.reflectCursorValue = { createdAt: parsed.createdAt, id: parsed.id }
      }
    } catch (error) {
      // 损坏游标仅告警并按"无水位线"处理（下轮全窗复审后重写游标自愈）
      this.deps.logger.warn('[dsh-memory] 反思水位线游标损坏（按无水位线处理）：', error)
    }
  }

  /** 推进并持久化游标为窗口最新条目（listRecent 首位）；空窗口/未注表不动作。失败仅告警。 */
  private async advanceCursorToNewest(candidates: MemoryEntry[]): Promise<void> {
    const newest = candidates[0]
    if (newest === undefined) return
    this.reflectCursorValue = { createdAt: newest.createdAt, id: newest.id }
    const meta = this.deps.metaTable
    if (meta === undefined) return
    try {
      await meta.put(REFLECT_CURSOR_KEY, JSON.stringify(this.reflectCursorValue))
    } catch (error) {
      this.deps.logger.warn('[dsh-memory] 反思水位线持久化失败（下轮可能重复审旧窗口）：', error)
    }
  }

  /** 最近一次成功执行时刻 ISO（未运行 null） */
  get lastRunAt(): string | null {
    return this.lastRunAtValue
  }

  /** 最近一次成功执行的观察量（审/决/合并/归档/跳过；未运行 null） */
  get lastSummary(): ReflectionSummary | null {
    return this.lastSummaryValue
  }

  /** 2b：跨轮累计观测量（透出用；重启归零） */
  get cumulativeSummary(): ReflectionCumulative {
    return this.cumulativeValue
  }

  /**
   * 执行一个反思批次。route 缺省回退缓存的上次 route；无可用 route 且无缓存则
   * warn 并返回 undefined（RPC 无会话场景）。
   */
  /** 重入互斥：当前运行中的批次 promise（定时 + 手动 force 并发合并为一次执行） */
  private running: Promise<ReflectionSummary | undefined> | undefined

  /**
   * 执行一个反思批次。route 缺省回退缓存的上次 route；无可用 route 且无缓存则
   * warn 并返回 undefined（RPC 无会话场景）。
   * 重入互斥（Q6④ 拍板）：并发调用合并为一次——已有批次在运行则返回同一 promise，
   * 避免对同一对重复归档/合并产生重复审计；周期门控在异步体内仍各自生效。
   */
  runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }): Promise<ReflectionSummary | undefined> {
    // 重入互斥：已有批次在运行 → 返回同一 promise（合并并发，不重复执行）
    if (this.running !== undefined) return this.running
    // 并发方（含首个）都拿到同一个 run 引用——外层不能是 async 包装（async 函数会
    // 产生新的 promise 身份，破坏"合并为一次"的身份语义与测试断言）。
    const run = (async (): Promise<ReflectionSummary | undefined> => {
      const force = opts?.force ?? false
      // 周期门控：非强制且距上次成功执行未满间隔 → 直接返回（不打 LLM）
      if (!force && this.lastRunAtMs !== null && this.deps.now() - this.lastRunAtMs < REFLECT_INTERVAL_MS) {
        return undefined
      }
      const resolved = route ?? this.lastRoute
      if (resolved === undefined) {
        this.deps.logger.warn('[dsh-memory] 无可用模型路由，跳过反思（RPC 无会话场景）')
        return undefined
      }
      // 水位线懒加载（P1）：自动路径以游标为焦点下界（只审新增）；force 全窗复审
      this.loadCursorIfNeeded()
      try {
        const summary = await this.runReflection(resolved, { focusNewerThan: force ? undefined : this.reflectCursorValue })
        const nowIso = new Date(this.deps.now()).toISOString()
        this.lastRunAtValue = nowIso
        this.lastRunAtMs = this.deps.now()
        this.lastRoute = resolved
        this.lastSummaryValue = summary
        // 2b：仅成功路径累加累计观测量（失败批不计入，防噪声）
        this.cumulativeValue.runs++
        this.cumulativeValue.decisions += summary.decisions
        this.cumulativeValue.merged += summary.merged
        this.cumulativeValue.archived += summary.archived
        this.cumulativeValue.skipped += summary.skipped
        // 连续空轮计数：reviewed>0 且 decisions==0 递增，命中非空重置；reviewed==0 正常空不计
        if (summary.reviewed > 0 && summary.decisions === 0) {
          this.cumulativeValue.emptyRounds++
        } else if (summary.decisions > 0) {
          this.cumulativeValue.emptyRounds = 0
        }
        return summary
      } catch (error) {
        this.deps.logger.warn('[dsh-memory] 反思批次执行失败：', error)
        return undefined
      }
    })()
    // 失败清理钩子：批次体自收容（logger.warn）不会 reject，finally 派生态无拒绝；
    // 比对引用才复位（与 maintenance.runOnce 同模式）——并发方已被合并到同一 run，
    // 引用不变则复位；若被替换则不覆盖别人的 promise，保证互斥不早破。
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = undefined
    })
    return run
  }

  /**
   * 执行反思主体：拉候选 → 选焦点对 → 渲染 → LLM 批次 → 逐条执行。
   * opts.focusNewerThan（P1 水位线）：提供时仅严格新于该游标的条目可作焦点
   * （(createdAt,id) 字典序比较，与 listRecent 排序/maintenance 游标同语义）；
   * peer 仍取全窗——旧条目可作为新焦点的对比上下文。成功结束（含执行完裁决）
   * 后把游标推进为窗口最新条目；LLM 失败抛出走 runOnce 的 catch，游标不动。
   */
  private async runReflection(
    route: { provider: string; model: string },
    opts?: { focusNewerThan?: { createdAt: string; id: string } | null },
  ): Promise<ReflectionSummary> {
    const candidates = this.deps.store.listRecent(REFLECT_WINDOW, 'active')
    // hot-swap 守卫：优先用 getter（延迟读 holder.index），回退静态 embedding
    const embeddingIndex = this.deps.getEmbeddingIndex?.() ?? this.deps.embedding
    // 水位线增量：计算焦点资格集（严格新于游标）；空集 ⇒ 无焦点 ⇒ 自然走零 LLM 快路径
    let focusEligible: ReadonlySet<string> | undefined
    const floor = opts?.focusNewerThan
    if (floor !== undefined && floor !== null) {
      focusEligible = new Set(
        candidates
          .filter((e) => e.createdAt > floor.createdAt || (e.createdAt === floor.createdAt && e.id > floor.id))
          .map((e) => e.id),
      )
      if (focusEligible.size === 0) {
        this.deps.logger.info(
          `[dsh-memory] 反思水位线：窗口 ${candidates.length} 条均不新于游标（${floor.createdAt}/${floor.id.slice(0, 8)}），跳过本轮不打 LLM`,
        )
      }
    }
    const pairs = await selectReflectionPairs(candidates, embeddingIndex, { focusEligible })
    const reviewed = pairs.filter((pair) => pair.peers.length > 0).length
    // 可观测：向量覆盖率（语义救援能力的直观度量）
    // 2026-08-18 调优：向量覆盖仅 21.8% 时双侧命中 p²≈3.5%，救援失效；暴露覆盖率便于
    // 诊断“为何语义未命中”（semanticHitRate 低 → 需补齐嵌入而非调阈值）。
    let semanticHitRate: number | undefined
    if (embeddingIndex !== undefined) {
      let withVec = 0
      for (const entry of candidates) {
        if (embeddingIndex.getVector(entry.id) !== undefined) withVec++
      }
      semanticHitRate = candidates.length === 0 ? 0 : withVec / candidates.length
      // 直方图日志（低成本可观测）：覆盖率 + 窗口利用率
      this.deps.logger.info(
        `[dsh-memory] 反思候选直方图：窗口=${candidates.length}/${REFLECT_WINDOW} 向量覆盖=${(semanticHitRate * 100).toFixed(1)}% 焦点=${reviewed}/${pairs.length}`,
      )
      // 阈值自适应：基于 hitRate 动态调整本地语义阈值并透出日志（memory_status/semanticHitRate 驱动）
      if (semanticHitRate !== undefined) {
        const adjusted = adjustThresholdByHitRate(semanticHitRate)
        this.deps.logger.info(`[dsh-memory] 语义阈值自适应：hitRate=${(semanticHitRate * 100).toFixed(1)}% 阈值→${adjusted}`)
      }
    }
    const summary: ReflectionSummary = {
      reviewed,
      decisions: 0,
      merged: 0,
      archived: 0,
      skipped: 0,
      ...(semanticHitRate !== undefined ? { semanticHitRate } : {}),
    }
    if (reviewed === 0) return summary

    // P2 多批流水线（2026-08-20 用户拍板完整方案 B）：有 peer 的焦点按
    // REFLECT_BATCH_SIZE 切批，每批独立一次 LLM 调用；批间串行——applyDecision
    // 的 getById 重读保证前一批归档/合并后下一批看到最新状态（防重复动作）。
    const batches: Array<Array<{ focus: MemoryEntry; peers: MemoryEntry[] }>> = []
    for (const pair of pairs) {
      if (pair.peers.length === 0) continue // 无对可审的孤焦点不入批（喂 LLM 纯浪费）
      const last = batches[batches.length - 1]
      if (last !== undefined && last.length < REFLECT_BATCH_SIZE) last.push(pair)
      else batches.push([pair])
    }
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!
      const text = renderReflectionText(batch)
      const decisions = await this.callLlm(route, text, batch.length)
      summary.decisions += decisions.length
      for (const decision of decisions) {
        await this.applyDecision(decision, summary)
      }
      // 批次直方图日志（低成本可观测）：定位"哪一批 0 产出"（模型保守/提示词不足归因）
      this.deps.logger.info(`[dsh-memory] 反思批次 ${bi + 1}/${batches.length}：焦点=${batch.length} 裁决=${decisions.length}`)
    }
    // 水位线推进（P1）：本轮窗口已审毕，游标 = 窗口最新条目；失败路径不会到达此处
    await this.advanceCursorToNewest(candidates)
    return summary
  }

  /** 单次 LLM 调用：组装消息 → 流式 → 组装 → 解析 */
  private async callLlm(route: { provider: string; model: string }, text: string, reviewed: number): Promise<ReflectionDecision[]> {
    const userMessage: Message = createUserMessage({
      content: [{ type: 'text', text: `以下是待审视的记忆条目对：\n\n${text}\n\n${REFLECT_USER_RULES}` }],
      source: { kind: 'plugin', plugin: MEMORY_PLUGIN_ID },
    })
    const assembler = new BlockAssembler()
    for await (const chunk of this.deps.llm.stream({
      provider: route.provider,
      model: route.model,
      system: REFLECTION_SYSTEM_PROMPT,
      messages: [userMessage],
      maxTokens: REFLECT_MAX_TOKENS,
    })) {
      assembler.push(chunk)
    }
    const finishKind = assembler.finish.kind
    if (finishKind === 'aborted' || finishKind === 'error') {
      throw new Error(`反思调用未正常完成（${finishKind} finish）`)
    }
    const textOut = assembler
      .blocks()
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
    const decisions = parseReflectionDecisions(textOut)
    // 2026-08-18 实证修复（可观测性）：畸形/跑题的 LLM 输出（如通篇无 decisions 字段）
    // 会被解析器静默当 0 裁决——与"诚实判无动作"不可区分，掩盖模型质量问题。
    // 非空但无 decisions 字段 → 显式 warn（合法 `{"decisions":[]}` 不触发）。
    if (textOut.trim().length > 0 && !textOut.includes('decisions')) {
      this.deps.logger.warn(
        `[dsh-memory] 反思输出未含 decisions 字段，按 0 裁决处理（原文片段：${textOut.trim().slice(0, 120)}）`,
      )
    }
    // 0 产出告警：reviewed>0 却 0 裁决需关注（可能模型保守或提示词不足）；reviewed==0 正常空不告警
    if (decisions.length === 0 && reviewed > 0) {
      this.deps.logger.warn(`[dsh-memory] 反思 0 产出告警：审 ${reviewed} 条焦点但 LLM 未返回有效裁决（decisions=0，reviewed>0 需关注）`)
    }
    return decisions
  }

  /**
   * 逐条执行前必须重读两条目（防归档/被覆盖竞态）：任一缺失/非 active/被
   * supersededBy 标记/跨 workspace → 计入 skipped 并跳过。单条失败 warn 继续。
   */
  private async applyDecision(decision: ReflectionDecision, summary: ReflectionSummary): Promise<void> {
    const focus = this.deps.store.getById(decision.focusId)
    const peer = this.deps.store.getById(decision.peerId)
    if (focus === undefined || peer === undefined) {
      summary.skipped++
      return
    }
    if (focus.status !== 'active' || peer.status !== 'active') {
      summary.skipped++
      return
    }
    if (focus.supersededBy !== undefined || peer.supersededBy !== undefined) {
      summary.skipped++
      return
    }
    if (focus.workspace !== peer.workspace) {
      summary.skipped++
      return
    }
    if (decision.action === 'none') {
      summary.skipped++
      return
    }
    const newer = newerOf(focus, peer)
    const older = newer.id === focus.id ? peer : focus
    try {
      if (decision.action === 'merge') {
        if (older.importance > newer.importance) {
          await this.deps.store.update(newer.id, { importance: older.importance }, 'system')
        }
        // 依据引用进审计 detail（store.archive 已扩展可选 detail；短 id 与工具渲染一致）
        await this.deps.store.archive(older.id, 'system', `LLM 反思合并（语义近似重复）：保留 #${newer.id.slice(0, 8)}——${decision.reason}`)
        summary.merged++
      } else {
        await this.deps.store.archive(older.id, 'system', `LLM 反思归档（跨条目矛盾）：保留 #${newer.id.slice(0, 8)}——${decision.reason}`)
        summary.archived++
      }
    } catch (error) {
      this.deps.logger.warn(`[dsh-memory] 反思执行失败（${focus.id}/${peer.id}）：`, error)
      summary.skipped++
    }
  }
}
