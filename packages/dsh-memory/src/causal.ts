/**
 * @module @echocore/dsh-memory/causal
 *
 * 因果链模块：在维护周期内批量增量抽取记忆条目之间的"因果/衍生/前提-结果"关系，
 * 以独立边表持久化，供审计展示（v1 检索保守，不沿链扩散）。
 *
 * 数据模型决策：
 * - **独立边表**（memory_causal_edges，KvTable 键值）：不污染既有 MemoryEntry JSON
 *   主记录，审计/展示按需查询。键 = causalEdgeKey(sourceId, targetId, relation)
 *   （`src\0rel\0tgt`，防 id 撞前缀）。
 * - **抽取时机**：维护周期批量增量——每次对最近窗口重扫，靠幂等键天然增量
 *   （已存在边跳过），不做全量图构建。
 * - **检索利用保守**：v1 只用于审计展示，不做沿链扩散/图遍历——本项目因果模块
 *   只负责建边/查询/清理，检索改动是主代理的事。
 *
 * 说明（YAGNI）：本模块不做环检测/图遍历/沿链聚合——留待未来真实图遍历需求
 * （如"因果链推理注入"）出现时再引入。当前仅提供建边/装订查询/孤儿清理。
 *
 * 自收容：runOnce 全程 catch → warn，异常不逃逸（后台任务工程必需）；
 * 失败不更新 lastRunAt / route 缓存。
 */

import {
  BlockAssembler,
  createUserMessage,
  type LlmRuntime,
  type Message,
} from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import { MEMORY_PLUGIN_ID } from './constants.js'
import type { MemoryStore } from './store.js'
import type { AuditRecord, CausalRelation, MemoryCausalEdge, MemoryEntry, MemorySource } from './types.js'

/** 自动周期门控间隔（ms；建议 6 小时） */
export const CAUSAL_INTERVAL_MS = 6 * 3_600_000
/** 候选窗口（listRecent 拉取量；建议 200） */
export const CAUSAL_WINDOW = 200
/** 进入提示词的条目数上限（建议 30） */
export const CAUSAL_BUDGET = 30
/** 建边置信下限（LLM 自评 confidence < 0.6 不建边） */
export const CAUSAL_MIN_CONFIDENCE = 0.6
/** LLM 输出 token 上限 */
export const CAUSAL_MAX_TOKENS = 1024

/** 因果抽取系统提示词：只找因果/衍生关系，约束方向与输出格式 */
const CAUSAL_SYSTEM_PROMPT = `你是一个记忆因果分析器。给定一批记忆条目（每条以 #id 开头），找出条目之间存在的因果/衍生/前提-结果关系对。

规则：
1. 只对列表内存在（有 #id）的条目之间建边；禁止自环（sourceId 必须 ≠ targetId）
2. 方向语义：source 是因/前提，target 是果/结果
3. 为每个关系给出 confidence（0-1，自评把握度）与一句 justification（依据摘要）
4. 只输出 JSON，不要输出任何其他文字：
{"edges":[{"sourceId":"...","targetId":"...","confidence":0.9,"justification":"..."}]}
没有关系时输出：{"edges":[]}`

/** 一次因果抽取批次的结果统计 */
export interface CausalSummary {
  /** 进入提示词的条目数 */
  reviewed: number
  /** LLM 提出的边数 */
  edges: number
  /** 实际新建成边数 */
  created: number
  /** 拒绝建边数（自环/未知 id/非 active/跨 workspace/置信<0.6/已存在） */
  skipped: number
}

/** 因果抽取依赖（store/边表/llm/logger/now 注入，便于单测） */
export interface CausalExtractorDeps {
  store: MemoryStore
  causal: MemoryCausalStore
  llm: Pick<LlmRuntime, 'stream'>
  logger: Pick<ReturnType<import('@deepseek-ai/cordis').Context['logger']>, 'warn' | 'info'>
  now: () => number
}

/** 当前模型路由缓存（route 缺省时的回退；成功批次后更新） */
interface Route {
  provider: string
  model: string
}

/** 单条建边入参（调用方需已用 store 校验 source/target 存在且 active） */
export interface CausalInput {
  sourceId: string
  targetId: string
  relation: CausalRelation
  confidence: number
  source: MemorySource
}

