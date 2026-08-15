/**
 * 提取器编排单元测试：双通道触发、水位推进、阈值累计、失败重试、开关。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { MemoryExtractor, type ExtractorConfig } from '../src/extractor.js'
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

/** 配置工厂 */
function config(overrides: Partial<ExtractorConfig> = {}): ExtractorConfig {
  return {
    enableExtractor: true,
    minExtractChars: 100,
    maxExtractChars: 12000,
    extractMaxTokens: 100,
    ...overrides,
  }
}

/** 组装被测对象 */
function setup(options: { output?: string | Error; config?: ExtractorConfig } = {}) {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const llm = new FakeLlm(options.output ?? '{"memories":[{"kind":"fact","content":"项目使用 pnpm","importance":7}]}')
  const logger = { warn: () => {}, info: () => {} }
  const extractor = new MemoryExtractor({ store, llm, logger, config: config(options.config) })
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

    session.events.push(userEvent(4, '这是一条足够长的消息内容用来凑足最小提取字符阈值'.repeat(6)), turnEndEvent(5, 2))
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
      userEvent(2, '第一轮：用户提出需求甲'.repeat(15)),
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
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '甲'.repeat(200)), turnEndEvent(3, 1)])
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
    const extractor = new MemoryExtractor({ store, llm: failing, logger, config: config() })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    if (listener === undefined) throw new Error('监听未注册')

    const session = makeSession('s1', [headerEvent(1), userEvent(2, '乙'.repeat(200)), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(failing.calls).toBe(1)
    expect(store.stats().total).toBe(0)

    // 换健康 llm 后重试：同一批次应被重新提取
    const healthy = new FakeLlm('{"memories":[{"kind":"fact","content":"重试成功"}]}')
    const extractor2 = new MemoryExtractor({ store, llm: healthy, logger, config: config() })
    const ctx2 = new FakeCtx()
    extractor2.install(ctx2 as unknown as Context)
    const listener2 = ctx2.listener('session/event')
    if (listener2 === undefined) throw new Error('监听未注册')
    listener2(session, turnEndEvent(5, 2))
    await settle()
    expect(healthy.calls).toBe(1)
    expect(store.stats().total).toBe(1)
  })

  it('enableExtractor=false 时完全静默', async () => {
    const { llm, listener } = setup({ config: { enableExtractor: false, minExtractChars: 100, maxExtractChars: 12000, extractMaxTokens: 100 } })
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '丙'.repeat(300)), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(0)
  })

  it('无路由时跳过提取并告警', async () => {
    const { llm, listener } = setup()
    const session = makeSession('s1', [userEvent(1, '丁'.repeat(300)), turnEndEvent(2, 1)])
    listener(session, session.events[0] as SessionEvent)
    listener(session, session.events[1] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(0)
  })
})

describe('MemoryExtractor 长文本截断（O1-3 maxExtractChars）', () => {
  function makeExtractor(overrides: Partial<ExtractorConfig>) {
    const warns: string[] = []
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable())
    const llm = new FakeLlm('{"memories":[{"kind":"fact","content":"最新片段","importance":6}]}')
    const extractor = new MemoryExtractor({
      store,
      llm,
      logger: { warn: (m: string) => warns.push(m), info: () => {} },
      config: {
        enableExtractor: true,
        minExtractChars: 5,
        maxExtractChars: 12000,
        extractMaxTokens: 100,
        ...overrides,
      },
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    if (listener === undefined) throw new Error('监听未注册')
    return { warns, llm, listener, store }
  }

  it('超限时截尾保最新，且在 \\n 边界切', async () => {
    const { warns, llm, listener } = makeExtractor({ maxExtractChars: 40 })
    // 文本远超上限：头部"旧内容"应在截断中被丢弃，保留尾部
    const text = `${'旧内容'.repeat(20)}\n${'新内容'.repeat(20)}`
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
    const { warns, llm, listener } = makeExtractor({ maxExtractChars: 5000 })
    const text = '完整内容会被完整保留下来'
    const session = makeSession('s1', [headerEvent(1), userEvent(2, text), turnEndEvent(3, 1)])
    listener(session, session.events[1] as SessionEvent)
    listener(session, session.events[2] as SessionEvent)
    await settle()
    expect(warns).toHaveLength(0)
    expect(llm.lastTranscript).toContain('完整内容会被完整保留下来')
  })

  it('compaction 通道同样截断', async () => {
    const { warns, llm, listener } = makeExtractor({ maxExtractChars: 40 })
    const long = '被压缩的长文本内容'.repeat(10)
    const session = makeSession('s1', [headerEvent(1), userEvent(2, long), assistantEvent(3, 'OK')])
    session.events.push(compactionSummaryEvent(4, [2, 3]))
    listener(session, session.events[3] as SessionEvent)
    await settle()
    expect(llm.calls).toBe(1)
    expect(warns.length).toBeGreaterThan(0)
    expect(llm.lastTranscript.length).toBeLessThan(100)
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
      config: config({ minExtractChars: 1000 }), // 远高于文本量，正常路径不会触发
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    const dispose = ctx.listener('agent/disposed')
    if (listener === undefined || dispose === undefined) throw new Error('监听未注册')
    const session = makeSession('s1', [headerEvent(1), userEvent(2, '短文本'), turnEndEvent(3, 1)])
    // 文本量 < minExtractChars(1000)：增量通道只挂起不提取
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
      config: config({ minExtractChars: 1000 }),
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
      config: config({ minExtractChars: 1000 }),
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
      config: config({ minExtractChars: 5 }), // 阈值低于测试文本，确保每回合都触发提取
    })
    extractor.install(ctx as unknown as Context)
    const listener = ctx.listener('session/event')
    if (listener === undefined) throw new Error('session/event 监听未注册')

    // 两个回合背靠背投递（第二条在第一条处理中被阻塞时入队）
    const session = makeSession('s1', [
      headerEvent(1),
      userEvent(2, '第一条记忆文本'),
      turnEndEvent(10, 1),
      userEvent(11, '第二条记忆文本'),
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
})
