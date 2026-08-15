/**
 * @module @echocore/dsh-memory/extractor
 *
 * 双通道记忆提取编排器（决策 D3）：
 * - 通道 A（压缩）：监听 compaction/summary，从被遮蔽跨度（shadowedSeqs）的
 *   原文事件中提取记忆——上下文即将丢失前的捕获点；
 * - 通道 B（增量）：监听 turn/end，累计新消息文本，超过 minExtractChars
 *   才触发一次提取（控制 LLM 调用频率）。
 *
 * 语义保证：
 * - 事件序号水位（lastSeq）只在不抛出时推进——LLM 失败保留水位与待提取批次，
 *   下一次触发自动重试；
 * - 提取调用异步执行（事件监听内不 await，经每会话串行链排队），
 *   错误收容到链尾，绝不阻塞轮次关闭与压缩事务；
 * - 去重由 MemoryStore.create 的 dedupKey 合并机制兜底。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

// 副作用导入：激活 dsh-compaction 对 SessionEventMap 的声明合并（compaction/* 事件类型）
import '@deepseek-ai/dsh-compaction'

import { DEFAULT_WORKSPACE, EXCERPT_MAX_CHARS } from './constants.js'
import { renderEventsText, resolveRoute, runExtraction } from './extract.js'
import type { MemoryStore } from './store.js'

/**
 * 提取参数常量（12-Factor：内部参数固化，不暴露为配置）。
 * 用户拍板删除原 enableExtractor/minExtractChars/maxExtractChars/extractMaxTokens
 * 四项配置，提取行为固定为"恒启用 + 以下默认值"。
 */
/** 增量提取触发阈值（字符）：每轮累计的消息文本达到该量才触发一次提取（控制 LLM 调用频率） */
const MIN_EXTRACT_CHARS = 2000
/** 摘录长度上限（字符）：超过则截尾保最新（旧内容已在压缩中登记摘要，近期片段信息密度更高） */
const MAX_EXTRACT_CHARS = 12000
/** 提取输出 token 上限：限制单次提取调用产出的记忆量，防超长输出 */
const EXTRACT_MAX_TOKENS = 2048

/** 提取器依赖（llm/store 可注入，便于单测） */
export interface ExtractorDeps {
  store: MemoryStore
  llm: Pick<LlmRuntime, 'stream'>
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
}

/** 待提取批次：跨轮次累计的事件与文本（低于阈值时挂起） */
interface PendingBatch {
  events: SessionEvent[]
  text: string
}

/**
 * 截尾保最新：把超长摘录裁剪到最近 maxChars 字符，并在 `\n` 边界落笔。
 *
 * 语义（O1-3）：
 * - 目的：控制提取调用输入长度，防超窗（近期对话优先——旧内容已在压缩中登
 *   记摘要，短期内最新片段信息密度更高）；
 * - 从尾部截取最新 maxChars 字符，再左移到最近一段的 `\n` 边界，避免从一行
 *   中间切断产生残缺句；
 * - 原文本未超限时原样返回；返回文本长度恒 ≤ maxChars。
 */
export function truncateKeepLatest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let start = text.length - maxChars
  // 左移到最近的换行之后，保证保留片段以整行开始
  const nl = text.lastIndexOf('\n', start)
  if (nl !== -1 && nl >= start - 1) start = nl + 1
  return text.slice(start)
}

export class MemoryExtractor {
  /** 每会话已处理的最大事件序号（水位） */
  private readonly lastSeq = new Map<string, number>()
  /** 每会话待提取批次（增量通道累计） */
  private readonly pending = new Map<string, PendingBatch>()
  /** 每会话处理串行链（防并发交错水位） */
  private readonly chains = new Map<string, Promise<void>>()
  /** 可选：agent 注册表（路由回退用；未挂载时仅依赖 request/header） */
  private agents: ReturnType<Context['get']> | undefined

  constructor(private readonly deps: ExtractorDeps) {}

