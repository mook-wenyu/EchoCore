/**
 * 提取器编排单元测试：双通道触发、水位推进、阈值累计、失败重试、开关。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { MemoryExtractor } from '../src/extractor.js'
import { MemoryStore } from '../src/store.js'
import { FakeCtx, FakeTable, settle } from './helpers.js'

/** 假 llm：记录调用次数与摘录文本，按设定返回 JSON 或抛错 */
class FakeLlm {
  calls = 0
  lastTranscript = ''
  constructor(private readonly output: string | Error) {}
  async *stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> {
    this.calls++
    const transcript = (options.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text ?? ''
    this.lastTranscript = transcript
    if (this.output instanceof Error) throw this.output
    yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
    yield { type: 'text-delta', index: 0, text: this.output } as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.output } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
}

/** 构造会话（header 带 cwd，events 可填充） */
function makeSession(id: string, events: SessionEvent[]): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 1, cwd: 'D:/workspace' },
    events,
  } as unknown as Session
}

/** 构造 user/message 事件 */
function userEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  } as SessionEvent
}

/** 构造 assistant/message 事件 */
function assistantEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
    },
  } as SessionEvent
}

/** 构造 request/header 事件（提取路由来源） */
function headerEvent(seq: number): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: seq,
    data: { header: { config: { provider: 'deepseek', model: 'm' } }, reason: 'initial' },
  } as SessionEvent
}

/** 构造 turn/end 事件 */
function turnEndEvent(seq: number, turn: number): SessionEvent {
  return { type: 'turn/end', seq, time: seq, data: { turn, reason: { kind: 'complete' } } } as SessionEvent
}

/** 构造 agent/disposed 事件载荷 */
function disposePayload(id: string, session: Session): { agent: { id: string; session: Session } } {
  return { agent: { id, session } }
}

/**
 * 构造足以越过模块常量 MIN_EXTRACT_CHARS=2000 的长文本（供增量通道触发提取）。
 * 配置常量化后阈值固定为 2000 字符，测试文本必须超过它才能驱动增量提取。
 */
function longText(seed: string, targetChars = 2200): string {
  return seed.repeat(Math.ceil(targetChars / seed.length))
}

/** 构造超过模块常量 MAX_EXTRACT_CHARS=12000 的长文本（供截尾测试） */
function veryLongText(seed: string, targetChars = 14000): string {
  return seed.repeat(Math.ceil(targetChars / seed.length))
}

/** 构造 compaction/summary 事件 */
function compactionSummaryEvent(seq: number, shadowedSeqs: number[]): SessionEvent {
  return {
    type: 'compaction/summary',
    seq,
    time: seq,
    data: {
      compactionId: `c${seq}`,
      summary: [{ type: 'text', text: '摘要' }],
      shadowedRange: { start: shadowedSeqs[0] ?? 0, end: shadowedSeqs.at(-1) ?? 0 },
      shadowedSeqs,
      shadowedTokenCount: 0,
      provider: 'deepseek',
      model: 'm',
      rawOutput: [],
      llmStreamCall: true,
    },
  } as SessionEvent
}

/** 组装被测对象（配置常量化后：提取极参数已固化为模块常量
 * MIN_EXTRACT_CHARS=2000 / MAX_EXTRACT_CHARS=12000 / EXTRACT_MAX_TOKENS=2048，
 * 不再经 config 注入，构造只传 store/llm/logger）。 */
function setup(options: { output?: string | Error } = {}) {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const llm = new FakeLlm(options.output ?? '{"memories":[{"kind":"fact","content":"项目使用 pnpm","importance":7}]}')
  const logger = { warn: () => {}, info: () => {} }
  const extractor = new MemoryExtractor({ store, llm, logger })
  extractor.install(ctx as unknown as Context)
  const listener = ctx.listener('session/event')
  if (listener === undefined) throw new Error('session/event 监听未注册')
  return { ctx, store, llm, listener }
}

