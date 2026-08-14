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

/** 提取器配置（由插件 Config 解析后的默认值填充） */
export interface ExtractorConfig {
  enableExtractor: boolean
  minExtractChars: number
  extractMaxTokens: number
}

/** 提取器依赖（llm/store 可注入，便于单测） */
export interface ExtractorDeps {
  store: MemoryStore
  llm: Pick<LlmRuntime, 'stream'>
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
  config: ExtractorConfig
}

/** 待提取批次：跨轮次累计的事件与文本（低于阈值时挂起） */
interface PendingBatch {
  events: SessionEvent[]
  text: string
}

/** 会话事件监听器形态 */
type SessionEventListener = (session: Session, event: SessionEvent) => void

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

  /** 注册 session/event 监听（纯观察，无返回值约束） */
  install(ctx: Context): void {
    this.agents = ctx.get('agents')
    ctx.on('session/event', this.onSessionEvent.bind(this) as SessionEventListener)
  }

  /** 事件入口：只对两类触发事件入队，其余忽略 */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (!this.deps.config.enableExtractor) return
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

    if (batch.text.length >= this.deps.config.minExtractChars) {
      await this.extractAndStore(session, batch.events, batch.text)
      this.pending.delete(session.id)
    } else {
      this.pending.set(session.id, batch)
    }
  }

  /** 提取并入库：路由解析 → LLM 调用 → 逐条写入（失败抛出，由调用方保持水位） */
  private async extractAndStore(session: Session, events: SessionEvent[], text: string): Promise<void> {
    const agent = this.agents?.get(session.id)
    const route = resolveRoute(session, agent)
    if (route === undefined) {
      this.deps.logger.warn(`[dsh-memory] 无可用模型路由，跳过提取（会话 ${session.id}）`)
      return
    }
    const memories = await runExtraction(
      { llm: this.deps.llm, provider: route.provider, model: route.model, maxTokens: this.deps.config.extractMaxTokens },
      text,
    )
    const workspace = session.header.cwd ?? DEFAULT_WORKSPACE
    const eventSeqs = events.map((event) => event.seq)
    const excerpt = text.slice(0, EXCERPT_MAX_CHARS)
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
