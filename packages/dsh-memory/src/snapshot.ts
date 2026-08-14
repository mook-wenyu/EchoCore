/**
 * @module @echocore/dsh-memory/snapshot
 *
 * 会话快照（决策 D6：跨会话记忆连续性）。
 *
 * 两条登记通道，均不额外调用 LLM：
 * - compaction/summary：把压缩摘要登记为 kind='insight'、tag=['session-summary']
 *   的记忆条目——摘要本身就是"这段会话讲了什么"的浓缩，随跨会话检索可被
 *   新会话搜到；
 * - agent/disposed：会话结束时写一条快照记录（起止时间、记忆规模），
 *   kind='insight'、tag=['snapshot']，回答"这个项目之前聊过什么"。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

// 副作用导入：激活 dsh-compaction 对 SessionEventMap 的声明合并
import '@deepseek-ai/dsh-compaction'

import { DEFAULT_WORKSPACE } from './constants.js'
import type { MemoryStore } from './store.js'

/** 会话快照模块依赖 */
export interface SnapshotDeps {
  store: MemoryStore
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
}

/** 注册快照两条登记通道 */
export function registerSnapshot(ctx: Context, deps: SnapshotDeps): void {
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'compaction/summary') {
      recordSessionSummary(deps, session, event)
    }
  })
  ctx.on('agent/disposed', (payload: { agent: { id: string; session: Session } }) => {
    void recordSessionEnd(deps, payload.agent)
  })
}

/** 压缩摘要登记为会话摘要记忆 */
async function recordSessionSummary(deps: SnapshotDeps, session: Session, event: Extract<SessionEvent, { type: 'compaction/summary' }>): Promise<void> {
  const summaryText = event.data.summary
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n')
  if (summaryText.trim() === '') return

  await deps.store
    .create({
      workspace: session.header.cwd ?? DEFAULT_WORKSPACE,
      sessionId: session.id,
      kind: 'insight',
      content: `会话摘要：${summaryText}`,
      importance: 7,
      tags: ['session-summary'],
      source: { sessionId: session.id, eventSeqs: event.data.shadowedSeqs, excerpt: summaryText.slice(0, 400) },
      by: 'system',
    })
    .catch((error: unknown) => {
      deps.logger.warn(`[dsh-memory] 会话摘要登记失败（会话 ${session.id}）：`, error)
    })
}

/** 会话结束快照记录 */
async function recordSessionEnd(deps: SnapshotDeps, agent: { id: string; session: Session }): Promise<void> {
  const session = agent.session
  const memories = deps.store.listBySession(session.id)
  const summaries = memories.filter((entry) => entry.tags.includes('session-summary'))
  const content =
    `会话快照：会话 ${session.id}（${new Date(session.header.createdAt).toISOString()} 结束），` +
    `期间产生记忆 ${memories.length} 条（含会话摘要 ${summaries.length} 份）。` +
    `可用 memory_search kind=insight 检索本会话的摘要内容。`

  await deps.store
    .create({
      workspace: session.header.cwd ?? DEFAULT_WORKSPACE,
      sessionId: session.id,
      kind: 'insight',
      content,
      importance: 5,
      tags: ['snapshot'],
      source: { sessionId: session.id, eventSeqs: [], excerpt: content.slice(0, 400) },
      by: 'system',
    })
    .catch((error: unknown) => {
      deps.logger.warn(`[dsh-memory] 会话快照写入失败（会话 ${session.id}）：`, error)
    })
}
