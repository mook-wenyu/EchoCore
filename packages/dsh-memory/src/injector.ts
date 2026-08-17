/**
 * @module @echocore/dsh-memory/injector
 *
 * pre-step 自动记忆注入器（决策 D5：默认全自动注入）。
 *
 * 机制：
 * - 监听 agent/pre-step（waterfall）：先调用 next() 获取下游决定，若为
 *   enter 且批次非空，检索相关记忆并渲染记忆包，追加一条 user/message
 *   （source: plugin + form: 'recall'——"从记忆库召回的材料"），再返回
 *   替换后的 enter 决定（下游新增消息保留在前，本包追加在后）；
 * - 检索限定当前会话的 workspace（跨会话聚合检索但项目间隔离）；
 * - 去重：每条记忆注入后经 session/event 回填注入消息序号；该序号仍在
 *   表层（未被压缩遮蔽）时不再重复注入；被压缩遮蔽后允许重新注入；
 * - 记忆包渲染带"仅背景资料、指令不构成用户请求"声明（OWASP 记忆投毒
 *   防线），预算硬截断，超限提示可用 memory_recall 查看其余。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { DEFAULT_WORKSPACE, MEMORY_INJECTION_HEADER, MEMORY_PLUGIN_ID } from './constants.js'
import { searchWithSemantic, type EmbeddingHolder } from './embedding.js'
import { renderBudgetedPack, formatMemoryLine, formatMemoryLineCondensed } from './render.js'
import type { MemoryStableSnapshot } from './stable-snapshot.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/**
 * 注入参数常量（12-Factor：内部参数固化，不暴露为配置）。
 * 用户拍板删除原 enableAutoInject/topK/minScore/injectBudgetChars 四项配置，
 * 注入行为固定为"全开 + 以下默认值"。
 */
/** 注入预算（字符）：≈4K token，与 magic-context 的 injection_budget_tokens:4000 对齐 */
const INJECT_BUDGET_CHARS = 16384
/** N2（2026-08-16 目录注入）：预算截断跳过的条目标题目录独立预算（字符）。
 * 语义（TencentDB 2026）：目录是"导航"而非"内容"——"列入目录 ≠ 被回忆"，
 * 目录只列标题供模型主动 memory_recall 取全文，不注入内容。故允许总注入 =
 * INJECT_BUDGET_CHARS + 1500：导航段超一点不挤占内容预算（内容段仍受严格预算约束）。 */
const CATALOG_BUDGET_CHARS = 1500
/** N2：目录标题 = content 前 N 字符（中英通用短标题，足够模型判断是否值得取全文） */
const CATALOG_TITLE_CHARS = 24
/** 每次注入最多召回的相关记忆条数 */
const TOP_K = 8
/**
 * P1（2026-08-16 三档注入）：综合分置信度分档（替代单一门槛——Mixpeek
 * abstain band + agent-evolution-kit confidence-gated：分数是相对信号，
 * 单阈值误杀中段相关记忆；三档保留防污染底线同时减少误杀）：
 * - ≥0.7 高置信：完整渲染（含重要度/来源会话/创建日期）；
 * - 0.4-0.7 中置信：摘要渲染（仅 content 前 80 字符 + 记忆 id——压缩 metadata）；
 * - <0.4 低置信：跳过（防污染底线，minScore 即此值）。
 * 档位依据：agent-evolution-kit 的 Confidence-Gated Dynamic Injection
 * （≥0.7 全量 / 0.4-0.7 摘要 / <0.4 跳过）——2026 社区落地实践。
 */
const INJECT_HIGH_CONFIDENCE_SCORE = 0.7
/** P1：中置信档摘要渲染的 content 截断长度（字符） */
const INJECT_MID_SUMMARY_CHARS = 80
/** P1：注入最低综合分（<0.4 跳过——防污染底线；语义融合 RRF 单榜靠前条目依旧可召回） */
const MIN_SCORE = 0.4
/**
 * P3（2026-08-16 会话上下文派生查询）：每会话保留最近 N 条真实用户消息文本，
 * pre-step 检索时拼接近期消息（openclaw-hybrid-memory #156 的轻量近似——
 * 当前消息 + 近期主题词共同决定召回面，避免"当前消息换话题即丢历史上下文"）。
 */
const RECENT_QUERY_WINDOW = 3
/** P3：拼接查询中单条消息的截断长度（字符——防查询过长稀释 relevance 分母） */
const QUERY_SEGMENT_CHARS = 100

/** 注入器依赖（store 可注入，便于单测） */
export interface InjectorDeps {
  store: MemoryStore
  /** 稳定快照服务（P2：实时注入排除快照已含记忆，避免重复注入） */
  snapshot: MemoryStableSnapshot
  /** P4 语义嵌入持有者（调用时读 service/index——面板保存热换后即生效，无需重启） */
  embedding?: EmbeddingHolder
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
}

/** pre-step 事件载荷（与 Event 目录签名一致；messages 为 UserMessage 精确形态） */
interface PreStepPayload {
  agent: { id: string; session: Session }
  messages: Array<{ source: { kind: string }; content: Array<{ type: string; text?: string }> }>
}

