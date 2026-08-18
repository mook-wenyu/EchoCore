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
 * 任务 a）与 create 的 supersede（≥0.7）——本模块只补 [0.15, 0.85) 的语义盲区。
 */

import { BlockAssembler, createUserMessage, type LlmRuntime, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

import { cosineSimilarity } from './embed-index.js'
import { MEMORY_PLUGIN_ID } from './constants.js'
import { tokenize } from './scoring.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/** 自动周期门控：距上次成功执行未满该间隔则跳过（不打 LLM） */
export const REFLECT_INTERVAL_MS = 6 * 3_600_000

/** 候选窗口：listRecent 拉取量（只审最新前 N 条，控制单次负载） */
export const REFLECT_WINDOW = 200

/** 每批「焦点」条目数上限 */
export const REFLECT_FOCUS_BUDGET = 20

/** 每个焦点的候选对比条目数 */
export const REFLECT_PEERS_PER_FOCUS = 3

/**
 * C34（2026-08-18 拍板）：语义合并门——双侧有向量时 cosine ≥ 该值才算候选对
 * （对齐 ai-memory `CONSOLIDATE_COSINE_THRESHOLD=0.75`：抓语义近等价表述，
 * 不并仅主题相邻；任一侧无向量 → 回退 token-Jaccard 带）。随 C33 覆盖补齐扩大生效。
 */
export const REFLECT_SEMANTIC_THRESHOLD = 0.75

/** LLM 输出上限 */
export const REFLECT_MAX_TOKENS = 1024

/** peer 相似带下界：低于此值语义关联太弱，交由纯函数时剔除 */
const PEER_MIN_JACCARD = 0.15

/** peer 相似带上界：≥ 此值属既有规则合并域（maintenance 任务 a），本模块不重复 */
const PEER_MAX_JACCARD = 0.85

/** 反思依赖（store/llm/logger/now 注入，便于单测） */
export interface ReflectionDeps {
  store: MemoryStore
  llm: Pick<LlmRuntime, 'stream'>
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
  now: () => number
  /** C34：语义门取向量（有向量时 cosine≥0.75 为主门；缺省无向量 → Jaccard 带回退） */
  embedding?: { getVector(id: string): Float32Array | undefined }
}

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
}

/** 反思系统提示词（只判定近似重复/矛盾，禁止其它动作） */
const REFLECTION_SYSTEM_PROMPT = `你是一个记忆反思器，审视已有记忆条目之间的语义近似重复与跨条目矛盾。

判断规则：
1. 语义近似重复（action: merge）：两条记忆表述同一事实，仅措辞/详略不同（token 重合度低于既有规则的 0.85 合并域）。
2. 矛盾（action: archive）：两条记忆针对同一主题给出相互冲突的结论。
3. 无关或不足以判定（action: none）。

禁止：
- 不得建议改写任何记忆内容、调整重要性、或新建/合成新记忆。
- 只允许在两个都来自记忆库（都有来源引用）的条目之间判定。
- 每条裁决必须引用 focus 与 peer 的完整 id（#<id>）。

输出严格 JSON（不要输出任何其他文字）：
{"decisions":[{"focusId":"<focus 完整 id>","peerId":"<peer 完整 id>","action":"merge|archive|none","reason":"简短中文理由"}]}
没有需要处理的输出：{"decisions":[]}`

/** 反思用户消息尾部指令 */
const REFLECT_USER_RULES = `请依据上述规则审视下列记忆条目对，只输出 JSON。`

/** 从文本中提取第一个平衡的 JSON 对象（跳过字符串内的花括号；与 extract.ts 同思路） */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

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
 * 纯函数：条目对 token 集合 Jaccard（0..1），与 store.tokenJaccard 分词语义一致
 * （tokenize(content + tags)）。selectReflectionPairs 为纯函数（签名不含 store），
 * 故本地复用 tokenize 保证确定性可测，语义对齐 store 的 token 缓存。
 */
