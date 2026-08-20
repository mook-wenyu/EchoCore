/**
 * balanced-json 单元测试：验证 extractBalancedJson 单源实现的 3 类核心行为
 * - 覆盖：正常提取、花括号在字符串内的跳过、转义与不完整输入的容错
 * - 约束：中文注释、DRY 单测一次
 */

import { describe, expect, it } from 'vitest'

import { extractBalancedJson } from '../src/utils/balanced-json.js'

describe('extractBalancedJson', () => {
  it('正常提取：前后干扰 + 字符串内花括号应被跳过，只取首个平衡对象', () => {
    // 前后有说明文字，JSON 字符串值内含 `}` 不应计入深度
    const text = '以下是结果：{"a":"}","b":{"c":1}} 尾部说明 } 忽略'
    const result = extractBalancedJson(text)
    expect(result).toBe('{"a":"}","b":{"c":1}}')
    // 验证可被 JSON.parse 正确解析
    expect(JSON.parse(result!)).toEqual({ a: '}', b: { c: 1 } })
    // 多段 JSON 时只取首个平衡对象
    const multi = 'prefix {"first":1} middle {"second":2}'
    expect(extractBalancedJson(multi)).toBe('{"first":1}')
  })

  it('转义处理：字符串内的转义引号与反斜杠不应破坏状态机，嵌套对象正常闭合', () => {
    // 字符串内含转义的引号与 `}`，应正确识别字符串边界
    const text = '{"text":"he said \\"hi }\\" and \\\\","nested":{"x":2}} after'
    const result = extractBalancedJson(text)
    expect(result).toBe('{"text":"he said \\"hi }\\" and \\\\","nested":{"x":2}}')
    expect(JSON.parse(result!)).toEqual({ text: 'he said "hi }" and \\', nested: { x: 2 } })
  })

  it('容错：无左括号、只有左括号或不平衡时返回 undefined', () => {
    // 无 `{` 返回 undefined
    expect(extractBalancedJson('没有 json 纯文本')).toBeUndefined()
    expect(extractBalancedJson('')).toBeUndefined()
    // 只有左括号未闭合返回 undefined
    expect(extractBalancedJson('{"a":1')).toBeUndefined()
    expect(extractBalancedJson('前缀 { 不完整')).toBeUndefined()
  })
})
