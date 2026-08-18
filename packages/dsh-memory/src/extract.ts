/**
 * @module @echocore/dsh-memory/extract
 *
 * 记忆提取：对话事件 → 摘录文本 → LLM 结构化提取 → 记忆条目（解析）。
 *
 * 设计要点：
 * - 提取调用复用会话当前模型路由（决策 D11）：从最新 request/header 解析，
 *   回退 agent.options；不设置 GenerateOptions.purpose（该联合为封闭集合，
 *   不冒充 compaction/session-title 语义）；
 * - 输出要求严格 JSON，解析失败整批丢弃（fail-soft，绝不阻塞主循环）；
 * - 摘录渲染跳过工具结果（噪声）与记忆插件自身的注入消息（防反馈循环）。
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  createUserMessage,
  type LlmRuntime,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { MEMORY_PLUGIN_ID } from './constants.js'
import type { ExtractedMemory, MemoryKind } from './types.js'

/** 提取系统提示词（角色界定 + 分类规则 + 输出格式约束） */
export const EXTRACTION_SYSTEM_PROMPT = `你是一个记忆提取器，为 AI 编码助手从对话摘录中提取值得长期记住的信息。

分类规则：
- fact:       客观事实（技术栈、路径、约束、版本、环境、API 行为）
- preference: 用户偏好与工作习惯（"我不喜欢 X"、"总是用 Y"）
- decision:   已做出的决定及其理由
- todo:       尚未完成的明确任务（用户明确要求但未完成）
- insight:    有价值的分析、洞察或结论

提取规则：
1. 只提取耐久信息；忽略寒暄、临时过程、工具输出细节与无关闲聊
2. 保留精确标识符、路径、命令、数值、函数签名，不得改写
3. 不编造原文没有的信息；信息不完整时如实摘录并标注不确定
4. 同一摘录中重复信息合并为一条
5. 重要性 importance（1-10）：该信息对未来决策的影响程度
6. 忽略元内容：会话摘要、'来自记忆 #xxx' 的引用、'[参考记忆]' 包裹的文本、压缩摘要——这些不是原始对话事实，不得提取
7. 保持具体：保留时间、数值、标识符与限定条件；禁止把多条具体事实概括成一句抽象结论
8. 状态变化：若摘录显示既有认知被更新或推翻（如"改用 X 替代 Y"、"不再使用 Z"），按新状态提取
9. 失败教训（需求 A，2026-08-16）：已出现并被解决的工程失败（含现象、根因与恢复办法）→ kind: insight + 自动 tags 含 '失败教训'；只记录失败而未给出恢复方案的不得入库（防止"卡死无解"污染）
10. 用户强调（需求 B，2026-08-16）：用户反复提及（≥2 次）或明确使用强调表达（"记住""务必""重点""不要再""强调"）的内容 → importance 应 ≥7（用户主观权重抬升——自动作用于衰减半衰期与快照保活）
11. self/user 相关性 selfRelevance（1-10，W2，2026-08-18）：该信息与用户本人、长期目标或当前项目主题的相关程度（用户核心诉求、反复出现的域主题 → 高；一次性事务、与用户目标无关的外部常识 → 低）。它是"该记多久/多靠前保留"的创建期初始因子，与 importance（对未来决策影响）是**两个独立维度**——importance 可高但相关性低（影响大但与用户无关的外部事件）也可以相反。

输出严格 JSON（不要输出任何其他文字）：
{"memories":[{"kind":"fact","content":"...","importance":7,"selfRelevance":7,"tags":["标签"]}]}
没有可提取内容时输出：{"memories":[]}`

/** 提取用户消息尾部指令 */
const EXTRACTION_USER_RULES = `
请依据上述规则从对话摘录中提取记忆，只输出 JSON。`

/** 有效分类集合（解析校验用） */
const MEMORY_KINDS = new Set<string>(['fact', 'preference', 'decision', 'todo', 'insight'])

/** 从内容块中拼接纯文本（只取 text 块） */
function textOf(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * 段落级回述防线：从单条摘录文本中剔除以 `[参考记忆]` 开头的段落。
 *
 * 用途（O1-2 双层防线）：
 * - 第一层在事件级：`renderEventsText` 按 source.plugin 滤掉本插件注入消息；
 * - 本层为段落级双保险：注入包文本即使被以 user 来源重放，或被 assistant
 *   逐字回述（其单条文本内嵌整个 [参考记忆] 头），也因其首个段落以该标记开头
 *   而被整段剔除——防止"从注入内容再提取记忆"的反馈循环污染训练语料。
 *
 * 实现：以 `\n\n` 切分段落，仅剔除 trimmed 首段以 `[参考记忆]` 开头的块；
 * 同一文本内其他段落（真实对话）原样保留，避免误删后续真实内容；文本中部
 * 出现的该标记不受影响（保留原文语义）。
 */
export function stripReferenceMemoryParagraphs(text: string): string {
  const paragraphs = text.split('\n\n')
  return paragraphs
    .filter((paragraph) => !paragraph.trimStart().startsWith('[参考记忆]'))
    .join('\n\n')
}

/**
 * 从事件列表渲染提取用的摘录文本。
 * 只取 user/message 与 assistant/message 的文本块；跳过工具结果（噪声）
 * 与记忆插件自身的注入消息（防"从注入内容再提取记忆"的反馈循环）。
 * 每条事件文本再经 stripReferenceMemoryParagraphs 做段落级回述防线（双保险）。
 */
export function renderEventsText(events: readonly SessionEvent[]): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'plugin' && source.plugin === MEMORY_PLUGIN_ID) continue
      parts.push(stripReferenceMemoryParagraphs(textOf(event.data.content)))
    } else if (event.type === 'assistant/message') {
      parts.push(stripReferenceMemoryParagraphs(textOf(event.data.message.content)))
    }
  }
  return parts.filter((part) => part.length > 0).join('\n')
}