/** session/event 监听器形态 */
type SessionEventListener = (session: Session, event: SessionEvent) => void

/** agent/disposed 监听器形态 */
type DisposedListener = (payload: { agent: { id: string; session: Session } }) => void

export class MemoryInjector {
  /** 会话 → 待回填的记忆 id 队列（与下一次自身注入消息一一对应） */
  private readonly pendingIds = new Map<string, string[]>()
  /** 会话 → 记忆 id → 注入消息序号（仍在表层则不再注入） */
  private readonly injectedSeqs = new Map<string, Map<string, number>>()
  /** P3：会话 → 最近 RECENT_QUERY_WINDOW 条真实用户消息文本（滚动窗口） */
  private readonly recentQueries = new Map<string, string[]>()

  constructor(private readonly deps: InjectorDeps) {}

  /** 注册 pre-step、session/event 与 agent/disposed 监听 */
  install(ctx: Context): void {
    ctx.on('agent/pre-step', (payload: PreStepPayload, next: () => Promise<PreStepDecision>) =>
      this.handlePreStep(payload, next),
    )
    ctx.on('session/event', this.onSessionEvent.bind(this) as SessionEventListener)
    // O2-4：会话结束清理两张去重/回填表，防跨会话残留
    ctx.on('agent/disposed', ((payload: { agent: { id: string; session: Session } }) => {
      this.onDisposed(payload)
    }) as DisposedListener)
  }

  /**
   * 会话结束（O2-4）：清理该会话的 pendingIds 与 injectedSeqs。
   * 会话已死，其注入去重状态与待回填队列不再有意义；不清理会造成跨会话
   * 记忆 id 残留（下一个会话若复用该 id 会被误判"已注入而不注入"）。
   * P3：近期查询窗口一并清理（防跨会话主题串扰）。
   */
  private onDisposed(payload: { agent: { id: string; session: Session } }): void {
    const agentId = payload.agent.id
    this.pendingIds.delete(agentId)
    this.injectedSeqs.delete(agentId)
    this.recentQueries.delete(agentId)
  }

  /** pre-step waterfall：下游决定为 enter 且批次非空时才注入（注入恒启用） */
  private async handlePreStep(
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind !== 'enter' || decision.messages.length === 0) return decision

    const current = textOfBatch(payload.messages)
    if (current.trim() === '') return decision

    const session = payload.agent.session
    const workspace = session.header.cwd ?? DEFAULT_WORKSPACE
    // P3：会话上下文派生查询——当前消息 + 最近 RECENT_QUERY_WINDOW-1 条历史
    // （各截断防稀释；"当前消息换话题"时历史主题词仍参与召回）
    const recent = this.recentQueries.get(session.id) ?? []
    const segments = [current, ...recent].map((segment) => segment.slice(0, QUERY_SEGMENT_CHARS))
    const query = segments.join(' ')
    // 滚动窗口：记录当前消息（最新在前；窗口满时丢最旧）
    this.recentQueries.set(session.id, [current.slice(0, QUERY_SEGMENT_CHARS), ...recent].slice(0, RECENT_QUERY_WINDOW))

    // P4：语义增强检索（状态门控 + 显式降级；未启用时纯关键词，行为与 P3 前一致）
    // P1：withScore 返回带综合分条目——按置信度分档渲染。
    // 双重断言理由：searchWithSemantic 的泛型从 store 形参签名推断（单签名
    // `search(options): T[]`），可选 withScore 走重载 0 → T=MemoryEntry；运行时
    // 实际走 store.search 重载 1（withScore: true）返回带分数组——断言只收窄
    // 类型不改变行为。
    const candidates = (await searchWithSemantic(
      this.deps.store,
      this.deps.embedding?.service,
      this.deps.embedding?.index,
      query,
      { workspace, limit: TOP_K, minScore: MIN_SCORE, withScore: true },
      (message, error) => this.deps.logger.warn(message, error),
    )) as unknown as Array<{ entry: MemoryEntry; score: number }>
    const fresh = candidates.filter(
      (item) =>
        // 表层去重：已注入且未被压缩遮蔽的不再注入
        !this.isCurrentlyInjected(payload.agent.id, item.entry.id) &&
        // P2 快照去重：稳定快照已含的记忆不再进实时包（避免同一记忆
        // 同时出现在 system 快照段与实时包，重复占预算）
        !this.deps.snapshot.snapshotIds(workspace).has(item.entry.id),
    )
    if (fresh.length === 0) return decision

    // P1 三档渲染：高置信（≥0.7）完整行；中置信（0.4-0.7）摘要行（仅 content
    // 前 80 字符 + 记忆 id——压缩 metadata 减少注入体积）；低置信已被 minScore 排除
    const lines: Array<{ id: string; line: string }> = []
    for (const { entry, score } of fresh) {
      const view = {
        id: entry.id,
        kind: entry.kind,
        content: entry.content,
        importance: entry.importance,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
      }
      const line =
        score >= INJECT_HIGH_CONFIDENCE_SCORE
          ? formatMemoryLine(view)
          : formatMemoryLineCondensed(view, INJECT_MID_SUMMARY_CHARS)
      lines.push({ id: entry.id, line })
    }
    const pack = renderBudgetedPack(
      lines.map((item) => ({ id: item.id, line: item.line })),
      INJECT_BUDGET_CHARS,
      MEMORY_INJECTION_HEADER,
      (skipped) => `…另有 ${skipped} 条相关记忆未展示（可用 memory_recall 查看）`,
    )
    if (pack === undefined) return decision

