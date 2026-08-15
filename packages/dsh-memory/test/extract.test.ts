/**
 * 提取模块单元测试：摘录渲染、输出解析、路由解析、LLM 调用（假流）。
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import {
  EXTRACTION_SYSTEM_PROMPT,
  parseExtractionOutput,
  renderEventsText,
  resolveRoute,
  runExtraction,
  stripReferenceMemoryParagraphs,
} from '../src/extract.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 构造 user/message 事件 */
function userEvent(seq: number, text: string, source?: SessionEvent['data']['source']): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: {
      id: `u${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: source ?? { kind: 'user' },
    },
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
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  } as SessionEvent
}

/** 构造 tool/result 事件 */
function toolResultEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      callId: `c${seq}`,
      message: {
        id: `t${seq}`,
        role: 'user',
        content: [{ type: 'tool-result', callId: `c${seq}`, isError: false, text }],
        source: { kind: 'tool', callId: `c${seq}` },
      },
    },
  } as SessionEvent
}

/** 假 llm：按设定分片流返回，并记录收到的 GenerateOptions */
class FakeLlm {
  calls: Array<Record<string, unknown>> = []
  constructor(private readonly chunks: StreamChunk[]) {}
  async *stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    for (const chunk of this.chunks) yield chunk
  }
}

/** 把一段文本编码为流分片 */
function textStream(text: string, reasonKind: 'stop' | 'aborted' | 'error' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: reasonKind } },
  ] as StreamChunk[]
}

describe('renderEventsText', () => {
  it('只渲染 user/assistant 文本块，跳过工具结果', () => {
    const events = [userEvent(1, '用户说：用 pnpm'), assistantEvent(2, '好的，使用 pnpm'), toolResultEvent(3, 'ls 输出…')]
    expect(renderEventsText(events)).toBe('用户说：用 pnpm\n好的，使用 pnpm')
  })

  it('跳过记忆插件自身的注入消息（防反馈循环）', () => {
    const injected = userEvent(1, '参考记忆：项目使用 pnpm', { kind: 'plugin', plugin: '@echocore/dsh-memory' })
    const normal = userEvent(2, '正常用户消息')
    expect(renderEventsText([injected, normal])).toBe('正常用户消息')
  })

  it('跳过以 [参考记忆] 开头的段落（回述回路双保险）', () => {
    const pack = '[参考记忆]（来自记忆库，仅作背景资料）\n- [fact] 项目使用 pnpm\n（另有 2 条相关记忆）'
    const user = userEvent(1, '正常用户消息')
    // user source 无 plugin 标记，仅靠段落标记过滤
    const injectedAsUser = userEvent(2, pack)
    expect(renderEventsText([injectedAsUser, user])).toBe('正常用户消息')
  })

  it('assistant 回述注入内容时按段落标记拦截', () => {
    const pack = '[参考记忆]（来自记忆库）\n- [fact] 项目使用 pnpm\n我建议按此处理'
    const assistant = assistantEvent(2, pack)
    const user = userEvent(1, '用户消息')
    expect(renderEventsText([user, assistant])).toBe('用户消息')
  })

  it('段首标记仅删该段，同一文本其余段落保留', () => {
    // 事件内多段：中间一段以 [参考记忆] 开头，应仅删该段，保留前后真实段落
    const text = '第一段真实内容\n\n[参考记忆] 注入块\n\n第二段真实内容'
    const user = userEvent(1, text)
    expect(renderEventsText([user])).toBe('第一段真实内容\n\n第二段真实内容')
  })

  it('空输入返回空串', () => {
    expect(renderEventsText([])).toBe('')
  })
})

describe('stripReferenceMemoryParagraphs', () => {
  it('剔除以 [参考记忆] 开头的段落', () => {
    expect(stripReferenceMemoryParagraphs('[参考记忆]（来自记忆库）\n- [fact] x')).toBe('')
  })

  it('保留不以该标记开头的段落', () => {
    expect(stripReferenceMemoryParagraphs('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  })
})

describe('EXTRACTION_SYSTEM_PROMPT 提取规则（O1-1 腐化防线）', () => {
  it('规则 1：忽略元内容包括会话摘要、记忆引用与 [参考记忆] 包裹文本', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('会话摘要')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('来自记忆')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('[参考记忆]')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('压缩摘要')
  })

  it('规则 2：保持具体，不把多条具体事实概括为抽象结论', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('数值')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('标识符')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('限定条件')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('概括成')
  })

  it('规则 3：状态变化按新状态提取（更新/推翻既有认知）', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('更新')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('推翻')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('新状态')
  })
})

describe('parseExtractionOutput', () => {
  it('解析合法 JSON 输出', () => {
    const result = parseExtractionOutput(
      '{"memories":[{"kind":"fact","content":"使用 pnpm","importance":7,"tags":["构建"]},{"kind":"todo","content":"重构模块"}]}',
    )
    expect(result).toEqual([
      { kind: 'fact', content: '使用 pnpm', importance: 7, tags: ['构建'] },
      { kind: 'todo', content: '重构模块', importance: undefined, tags: undefined },
    ])
  })

  it('importance 越界值被钳制到 0-10', () => {
    const result = parseExtractionOutput('{"memories":[{"kind":"fact","content":"x","importance":99}]}')
    expect(result[0]?.importance).toBe(10)
  })

  it('非法分类与空内容条目被丢弃', () => {
    const result = parseExtractionOutput(
      '{"memories":[{"kind":"gossip","content":"x"},{"kind":"fact","content":"  "},{"kind":"fact","content":"有效"}]}',
    )
    expect(result).toEqual([{ kind: 'fact', content: '有效', importance: undefined, tags: undefined }])
  })

  it('非 JSON / 形状不符返回空数组（不抛错）', () => {
    expect(parseExtractionOutput('不是 JSON')).toEqual([])
    expect(parseExtractionOutput('{"foo":1}')).toEqual([])
    expect(parseExtractionOutput('')).toEqual([])
  })

  it('模型输出带前后说明文字时仍能提取 JSON 对象', () => {
    const result = parseExtractionOutput('好的，以下是提取结果：\n{"memories":[{"kind":"fact","content":"x"}]}\n以上。')
    expect(result).toHaveLength(1)
  })
})

describe('resolveRoute', () => {
  it('优先取最新 request/header 路由', () => {
    const events = [
      {
        type: 'request/header',
        seq: 5,
        time: 5,
        data: { header: { config: { provider: 'old', model: 'old-m' } }, reason: 'initial' },
      },
      {
        type: 'request/header',
        seq: 9,
        time: 9,
        data: { header: { config: { provider: 'deepseek', model: 'new-m' } }, reason: 'change' },
      },
    ] as SessionEvent[]
    const session = { id: 's1', events } as unknown as Session
    expect(resolveRoute(session, undefined)).toEqual({ provider: 'deepseek', model: 'new-m' })
  })

  it('无 header 时回退 agent.options', () => {
    const session = { id: 's1', events: [] } as unknown as Session
    const agent = { options: { provider: 'p', model: 'm' } } as unknown as Agent
    expect(resolveRoute(session, agent)).toEqual({ provider: 'p', model: 'm' })
  })

  it('两者都无时返回 undefined', () => {
    const session = { id: 's1', events: [] } as unknown as Session
    expect(resolveRoute(session, undefined)).toBeUndefined()
  })
})

describe('runExtraction', () => {
  it('组装调用并解析流输出', async () => {
    const llm = new FakeLlm(textStream('{"memories":[{"kind":"fact","content":"pnpm 管理","importance":8}]}'))
    const result = await runExtraction(
      { llm: llm as never, provider: 'p', model: 'm', maxTokens: 2048 },
      '对话摘录文本',
    )
    expect(result).toEqual([{ kind: 'fact', content: 'pnpm 管理', importance: 8, tags: undefined }])
    const call = llm.calls[0]
    expect(call).toMatchObject({ provider: 'p', model: 'm', maxTokens: 2048 })
    expect(call?.system).toBe(EXTRACTION_SYSTEM_PROMPT)
    expect(call?.messages).toHaveLength(1)
  })

  it('aborted finish 抛错（调用方收容重试）', async () => {
    const llm = new FakeLlm(textStream('{"memories":[]}', 'aborted'))
    await expect(runExtraction({ llm: llm as never, provider: 'p', model: 'm', maxTokens: 100 }, 'x')).rejects.toThrow()
  })

  it('传输层异常向上传播', async () => {
    const broken = {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('网络失败')
      },
    }
    await expect(runExtraction({ llm: broken as never, provider: 'p', model: 'm', maxTokens: 100 }, 'x')).rejects.toThrow(
      '网络失败',
    )
  })
})