  /** 注册 session/event 与 agent/disposed 监听（纯观察，无返回值约束） */
  install(ctx: Context): void {
    this.agents = ctx.get('agents')
    ctx.on('session/event', this.onSessionEvent.bind(this))
    // O1-4：会话结束兜底——清理该会话所有临时状态；有遗留批次则立即 flush
    ctx.on('agent/disposed', (payload: { agent: { id: string; session: Session } }) => {
      this.onDisposed(payload)
    })
  }

  /**
   * 会话结束事件（O1-4 + O2-1）。
   * - 若有遗留待提取批次（增量通道累计未达阈值），立即触发一次提取（不等阈值），
   *   避免会话结束丢失轨迹；
   * - 无论成功与否，统一清理该会话的三张 Map（lastSeq / pending / chains）——
   *   会话已死，保留无意义且造成内存泄漏；flush 失败仅 warn 一次，不再重试。
   * 注意：该会话水位已在整体结束后不会被新事件推进，故清理不会导致状态丢失。
   */
  private onDisposed(payload: { agent: { id: string; session: Session } }): void {
    const sessionId = payload.agent.id
    // 先同步取出并清空批次，防止重复 dispose 重复 flush
    const batch = this.pending.get(sessionId)
    if (batch !== undefined) {
      this.pending.delete(sessionId)
      // 借助串行链追加一次 flush：排在任何进行中的处理之后执行
      const chain = this.chains.get(sessionId) ?? Promise.resolve()
      const next = chain.then(() => this.flushOnDispose(sessionId, payload.agent.session, batch))
      this.chains.set(sessionId, next)
    } else {
      this.releaseSession(sessionId)
    }
  }

  /** dispose 后执行一次的 flush：提取遗留批次并清理该会话状态（失败也清理，warn 一次） */
  private async flushOnDispose(sessionId: string, session: Session, batch: PendingBatch): Promise<void> {
    try {
      await this.extractAndStore(session, batch.events, batch.text)
    } catch (error: unknown) {
      // 会话已死，不再重试（水位语义在 dispose 后本就不复存在），仅告警一次
      this.deps.logger.warn(`[dsh-memory] 会话结束提取遗留批次失败（会话 ${sessionId}），不再重试：`, error)
    } finally {
      this.releaseSession(sessionId)
    }
  }

  /** 清理某会话的全部临时状态（水位 / 待提取批次 / 串行链） */
  private releaseSession(sessionId: string): void {
    this.lastSeq.delete(sessionId)
    this.pending.delete(sessionId)
    this.chains.delete(sessionId)
  }