/**
 * 复合主键：`${sourceId}\0${relation}\0${targetId}`。
 * 以 \0 分隔——id 本身不放 \0 字符，防止源 id 前缀撞车（如 "ab"+"cd" vs "ab\\0c"+"d"）。
 */
export function causalEdgeKey(sourceId: string, targetId: string, relation: CausalRelation): string {
  return `${sourceId}\u0000${relation}\u0000${targetId}`
}

/**
 * 因果边存取（独立边表封装）。
 * 幂等建边（add-only）：键已存在 → 跳过返回 undefined——不覆盖，防 LLM 抖动改写证据。
 */
export class MemoryCausalStore {
  constructor(
    private readonly table: KvTable<string, MemoryCausalEdge>,
    private readonly now: () => number,
  ) {}

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /**
   * 幂等建边：键已存在 → 跳过返回 undefined（add-only，不覆盖）；不存在 → put +
   * 追加 create 审计（by: 'system'）。入参需调用方已校验两 id 存在且 active。
   */
  async upsertEdge(input: CausalInput): Promise<MemoryCausalEdge | undefined> {
    const key = causalEdgeKey(input.sourceId, input.targetId, input.relation)
    if (this.table.get(key) !== undefined) return undefined
    const audit: AuditRecord[] = [{ action: 'create', at: this.iso(), by: 'system' }]
    const edge: MemoryCausalEdge = {
      sourceId: input.sourceId,
      targetId: input.targetId,
      relation: input.relation,
      confidence: input.confidence,
      createdAt: this.iso(),
      source: input.source,
      audit,
    }
    await this.table.put(key, edge)
    return edge
  }

  /** 全部边的快照列表 */
  listEdges(): MemoryCausalEdge[] {
    return [...this.table.entries()].map(([, edge]) => edge)
  }

  /**
   * 装订查询：id 的全部出边（sourceId 是该 id → target）与入边（source → 该 id）。
   * 仅审计展示用（v1 不做沿链扩散）。
   */
  edgesOf(id: string): { out: MemoryCausalEdge[]; in: MemoryCausalEdge[] } {
    const out: MemoryCausalEdge[] = []
    const inEdges: MemoryCausalEdge[] = []
    for (const [, edge] of this.table.entries()) {
      if (edge.sourceId === id) out.push(edge)
      if (edge.targetId === id) inEdges.push(edge)
    }
    return { out, in: inEdges }
  }

  /** 归档联动：删除所有与该 id 有关的边（source 或 target 侧）——孤儿清理 */
  async removeEdgesFor(id: string): Promise<void> {
    const keys: string[] = []
    for (const [key, edge] of this.table.entries()) {
      if (edge.sourceId === id || edge.targetId === id) keys.push(key)
    }
    for (const key of keys) {
      await this.table.delete(key)
    }
  }

  /**
   * 追加审计记录到既有边（抽取器在创建后补记 LLM 依据 detail；键不存在时静默跳过）。
   * @param sourceId 因侧 id
   * @param targetId 果侧 id
   * @param relation 关系
   * @param detail   审计补充说明（如 `LLM 因果抽取：依据 <justification>`）
   */
  async appendAudit(sourceId: string, targetId: string, relation: CausalRelation, detail: string): Promise<void> {
    const key = causalEdgeKey(sourceId, targetId, relation)
    const current = this.table.get(key)
    if (current === undefined) return
    const record: AuditRecord = { action: 'update', at: this.iso(), by: 'system', detail }
    await this.table.put(key, { ...current, audit: [...current.audit, record] })
  }
}

/** 解析出的单条候选边（LLM 原始输出，尚未校验/落库） */
export interface ParsedCausalEdge {
  sourceId: string
  targetId: string
  confidence: number
  justification?: string
}

/**
 * 从文本中提取第一个平衡的 JSON 对象（跳过字符串内的花括号；与 extract.ts 同思路）。
 * 输出 JSON 后附带含 `}` 的说明文本时不会被误吞。
 */
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

