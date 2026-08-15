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

import { DEFAULT_WORKSPACE, EXCERPT_MAX_CHARS } from './constants.js'
import { tokenize } from './scoring.js'
import type { MemoryStore } from './store.js'

/**
 * 会话摘要内容上限（字符）（G5 防腐化）：压缩摘要可长达上万字符（审计实测
 * 52 条 active 摘要累计 354K 字符 ≈ 88K token），摘要链再摘要的信息损失被
 * 无损放大且挤占检索预算——超限截断并加标记（lost-in-compaction：多保留
 * 摘要反而稀释注意力，宁可截断标注）。
 */
const SUMMARY_MAX_CHARS = 2000

/**
 * 同会话摘要合并阈值（Jaccard）：新摘要与旧摘要重合 ≥ 此值 → 旧者归档。
 * 审计实测同一会话最多 20 份 session-summary 并存（措辞各异绕开 supersede
 * 的 0.7 阈值）——早期切片已成过时事实却照常竞争检索前排；0.5 阈值把
 * "同主题的新表述"收敛为单条现行（归档保留审计，检索只出新者）。
 */
const SUMMARY_MERGE_JACCARD = 0.5

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

/** 压缩摘要登记为会话摘要记忆（G5：截断 + 同会话旧摘要归档） */
async function recordSessionSummary(deps: SnapshotDeps, session: Session, event: Extract<SessionEvent, { type: 'compaction/summary' }>): Promise<void> {
  const summaryText = event.data.summary
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n')
  if (summaryText.trim() === '') return

  // G5：超长摘要截断并标记（防摘要链信息损失无损放大）
  const truncated =
    summaryText.length > SUMMARY_MAX_CHARS
      ? `${summaryText.slice(0, SUMMARY_MAX_CHARS)}…[摘要已截断，原文 ${summaryText.length} 字符]`
      : summaryText

  const created = await deps.store
    .create({
      workspace: session.header.cwd ?? DEFAULT_WORKSPACE,
      sessionId: session.id,
      kind: 'insight',
      content: `会话摘要：${truncated}`,
      importance: 7,
      tags: ['session-summary'],
      source: { sessionId: session.id, eventSeqs: event.data.shadowedSeqs, excerpt: truncated.slice(0, EXCERPT_MAX_CHARS) },
      by: 'system',
    })
    .then((result) => result.entry)
    .catch((error: unknown) => {
      deps.logger.warn(`[dsh-memory] 会话摘要登记失败（会话 ${session.id}）：`, error)
      return undefined
    })
  if (created === undefined) return

  // G5：同会话旧摘要与新摘要主题重合（Jaccard ≥ SUMMARY_MERGE_JACCARD）→ 归档旧者。
  // 摘要链是增量演进：旧切片已被新表述包含，检索只应出新者（归档保留审计）。
  const newTokens = new Set(tokenize(truncated))
  for (const old of deps.store.listBySession(session.id)) {
    if (old.id === created.id) continue
    if (!old.tags.includes('session-summary')) continue
    if (old.status !== 'active') continue
    const oldTokens = new Set(tokenize(old.content))
    const union = new Set([...newTokens, ...oldTokens])
    if (union.size === 0) continue
    const jaccard = [...newTokens].filter((token) => oldTokens.has(token)).length / union.size
    if (jaccard >= SUMMARY_MERGE_JACCARD) {
      await deps.store.archive(old.id, 'system').catch(() => {
        // 归档失败仅告警（不影响新摘要登记）
        deps.logger.warn(`[dsh-memory] 旧会话摘要归档失败（${old.id}）：`)
      })
      deps.logger.info(`[dsh-memory] 旧会话摘要已归档（${old.id}，Jaccard ${jaccard.toFixed(2)}）`)
    }
  }
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
      source: { sessionId: session.id, eventSeqs: [], excerpt: content.slice(0, EXCERPT_MAX_CHARS) },
      by: 'system',
    })
    .catch((error: unknown) => {
      deps.logger.warn(`[dsh-memory] 会话快照写入失败（会话 ${session.id}）：`, error)
    })
}