/**
 * 从文本中提取第一个平衡的 JSON 对象（跳过字符串内的花括号）。
 * R2-11/M3：取代贪婪正则 `/\{[\s\S]*\}/`——后者会从首个 `{` 截到最后一个 `}`，
 * LLM 输出在 JSON 后附带含 `}` 的说明文本时会被错误吞并。
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * 解析 LLM 结构化输出为记忆列表。
 * 严格模式：非 JSON / 形状不符 / 分类非法 / 内容为空的条目一律丢弃；
 * 返回 [] 而非抛错（调用方据此判定"无可提取"）。
 */
export function parseExtractionOutput(text: string): ExtractedMemory[] {
  const match = extractBalancedJson(text)
  if (match === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(match) // match 已是提取出的完整 JSON 对象文本（extractBalancedJson）
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { memories?: unknown }).memories)) {
    return []
  }
  const result: ExtractedMemory[] = []
  for (const item of (raw as { memories: unknown[] }).memories) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.kind !== 'string' || !MEMORY_KINDS.has(record.kind)) continue
    if (typeof record.content !== 'string' || record.content.trim() === '') continue
    const importance =
      typeof record.importance === 'number' && Number.isFinite(record.importance)
        ? Math.min(Math.max(Math.round(record.importance), 0), 10)
        : undefined
    // W2：self/user 相关性同样钳制到 0..10；LLM 未输出或非法 → undefined（不参与加分）
    const selfRelevance =
      typeof record.selfRelevance === 'number' && Number.isFinite(record.selfRelevance)
        ? Math.min(Math.max(Math.round(record.selfRelevance), 0), 10)
        : undefined
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
    const parsed: ExtractedMemory = {
      kind: record.kind as MemoryKind,
      content: record.content.trim(),
      importance,
      tags,
    }
    // W2：selfRelevance 仅在 LLM 提供时出现（缺省省略键——与"可选字段"语义一致，
    // 保持既有 importance/tags 恒有键的排布不变，防破坏既有 exact-shape 断言）
    if (selfRelevance !== undefined) parsed.selfRelevance = selfRelevance
    result.push(parsed)
  }
  return result
}

/**
 * 解析会话的当前模型路由：最新 request/header → agent.options 回退。
 * 无路由返回 undefined（调用方跳过提取并告警）。
 * R2-11/M4：倒序索引遍历不构造数组（`[...events].reverse()` 每次全量拷贝）。
 */
export function resolveRoute(session: Session, agent: Agent | undefined): { provider: string; model: string } | undefined {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue // noUncheckedIndexedAccess
    if (event.type !== 'request/header') continue
    const config = event.data.header.config
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    break // 最近的 request/header 无有效路由，不再看更早的
  }
  if (agent !== undefined && agent.options.provider && agent.options.model) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/** 一次提取调用所需的依赖与参数（便于测试注入假 llm） */
export interface ExtractionCallOptions {
  llm: Pick<LlmRuntime, 'stream'>
  provider: string
  model: string
  maxTokens: number
  signal?: AbortSignal
}

/**
 * 执行一次提取调用：构建消息 → 流式调用 → 组装 → 解析。
 * 流以非正常 finish（aborted/error）结束时抛错，由调用方收容重试。
 */
export async function runExtraction(options: ExtractionCallOptions, transcript: string): Promise<ExtractedMemory[]> {
  const userText = `以下是需要提取记忆的对话摘录：\n\n${transcript}\n\n${EXTRACTION_USER_RULES}`
  const userMessage: Message = createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: MEMORY_PLUGIN_ID },
  })

  const assembler = new BlockAssembler()
  for await (const chunk of options.llm.stream({
    provider: options.provider,
    model: options.model,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [userMessage],
    maxTokens: options.maxTokens,
    signal: options.signal,
  })) {
    assembler.push(chunk)
  }
  const finishKind = assembler.finish.kind
  if (finishKind === 'aborted' || finishKind === 'error') {
    throw new Error(`记忆提取调用未正常完成（${finishKind} finish）`)
  }
  const text = assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
  return parseExtractionOutput(text)
}