/**
 * 严格解析 LLM 因果输出：首个平衡 JSON，期望 `{"edges":[{sourceId,targetId,confidence,justification}]}`。
 * 非法/未知字段/confidence 非有限数 → 丢弃该条；非 JSON → []（绝不抛错）。
 */
export function parseCausalEdges(text: string): ParsedCausalEdge[] {
  const match = extractBalancedJson(text)
  if (match === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(match)
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { edges?: unknown }).edges)) {
    return []
  }
  const result: ParsedCausalEdge[] = []
  for (const item of (raw as { edges: unknown[] }).edges) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.sourceId !== 'string' || record.sourceId === '') continue
    if (typeof record.targetId !== 'string' || record.targetId === '') continue
    if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) continue
    const justification = typeof record.justification === 'string' ? record.justification : undefined
    result.push({
      sourceId: record.sourceId,
      targetId: record.targetId,
      confidence: record.confidence,
      justification,
    })
  }
  return result
}

/** 候选条目渲染为紧凑列表：`#id [kind] content…`（一次性给 LLM） */
function renderCandidates(candidates: MemoryEntry[]): string {
  return candidates
    .map((entry) => `#${entry.id} [${entry.kind}] ${entry.content.slice(0, 120)}`)
    .join('\n')
}

/**
 * 因果抽取器：维护周期批量增量抽取。
 * 周期门控、模型路由缓存回退、全程自收容（catch → warn，失败不更新 lastRunAt/route）。
 */
export class MemoryCausalExtractor {
  private lastRunAtValue: string | null = null
  private routeCache: Route | undefined
  /** 最近一次成功批次的观察量（memory_status/RPC status 透出；未运行 null） */
  private lastSummaryValue: CausalSummary | null = null

  constructor(private readonly deps: CausalExtractorDeps) {}

  /** 上次成功批次时刻（ISO；未运行过 null） */
  get lastRunAt(): string | null {
    return this.lastRunAtValue
  }

  /** 最近一次成功批次的观察量（审/提边/建成/跳过；未运行 null） */
  get lastSummary(): CausalSummary | null {
    return this.lastSummaryValue
  }

  /**
   * 执行一个因果抽取批次。周期门控：距上次成功未满 CAUSAL_INTERVAL_MS → undefined
   * （force 无视）。route 缺省回退缓存，无 → warn 返回 undefined。
   * 全程自收容：任何异常仅告警并返回 undefined，不更新 lastRunAt/route 缓存。
   */
  /** 重入互斥：当前运行中的批次 promise（定时 + 手动 force 并发合并为一次执行） */
  private running: Promise<CausalSummary | undefined> | undefined