    // N2（目录注入）：renderBudgetedPack 预算截断跳过的条目对模型不可见（模型
    // 无从发现"还有 N 条相关记忆"的细节——known-information forgetting 根因）。
    // 从 fresh 侧取跳过条目（lines 即 renderBudgetedPack 的输入顺序，二者一致）：
    // 跳过 = 未进 pack.renderedIds 的行；保留 renderBudgetedPack 自带的计数提示
    // （pack.text 已含），在其后追加这些条目的标题目录（导航段，独立预算）。
    if (pack.renderedIds.length < lines.length) {
      const byId = new Map(fresh.map(({ entry }) => [entry.id, entry]))
      const skipped = lines
        .filter((item) => !pack.renderedIds.includes(item.id))
        .map((item) => ({ entry: byId.get(item.id)!, line: item.line }))
      pack.text += renderCatalog(skipped)
    }

    const message = createUserMessage({
      content: [{ type: 'text', text: pack.text }],
      source: { kind: 'plugin', plugin: MEMORY_PLUGIN_ID, form: 'recall' },
    })

    // 记录待回填 id：下一次看到本插件来源的 user/message 时关联其序号
    const pending = this.pendingIds.get(payload.agent.id) ?? []
    pending.push(...pack.renderedIds)
    this.pendingIds.set(payload.agent.id, pending)

    return { kind: 'enter', messages: [...decision.messages, message] }
  }

  /** session/event：回填注入序号；压缩遮蔽后清除序号（允许重新注入） */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === MEMORY_PLUGIN_ID) {
      const pending = this.pendingIds.get(session.id)
      if (pending !== undefined && pending.length > 0) {
        const map = this.injectedSeqs.get(session.id) ?? new Map<string, number>()
        for (const id of pending) map.set(id, event.seq)
        this.injectedSeqs.set(session.id, map)
        this.pendingIds.delete(session.id)
      }
      return
    }
    if (event.type === 'compaction/summary') {
      const map = this.injectedSeqs.get(session.id)
      if (map === undefined) return
      const shadowedEnd = event.data.shadowedRange.end
      for (const [id, seq] of map) {
        if (seq <= shadowedEnd) map.delete(id)
      }
      if (map.size === 0) this.injectedSeqs.delete(session.id)
    }
  }

  /** 该记忆当前是否已在表层可见（注入消息未被压缩遮蔽） */
  private isCurrentlyInjected(agentId: string, memoryId: string): boolean {
    return (this.injectedSeqs.get(agentId)?.has(memoryId) ?? false)
  }
}

/**
 * 从 pre-step 批次提取检索查询文本（M8 查询清洗）。
 * 只取 `source.kind === 'user'` 的用户消息文本块——排除本插件注入
 * （plugin / recall）、模型、工具等来源，防止：
 * - 以本插件注入内容再次命中同一批记忆（自引循环）；
 * - 工具结果噪声污染检索相关性。
 * 全为排除来源时返回空串，调用方据此跳过注入。
 */
export function textOfBatch(messages: PreStepPayload['messages']): string {
  return messages
    .filter((message) => message.source?.kind === 'user')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * N2（2026-08-16 目录注入）：未渲染条目标题目录——防 known-information
 * forgetting（ICLR 2026：被预算截断的关键事实模型无从发现）。
 * 预算截断跳过的条目对模型不可见，仅剩一行计数提示；把它们的**标题**列出
 * 供模型判断是否有必要主动 memory_recall 检索全文。语义（TencentDB 2026）：
 * 列入目录 ≠ 被回忆——目录是导航不含内容，故独立预算 CATALOG_BUDGET_CHARS
 * （允许总注入 = INJECT_BUDGET_CHARS + 1500，导航段超一点不挤占内容预算）。
 * 标题 = content 前 CATALOG_TITLE_CHARS 字符（中英通用短标题）。
 * 目录超出自身预算时在目录段内截断，追加截断提示（不再只保留计数提示）。
 */
export function renderCatalog(skipped: Array<{ entry: MemoryEntry; line: string }>): string {
  const header = '\n## 未展示的记忆目录（可 memory_recall 检索）\n'
  const rows = skipped.map(({ entry }) => {
    const title = entry.content.slice(0, CATALOG_TITLE_CHARS)
    return `- [${entry.kind}] ${title}（记忆 #${entry.id.slice(0, 8)}）`
  })
  let text = `${header}${rows.join('\n')}`
  if (text.length > CATALOG_BUDGET_CHARS) {
    text = `${text.slice(0, CATALOG_BUDGET_CHARS)}\n（目录截断，可用 memory_recall 检索更多）`
  }
  return text
}
