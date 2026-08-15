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
import { searchWithSemantic, type EmbeddingService } from './embedding.js'
import type { EmbeddingIndex } from './embed-index.js'
import { renderBudgetedPack } from './render.js'
import { MIN_RELEVANCE_SCORE } from './scoring.js'
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
/** 每次注入最多召回的相关记忆条数 */
const TOP_K = 8
/**
 * 注入最低综合分（relevance × 时间 × 重要性）。
 * F2（防上下文污染）：0.15 → 0.3。旧 0.15 形同虚设——relevance 是单边召回率
 * （query token 命中比例），1-2 个 token 重合即放行；门槛抬高依据见
 * scoring.MIN_RELEVANCE_SCORE 注释（mem0/magic-context 门槛实践 +
 * noisy 检索摧毁已知答案 51-64%）。与 store.search 的 minScore 采用同一
 * 门槛常量，本处显式传入以表达注入阈值语义；语义融合（RRF）路径也走同一
 * minScore，单榜靠前语义条目依旧可召回（门槛只筛双榜皆弱杂音）。
 */
const MIN_SCORE = MIN_RELEVANCE_SCORE

/** 注入器依赖（store 可注入，便于单测） */
export interface InjectorDeps {
  store: MemoryStore
  /** 稳定快照服务（P2：实时注入排除快照已含记忆，避免重复注入） */
  snapshot: MemoryStableSnapshot
  /** P4 语义嵌入（未启用/未就绪时纯关键词路径；undefined = 配置关闭） */
  embedding?: EmbeddingService
  /** P4 嵌入索引（条目向量查找；与 embedding 成对出现） */
  embedIndex?: EmbeddingIndex
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
}

/** 渲染结果：模型可见文本 + 注入的记忆 id 列表（供回填序号追踪） */
export interface RenderedPack {
  text: string
  ids: string[]
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
   */
  private onDisposed(payload: { agent: { id: string; session: Session } }): void {
    const agentId = payload.agent.id
    this.pendingIds.delete(agentId)
    this.injectedSeqs.delete(agentId)
  }

  /** pre-step waterfall：下游决定为 enter 且批次非空时才注入（注入恒启用） */
  private async handlePreStep(
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind !== 'enter' || decision.messages.length === 0) return decision

    const query = textOfBatch(payload.messages)
    if (query.trim() === '') return decision

    const session = payload.agent.session
    const workspace = session.header.cwd ?? DEFAULT_WORKSPACE
    // P4：语义增强检索（状态门控 + 显式降级；未启用时纯关键词，行为与 P3 前一致）
    const candidates = (await searchWithSemantic(
      this.deps.store,
      this.deps.embedding,
      this.deps.embedIndex,
      query,
      { workspace, limit: TOP_K, minScore: MIN_SCORE },
      (message, error) => this.deps.logger.warn(message, error),
    )) as MemoryEntry[]
    const fresh = candidates.filter(
      (entry) =>
        // 表层去重：已注入且未被压缩遮蔽的不再注入
        !this.isCurrentlyInjected(payload.agent.id, entry.id) &&
        // P2 快照去重：稳定快照已含的记忆不再进实时包（避免同一记忆
        // 同时出现在 system 快照段与实时包，重复占预算）
        !this.deps.snapshot.snapshotIds(workspace).has(entry.id),
    )
    if (fresh.length === 0) return decision

    const pack = renderPack(fresh, INJECT_BUDGET_CHARS)
    if (pack === undefined) return decision

    const message = createUserMessage({
      content: [{ type: 'text', text: pack.text }],
      source: { kind: 'plugin', plugin: MEMORY_PLUGIN_ID, form: 'recall' },
    })

    // 记录待回填 id：下一次看到本插件来源的 user/message 时关联其序号
    const pending = this.pendingIds.get(payload.agent.id) ?? []
    pending.push(...pack.ids)
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
 * 渲染记忆包：共享预算渲染（renderBudgetedPack）+ 实时注入专属的截断提示。
 * 返回 undefined 表示一条都放不下（不注入，避免空消息）。
 */
export function renderPack(entries: MemoryEntry[], budgetChars: number): RenderedPack | undefined {
  const pack = renderBudgetedPack(
    entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      content: entry.content,
      importance: entry.importance,
      sessionId: entry.source.sessionId,
      // F3：渲染创建日期——模型可判断记忆新旧（防把过时记忆当现行事实）
      createdAt: entry.createdAt,
    })),
    budgetChars,
    MEMORY_INJECTION_HEADER,
    (skipped) => `（另有 ${skipped} 条相关记忆，可用 memory_recall 查看）`,
  )
  if (pack === undefined) return undefined
  return { text: pack.text, ids: pack.renderedIds }
}