  /**
   * 执行一个因果抽取批次。周期门控：距上次成功未满 CAUSAL_INTERVAL_MS → undefined
   * （force 无视）。route 缺省回退缓存，无 → warn 返回 undefined。
   * 重入互斥（Q6④ 拍板）：并发调用合并为一次——已有批次在运行则返回同一 promise，
   * 避免对同一批条目重复建边/重复 LLM 调用；周期门控在异步体内仍各自生效。
   * 全程自收容：任何异常仅告警并返回 undefined，不更新 lastRunAt/route 缓存。
   */
  runOnce(
    route: { provider: string; model: string } | undefined,
    opts?: { force?: boolean },
  ): Promise<CausalSummary | undefined> {
    // 重入互斥：已有批次在运行 → 返回同一 promise（合并并发，不重复执行）
    if (this.running !== undefined) return this.running
    // 并发方（含首个）都拿到同一个 run 引用——外层不能是 async 包装（async 函数会
    // 产生新的 promise 身份，破坏"合并为一次"的身份语义与测试断言）。
    const run = (async (): Promise<CausalSummary | undefined> => {
      try {
        // 周期门控（force 无视）
        if (!opts?.force && this.lastRunAtValue !== null) {
          const elapsed = this.deps.now() - Date.parse(this.lastRunAtValue)
          if (Number.isFinite(elapsed) && elapsed < CAUSAL_INTERVAL_MS) return undefined
        }

        // 路由解析：显式优先，缺省回退缓存；无 → 告警跳过
        const resolved = route ?? this.routeCache
        if (resolved === undefined) {
          this.deps.logger.warn('[dsh-memory] 无可用模型路由，跳过本批因果抽取')
          return undefined
        }

        // 候选：最近窗口 active（listRecent 已过滤非得体 source），截预算
        const candidates = this.deps.store.listRecent(CAUSAL_WINDOW, 'active').slice(0, CAUSAL_BUDGET)
        const reviewed = candidates.length
        if (reviewed === 0) {
          const empty: CausalSummary = { reviewed: 0, edges: 0, created: 0, skipped: 0 }
          this.lastRunAtValue = new Date(this.deps.now()).toISOString()
          this.routeCache = resolved
          this.lastSummaryValue = empty
          return empty
        }

        // 一次性 LLM 调用
        const userText = `以下是记忆条目列表（判断它们之间的因果/衍生关系）：\n\n${renderCandidates(candidates)}`
        const userMessage: Message = createUserMessage({
          content: [{ type: 'text', text: userText }],
          source: { kind: 'plugin', plugin: MEMORY_PLUGIN_ID },
        })
        const assembler = new BlockAssembler()
        for await (const chunk of this.deps.llm.stream({
          provider: resolved.provider,
          model: resolved.model,
          system: CAUSAL_SYSTEM_PROMPT,
          messages: [userMessage],
          maxTokens: CAUSAL_MAX_TOKENS,
        })) {
          assembler.push(chunk)
        }
        const finishKind = assembler.finish.kind
        if (finishKind === 'aborted' || finishKind === 'error') {
          throw new Error(`因果抽取调用未正常完成（${finishKind} finish）`)
        }
        const text = assembler
          .blocks()
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join('')

        const parsed = parseCausalEdges(text)
        const summary: CausalSummary = { reviewed, edges: parsed.length, created: 0, skipped: 0 }

        // 逐条校验建边（重读 store 当前状态）
        for (const edge of parsed) {
          await this.acceptCandidate(edge, summary)
        }

        // 批次成功：更新 lastRunAt/route 缓存与观察量（失败路径在上面 catch，不更新）
        this.lastRunAtValue = new Date(this.deps.now()).toISOString()
        this.routeCache = resolved
        this.lastSummaryValue = summary
        return summary
      } catch (error) {
        this.deps.logger.warn('[dsh-memory] 因果抽取批次执行失败：', error)
        return undefined
      }
    })()
    // 失败清理钩子：批次体自收容（logger.warn）不会 reject，finally 派生态无拒绝；
    // 比对引用才复位（与 maintenance/reflect.runOnce 同模式）——并发方已被合并到
    // 同一 run，引用不变则复位；若被替换则不覆盖别人的 promise。
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = undefined
    })
    return run
  }

  /**
   * 校验并落库一条候选边；不满足条件的计入 skipped（自环/未知 id/非 active/
   * 已被覆盖/跨 workspace/置信<0.6/已存在）。
   */
  private async acceptCandidate(edge: ParsedCausalEdge, summary: CausalSummary): Promise<void> {
    if (edge.sourceId === edge.targetId) {
      summary.skipped++
      return
    }
    const source = this.deps.store.getById(edge.sourceId)
    const target = this.deps.store.getById(edge.targetId)
    if (source === undefined || target === undefined) {
      summary.skipped++
      return
    }
    if (source.status !== 'active' || target.status !== 'active') {
      summary.skipped++
      return
    }
    if (source.supersededBy !== undefined || target.supersededBy !== undefined) {
      summary.skipped++
      return
    }
    if (source.workspace !== target.workspace) {
      summary.skipped++
      return
    }
    if (edge.confidence < CAUSAL_MIN_CONFIDENCE) {
      summary.skipped++
      return
    }
    const created = await this.deps.causal.upsertEdge({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relation: 'causal',
      confidence: edge.confidence,
      source: source.source,
    })
    if (created === undefined) {
      // 键已存在：视为"已建过"跳过
      summary.skipped++
      return
    }
    // 补记 LLM 依据（审计 detail）
    if (edge.justification !== undefined) {
      await this.deps.causal.appendAudit(
        edge.sourceId,
        edge.targetId,
        'causal',
        `LLM 因果抽取：依据 ${edge.justification}`,
      )
    }
    summary.created++
  }
}
