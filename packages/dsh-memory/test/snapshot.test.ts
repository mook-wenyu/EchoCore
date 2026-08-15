/**
 * 会话快照与跨会话检索单元测试。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { registerSnapshot } from '../src/snapshot.js'
import { MemoryStore } from '../src/store.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 构造会话 */
function makeSession(id: string, cwd = 'D:/workspace', createdAt = 1000): Session {
  return { id, header: { version: 0, id, createdAt, cwd }, events: [] } as unknown as Session
}

/** 构造 compaction/summary 事件（带文本摘要） */
function summaryEvent(seq: number, shadowedSeqs: number[], summaryText: string): SessionEvent {
  return {
    type: 'compaction/summary',
    seq,
    time: seq,
    data: {
      compactionId: `c${seq}`,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: shadowedSeqs[0] ?? 0, end: shadowedSeqs.at(-1) ?? 0 },
      shadowedSeqs,
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
      rawOutput: [],
      llmStreamCall: true,
    },
  } as SessionEvent
}

describe('registerSnapshot', () => {
  it('压缩摘要登记为会话摘要记忆（insight + session-summary 标签）', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    registerSnapshot(ctx as unknown as Context, { store, logger: { warn: () => {}, info: () => {} } })

    const session = makeSession('s1')
    ;(ctx.listener('session/event') as (s: Session, e: SessionEvent) => void)(session, summaryEvent(5, [2, 3, 4], '本轮完成了记忆系统架构设计'))

    // 快照登记为异步 fire-and-forget，等待落地
    await new Promise((resolve) => setTimeout(resolve, 0))
    const entries = store.listBySession('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('insight')
    expect(entries[0]?.tags).toContain('session-summary')
    expect(entries[0]?.content).toContain('记忆系统架构设计')
    expect(entries[0]?.source.eventSeqs).toEqual([2, 3, 4])
    expect(entries[0]?.audit.at(-1)).toMatchObject({ by: 'system' })
  })

  it('空摘要不登记', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    registerSnapshot(ctx as unknown as Context, { store, logger: { warn: () => {}, info: () => {} } })
    ;(ctx.listener('session/event') as (s: Session, e: SessionEvent) => void)(makeSession('s1'), summaryEvent(5, [2], ''))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.stats().total).toBe(0)
  })

  it('G5 超长摘要截断并标记（原文长度可见，防摘要链损失无损放大）', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    registerSnapshot(ctx as unknown as Context, { store, logger: { warn: () => {}, info: () => {} } })
    const longText = '架构设计说明：'.repeat(300) // 约 2400 字符 > 2000 上限
    ;(ctx.listener('session/event') as (s: Session, e: SessionEvent) => void)(makeSession('s1'), summaryEvent(5, [2], longText))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const entries = store.listBySession('s1')
    expect(entries).toHaveLength(1)
    const content = entries[0]?.content ?? ''
    expect(content).toContain('…[摘要已截断，原文')
    expect(content).toContain(`${longText.length} 字符]`)
  })

  it('G5 同会话旧摘要与新摘要主题重合（Jaccard≥0.5）→ 旧者归档，检索只出新者', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    registerSnapshot(ctx as unknown as Context, { store, logger: { warn: () => {}, info: () => {} } })
    const listener = ctx.listener('session/event') as (s: Session, e: SessionEvent) => void
    // 第一次压缩：登记摘要 A
    listener(makeSession('s1'), summaryEvent(5, [2, 3], '本轮完成了记忆系统架构设计，确定轻量评分检索方案'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 第二次压缩：登记高度重合的摘要 B（同主题演进）
    listener(makeSession('s1'), summaryEvent(10, [6, 7, 8], '本轮完成了记忆系统架构设计，确定轻量评分检索方案，并补充了维护机制'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const entries = store.listBySession('s1')
    const summaries = entries.filter((entry) => entry.tags.includes('session-summary'))
    // 旧摘要被归档（active 只剩 1 份新摘要）
    expect(summaries.filter((entry) => entry.status === 'active')).toHaveLength(1)
    expect(summaries.filter((entry) => entry.status === 'archived')).toHaveLength(1)
    expect(summaries.find((entry) => entry.status === 'active')?.content).toContain('维护机制')
  })

  it('会话结束时写快照记录（含记忆规模统计）', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    registerSnapshot(ctx as unknown as Context, { store, logger: { warn: () => {}, info: () => {} } })

    // 会话期间产生 1 条记忆
    await store.create({
      workspace: 'D:/workspace',
      sessionId: 's1',
      kind: 'fact',
      content: '事实甲',
      source: { sessionId: 's1', eventSeqs: [1], excerpt: '' },
      by: 'extractor',
    })

    const agent = { id: 's1', session: makeSession('s1') }
    ;(ctx.listener('agent/disposed') as (p: { agent: { id: string; session: Session } }) => void)({ agent })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const entries = store.listBySession('s1')
    expect(entries).toHaveLength(2)
    const snapshot = entries.find((entry) => entry.tags.includes('snapshot'))
    expect(snapshot).toBeDefined()
    expect(snapshot?.content).toContain('会话快照')
    expect(snapshot?.content).toContain('记忆 1 条')
  })
})

describe('跨会话检索（Phase 5 验收）', () => {
  it('同 workspace 的新会话可检索历史会话记忆；他 workspace 不可见', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table)

    // 会话 A（D:/workspace）产生记忆
    await store.create({
      workspace: 'D:/workspace',
      sessionId: 'session-a',
      kind: 'decision',
      content: '决定：采用内置轻量评分检索',
      importance: 9,
      tags: ['架构'],
      source: { sessionId: 'session-a', eventSeqs: [1], excerpt: '…' },
      by: 'extractor',
    })
    // 会话 C（D:/other）产生记忆
    await store.create({
      workspace: 'D:/other',
      sessionId: 'session-c',
      kind: 'fact',
      content: '另一个项目的技术栈',
      source: { sessionId: 'session-c', eventSeqs: [1], excerpt: '…' },
      by: 'extractor',
    })

    // 会话 B：同一 workspace，检索"评分检索"
    const results = store.search({ query: '评分检索', workspace: 'D:/workspace' })
    expect(results).toHaveLength(1)
    expect(results[0]?.sessionId).toBe('session-a')

    // 会话 B 检索"技术栈"：看不到他项目的记忆
    const other = store.search({ query: '技术栈', workspace: 'D:/workspace' })
    expect(other).toHaveLength(0)
  })
})