describe('MemoryExtractor 通道 B（增量）', () => {
  it('低于阈值时累计不调用 LLM，达到阈值才提取', async () => {
    const { store, llm, listener } = setup()
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '短消息'), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(0) // 文本不足阈值

    session.events.push(userEvent(4, longText('这是一条足够长的消息内容用来凑足最小提取字符阈值')), turnEndEvent(5, 2))
    listener(session, session.events[3] as SessionEvent)
    listener(session, session.events[4] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
    expect(store.stats().total).toBe(1)
    const entry = store.listBySession('s1')[0]
    expect(entry?.content).toBe('项目使用 pnpm')
    expect(entry?.source.sessionId).toBe('s1')
  })

  it('提取调用文本包含累计的全部消息', async () => {
    const { llm, listener } = setup()
    const session = makeSession('s1', [
      headerEvent(1),
      userEvent(2, longText('第一轮：用户提出需求甲')),
      turnEndEvent(3, 1),
    ])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.lastTranscript).toContain('第一轮')
  })
})

describe('MemoryExtractor 通道 A（压缩遮蔽）', () => {
  it('立即提取被遮蔽跨度（不受阈值限制）', async () => {
    const { store, llm, listener } = setup()
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '被遮蔽的事实：使用 vite'), assistantEvent(3, '确认')])
    // 模拟：压缩遮蔽 [2,3] 区间
    session.events.push(compactionSummaryEvent(4, [2, 3]))
    listener(session, session.events[3] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
    expect(store.stats().total).toBe(1)
    const entry = store.listBySession('s1')[0]
    expect(entry?.source.eventSeqs).toEqual([2, 3])
  })

  it('已处理过的序号不会重复提取（水位防护）', async () => {
    const { store, llm, listener } = setup()
    const session = makeSession('s1', [headerEvent(1), userEvent(2, longText('甲')), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
    // 再次触发压缩遮蔽同一跨度：不重复提取
    session.events.push(compactionSummaryEvent(4, [1, 2, 3]))
    listener(session, session.events[3] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
  })
})

describe('MemoryExtractor 失败与开关', () => {
  it('LLM 失败不推进水位：下次触发重试成功', async () => {
    const failing = new FakeLlm(new Error('模型不可用'))
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    const logger = { warn: () => {}, info: () => {} }
    const extractor = new MemoryExtractor({ store, llm: failing, logger })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    if (listener === undefined) throw new Error('监听未注册')

    const session = makeSession('s1', [headerEvent(1), userEvent(2, longText('乙')), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(failing.calls).toBe(1)
    expect(store.stats().total).toBe(0)

    // 换健康 llm 后重试：同一批次应被重新提取
    const healthy = new FakeLlm('{"memories":[{"kind":"fact","content":"重试成功"}]}')
    const extractor2 = new MemoryExtractor({ store, llm: healthy, logger })
    const ctx2 = new FakeCtx()
    extractor2.install(ctx2 as unknown as Context)
    const listener2 = ctx2.listener('session/event')
    if (listener2 === undefined) throw new Error('监听未注册')
    listener2(session, turnEndEvent(5, 2))
    await settle()
    expect(healthy.calls).toBe(1)
    expect(store.stats().total).toBe(1)
  })

  it('无路由时跳过提取并告警', async () => {
    const { llm, listener } = setup()
    const session = makeSession('s1', [userEvent(1, longText('丁')), turnEndEvent(2, 1)])
    listener(session, session.events[0] as SessionEvent)
    listener(session, session.events[1] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(0)
  })
})

describe('MemoryExtractor 长文本截断（O1-3 maxExtractChars）', () => {
  // 配置常量化后截断阈值固化为 MAX_EXTRACT_CHARS=12000，无法再按用例调小；
  // 因此截断用例改用 >12000 的真实长文来驱动"超限截尾"，而"未超限"用例用
  // 介于 MIN_EXTRACT_CHARS(2000) 与 12000 之间的文本验证原样保留。
  function makeExtractor() {
    const warns: string[] = []
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    const llm = new FakeLlm('{"memories":[{"kind":"fact","content":"最新片段","importance":6}]}')
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: (m: string) => warns.push(m), info: () => {} },
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    if (listener === undefined) throw new Error('监听未注册')
    return { warns, llm, listener, store }
  }

  it('超限时截尾保最新，且在 \\n 边界切', async () => {
    const { warns, llm, listener } = makeExtractor()
    // 文本远超 MAX_EXTRACT_CHARS(12000)：头部"旧内容"应在截断中被丢弃，保留尾段"新内容"
    const text = `${'旧内容'.repeat(100)}\n${veryLongText('新内容')}`
    const session = makeSession('s1', [headerEvent(1), userEvent(2, text), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
    expect(llm.lastTranscript).not.toContain('旧内容')
    expect(llm.lastTranscript).toContain('新内容')
    expect(warns.length).toBeGreaterThan(0)
  })

  it('未超限时保留完整文本且不 warn', async () => {
    const { warns, llm, listener } = makeExtractor()
    // 文本介于 MIN_EXTRACT_CHARS(2000) 与 MAX_EXTRACT_CHARS(12000) 之间：
    // 能触发增量提取，但不足截断阈值 → 原样保留、无告警
    const text = longText('完整内容会被完整保留下来')
    const session = makeSession('s1', [headerEvent(1), userEvent(2, text), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(warns).toHaveLength(0)
    expect(llm.lastTranscript).toContain('完整内容会被完整保留下来')
    expect(llm.lastTranscript.length).toBeGreaterThanOrEqual(2000) // 未截断
  })

  it('compaction 通道同样截断', async () => {
    const { warns, llm, listener } = makeExtractor()
    const long = veryLongText('被压缩的长文本内容')
    const session = makeSession('s1', [headerEvent(1), userEvent(2, long), assistantEvent(3, 'OK')])
    session.events.push(compactionSummaryEvent(4, [2, 3]))
    listener(session, session.events[3] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
    expect(warns.length).toBeGreaterThan(0)
    // 截尾后摘录长度应明显小于原文（>12000 被压到 ≤12000）
    expect(llm.lastTranscript.length).toBeLessThan(long.length)
  })
})

describe('MemoryExtractor 会话结束 flush（O1-4）', () => {
  it('disposed 触发遗留批次立即提取（不等阈值）', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    const llm = new FakeLlm('{"memories":[{"kind":"fact","content":"遗留批次","importance":6}]}')
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: () => {}, info: () => {} },
      // 配置常量化后阈值固定 MIN_EXTRACT_CHARS=2000，远高于"短文本"量，
      // 增量通道正常路径不会触发（只挂起），交由会话结束 flush 提取
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    const dispose = ctx.listener('agent/disposed')
    if (listener === undefined || dispose === undefined) throw new Error('监听未注册')
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '短文本'), turnEndEvent(3, 1)])
    // 文本量 < minExtractChars(2000)：增量通道只挂起不提取
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(0)
    // 会话结束：flush 遗留批次
    dispose(disposePayload('s1', session))
    await settle()
    expect(llm.calls).toBe(1)
    expect(store.stats().total).toBe(1)
  })

  it('disposed 清理遗留批次，重复 dispose 不重复提取', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    const llm = new FakeLlm('{"memories":[]}')
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: () => {}, info: () => {} },
      // 配置常量化：MIN_EXTRACT_CHARS=2000 远高于"短文本"，增量路径只挂起，
      // 交由会话结束 flush 统一提取
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    const dispose = ctx.listener('agent/disposed')
    if (listener === undefined || dispose === undefined) throw new Error('监听未注册')
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '短文本'), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(0)
    dispose(disposePayload('s1', session))
    await settle()
    expect(llm.calls).toBe(1)
    // 再次 dispose：批次已清理，不应重复提取
    dispose(disposePayload('s1', session))
    await settle()
    expect(llm.calls).toBe(1)
  })

  it('flush 失败时 warn 一次并仍清理', async () => {
    const ctx = new FakeCtx()
    const table = new FakeTable()
    const store = new MemoryStore(table)
    const llm = new FakeLlm(new Error('模型不可用'))
    const warns: string[] = []
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: (m: string) => warns.push(m), info: () => {} },
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    const dispose = ctx.listener('agent/disposed')
    if (listener === undefined || dispose === undefined) throw new Error('监听未注册')
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '短文本'), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    dispose(disposePayload('s1', session))
    await settle()
    expect(warns.length).toBeGreaterThan(0)
    expect(store.stats().total).toBe(0)
    // 已清理：后续 dispose 不再尝试
    dispose(disposePayload('s1', session))
    await settle()
    expect(llm.calls).toBe(1)
  })
})