function jaccardOf(a: MemoryEntry, b: MemoryEntry): number {
  const setA = new Set(tokenize(`${a.content} ${a.tags.join(' ')}`))
  const setB = new Set(tokenize(`${b.content} ${b.tags.join(' ')}`))
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 选取反思焦点 + 各自的候选对比条目（纯函数，供测试）。
 * - 焦点策略（2026-08-18 实证修复 + C34 语义门）：
 *   ① 焦点 = window 内"存在 ≥1 个合格对比对"的条目，按【最强对相似度降序 → 重要度
 *      降序 → 创建时间倒序 → id 稳定】取前 REFLECT_FOCUS_BUDGET；无 peer 的孤条目
 *      不占焦点（无对可审，喂 LLM 纯浪费 token）。
 *   ② 对级合格判定（相似度来源二选一）：
 *      - 双侧有向量（embedding.getVector）→ **语义余弦 ≥ REFLECT_SEMANTIC_THRESHOLD
 *        (0.75)**（C34，对齐 ai-memory CONSOLIDATE_COSINE_THRESHOLD：抓语义近等价
 *        表述，不并仅主题相邻；token 重合低但语义同义的改写也能入审）；
 *      - 任一侧无向量 → 回退 token-Jaccard ∈ [0.15, 0.85)（既有带）。
 * - 每焦点的 peers = 同 workspace 合格对，按相似度降序取前 REFLECT_PEERS_PER_FOCUS。
 * 注意：≥0.85（Jaccard）由既有规则合并/覆盖域处理，本函数只补盲区。
 */
export function selectReflectionPairs(
  entries: MemoryEntry[],
  embedding?: { getVector(id: string): Float32Array | undefined },
): Array<{ focus: MemoryEntry; peers: MemoryEntry[] }> {
  // 对级相似度：{ sim 排序值, ok 是否合格 }。双侧向量 → 余弦；否则 Jaccard。
  const pairSim = (a: MemoryEntry, b: MemoryEntry): { sim: number; ok: boolean } => {
    const va = embedding?.getVector(a.id)
    const vb = embedding?.getVector(b.id)
    if (va !== undefined && vb !== undefined) {
      const sim = cosineSimilarity(va, vb)
      return { sim, ok: sim >= REFLECT_SEMANTIC_THRESHOLD }
    }
    const j = jaccardOf(a, b)
    return { sim: j, ok: j >= PEER_MIN_JACCARD && j < PEER_MAX_JACCARD }
  }
  // 每条目 → 其同 workspace 最强合格对相似度（maxSim；无合格对为 0，不参与焦点）
  const maxSim = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    for (let k = i + 1; k < entries.length; k++) {
      const a = entries[i]
      const b = entries[k]
      if (a === undefined || b === undefined || a.workspace !== b.workspace) continue
      const { sim, ok } = pairSim(a, b)
      if (ok) {
        const set = (id: string) => maxSim.set(id, Math.max(maxSim.get(id) ?? 0, sim))
        set(a.id)
        set(b.id)
      }
    }
  }
  const focusList = entries
    .filter((entry) => (maxSim.get(entry.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (maxSim.get(b.id) ?? 0) - (maxSim.get(a.id) ?? 0) ||
        b.importance - a.importance ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, REFLECT_FOCUS_BUDGET)
  const result: Array<{ focus: MemoryEntry; peers: MemoryEntry[] }> = []
  for (const focus of focusList) {
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
  private cumulativeValue: ReflectionCumulative = { runs: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }

  constructor(deps: ReflectionDeps) {
    this.deps = deps
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
      try {
        const summary = await this.runReflection(resolved)
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

  /** 执行反思主体：拉候选 → 选焦点对 → 渲染 → 单次 LLM → 逐条执行 */
  private async runReflection(route: { provider: string; model: string }): Promise<ReflectionSummary> {
    const candidates = this.deps.store.listRecent(REFLECT_WINDOW, 'active')
    const pairs = selectReflectionPairs(candidates, this.deps.embedding)
    const reviewed = pairs.filter((pair) => pair.peers.length > 0).length
    const summary: ReflectionSummary = { reviewed, decisions: 0, merged: 0, archived: 0, skipped: 0 }
    if (reviewed === 0) return summary

    const text = renderReflectionText(pairs)
    const decisions = await this.callLlm(route, text)
    summary.decisions = decisions.length
    for (const decision of decisions) {
      await this.applyDecision(decision, summary)
    }
    return summary
  }

  /** 单次 LLM 调用：组装消息 → 流式 → 组装 → 解析 */
  private async callLlm(route: { provider: string; model: string }, text: string): Promise<ReflectionDecision[]> {
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