  /** 事件入口：只对两类触发事件入队，其余忽略（提取恒启用） */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'compaction/summary' && event.type !== 'turn/end') return
    this.enqueue(session, event)
  }

  /** 每会话串行入队：前序处理完成后执行本次处理，异常收容在链尾 */
  private enqueue(session: Session, event: SessionEvent): void {
    const chain = this.chains.get(session.id) ?? Promise.resolve()
    const next = chain
      .then(() => this.process(session, event))
      .catch((error: unknown) => {
        this.deps.logger.warn(`[dsh-memory] 提取处理失败（会话 ${session.id}）：`, error)
      })
    this.chains.set(session.id, next)
  }

  /** 处理一个触发事件（串行链内执行） */
  private async process(session: Session, trigger: SessionEvent): Promise<void> {
    const sessionId = session.id
    const last = this.lastSeq.get(sessionId) ?? 0
    if (trigger.seq <= last) return // 重复/乱序通知防护（事件按序广播，理论不触发）

    if (trigger.type === 'compaction/summary') {
      await this.processCompaction(session, trigger)
      this.lastSeq.set(sessionId, trigger.seq)
      return
    }
    if (trigger.type === 'turn/end') {
      await this.processTurnEnd(session, trigger)
      this.lastSeq.set(sessionId, trigger.seq)
      return
    }
  }

  /** 通道 A：压缩遮蔽跨度提取（立即提取，不等阈值） */
  private async processCompaction(session: Session, trigger: Extract<SessionEvent, { type: 'compaction/summary' }>): Promise<void> {
    const last = this.lastSeq.get(session.id) ?? 0
    const shadowed = new Set(trigger.data.shadowedSeqs)
    const targets = session.events.filter((event) => shadowed.has(event.seq) && event.seq > last)
    const text = renderEventsText(targets)
    if (text.trim() !== '') {
      await this.extractAndStore(session, targets, text)
    }
  }

  /** 通道 B：轮次结束增量提取（累计到阈值才触发） */
  private async processTurnEnd(session: Session, trigger: Extract<SessionEvent, { type: 'turn/end' }>): Promise<void> {
    const last = this.lastSeq.get(session.id) ?? 0
    const fresh = session.events.filter(
      (event) => (event.type === 'user/message' || event.type === 'assistant/message') && event.seq > last,
    )
    if (fresh.length === 0) return

    const freshText = renderEventsText(fresh)
    const prior = this.pending.get(session.id)
    const batch: PendingBatch = prior
      ? { events: [...prior.events, ...fresh], text: `${prior.text}\n${freshText}` }
      : { events: fresh, text: freshText }

    if (batch.text.length >= MIN_EXTRACT_CHARS) {
      await this.extractAndStore(session, batch.events, batch.text)
      this.pending.delete(session.id)
    } else {
      this.pending.set(session.id, batch)
    }
  }

  /** 提取并入库：路由解析 → 文本截底 → LLM 调用 → 逐条写入（失败抛出，由调用方保持水位） */
  private async extractAndStore(session: Session, events: SessionEvent[], text: string): Promise<void> {
    // R2-9/B9 失败语义（禁止"优化"为失败即丢）：
    // - processTurnEnd/processCompaction 在 await 之后才推进水位/删除 pending——
    //   抛错时两者均保留，下次触发会重试同一批事件；
    // - 重试代价是重复 LLM 调用（create 去重合并兜底，不会产生重复条目）——
    //   这是"数据完整性优先"的已知成本，不引入防抖复杂度（YAGNI）。
    const agent = this.agents?.get(session.id)
    const route = resolveRoute(session, agent)
    if (route === undefined) {
      this.deps.logger.warn(`[dsh-memory] 无可用模型路由，跳过提取（会话 ${session.id}）`)
      return
    }
    // 长摘录截尾保最新：两通道（压缩遮蔽 / 轮次增量）共用此闸点，超限才截并告警一次
    const transcript = truncateKeepLatest(text, MAX_EXTRACT_CHARS)
    if (transcript !== text) {
      this.deps.logger.warn(
        `[dsh-memory] 摘录超 ${MAX_EXTRACT_CHARS} 字符，截尾保留最新片段（会话 ${session.id}）`,
      )
    }
    // O2-3 决策：不向提取传 signal。
    // 提取是后台任务，在 turn/end / compaction / agent/disposed 事件上下文中
    // 没有用户级取消信号（Event payload 不含 signal）；若人为构造，实则无用户取消
    // 语义可对应。会话结束后串行链自然终止，disposed flush 的失败也不会再重试，
    // 故无需防御性取消——此处保持不传 signal，避免引入死分支。
    const memories = await runExtraction(
      { llm: this.deps.llm, provider: route.provider, model: route.model, maxTokens: EXTRACT_MAX_TOKENS },
      transcript,
    )
    const workspace = session.header.cwd ?? DEFAULT_WORKSPACE
    const eventSeqs = events.map((event) => event.seq)
    const excerpt = transcript.slice(0, EXCERPT_MAX_CHARS)
    for (const memory of memories) {
      await this.deps.store.create({
        workspace,
        sessionId: session.id,
        kind: memory.kind,
        content: memory.content,
        importance: memory.importance,
        tags: memory.tags,
        source: { sessionId: session.id, eventSeqs, excerpt },
        by: 'extractor',
      })
    }
    if (memories.length > 0) {
      this.deps.logger.info(`[dsh-memory] 提取 ${memories.length} 条记忆（会话 ${session.id}）`)
    }
  }
}