describe('提取器串行链并发（O7 竞态防回归）', () => {
  it('两事件背靠背入队：串行处理不交错、水位按序推进、无事件丢失', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    // 闸门式假 llm：第一次调用阻塞到 release，制造"处理未完成时下一事件入队"的窗口
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transcripts: string[] = []
    const llm = {
      async *stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> {
        const transcript = (options.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text ?? ''
        transcripts.push(transcript)
        await gate // 阻塞：模拟慢 LLM，制造链上堆积
        yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
        yield { type: 'text-delta', index: 0, text: '{"memories":[]}' } as StreamChunk
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"memories":[]}' } } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      },
    }
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: () => {}, info: () => {} },
      // 配置常量化：MIN_EXTRACT_CHARS=2000；两回合消息均用 longText 越过阈值
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    if (listener === undefined) throw new Error('session/event 监听未注册')

    // 两个回合背靠背投递（第二条在第一条处理中被阻塞时入队）
    const session = makeSession('s1', [
      headerEvent(1),
      userEvent(2, longText('第一条记忆文本')),
      turnEndEvent(10, 1),
      userEvent(11, longText('第二条记忆文本')),
      turnEndEvent(20, 2),
    ])
    listener(session, session.events[2] as SessionEvent) // turnEnd(10)
    listener(session, session.events[4] as SessionEvent) // turnEnd(20)——第一条仍在链上阻塞
    await settle()
    // 释放闸门：两条处理按入队顺序完成
    release()
    await settle()

    expect(transcripts.length).toBe(2)
    expect(transcripts[0]).toContain('第一条记忆文本')
    expect(transcripts[1]).toContain('第二条记忆文本')
    // 串行不交错：第二条摘录不含第一条的批次（水位按序推进，无重复处理）
    expect(transcripts[1]).not.toContain('第一条记忆文本')
    expect(store.stats().total).toBe(0) // 摘录返回空 memories，无写入
  })

  it('dispose 时链上另有批次：flush 排队其后执行，串行不交错（P1-2 补盲）', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    // 闸门式假 llm：第一批阻塞到 release，制造"dispose 时批次仍在链上"的窗口
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transcripts: string[] = []
    const llm = {
      async *stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> {
        const transcript = (options.messages as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text ?? ''
        transcripts.push(transcript)
        await gate
        yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
        yield { type: 'text-delta', index: 0, text: '{"memories":[{"kind":"fact","content":"提取的事实"}]}' } as StreamChunk
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"memories":[{"kind":"fact","content":"提取的事实"}]}' } } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      },
    }
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: () => {}, info: () => {} },
      // 配置常量化：MIN_EXTRACT_CHARS=2000；用 longText 使批次越过阈值立即入链
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    const dispose = ctx.listener('agent/disposed')
    if (listener === undefined || dispose === undefined) throw new Error('监听未注册')

    const session = makeSession('s1', [headerEvent(1), userEvent(2, longText('待提取文本')), turnEndEvent(10, 1)])
    listener(session, session.events[2] as SessionEvent) // turnEnd 触发批次入链（阻塞中）
    await settle()
    // dispose 在批次未完成时到达：flush 应排队在链后，不打断在途批次
    dispose(disposePayload('s1', session))
    await settle()
    expect(store.stats().total).toBe(0) // 批次仍阻塞，未写入
    release()
    await settle()
    // 批次完成后 flush 排队执行：无异常、提取已落库、清理幂等
    expect(store.stats().total).toBe(1)
    dispose(disposePayload('s1', session))
    await settle()
    expect(transcripts.length).toBe(1) // flush 不重复提取
  })
})
