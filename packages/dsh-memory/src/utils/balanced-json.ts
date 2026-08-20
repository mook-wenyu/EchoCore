/**
 * @module @echocore/dsh-memory/utils/balanced-json
 *
 * 平衡 JSON 提取：从文本中提取首个平衡的 JSON 对象（跳过字符串内的花括号）。
 * - 取代贪婪正则 /\{[\s\S]*\}/，避免 LLM 输出在 JSON 后附带含 `}` 的说明文本时被误吞并；
 * - 单源实现，供 extract / reflect / causal 三处复用（DRY）。
 */

/**
 * 从文本中提取第一个平衡的 JSON 对象文本。
 * - 跳过字符串内的花括号（`"` 包裹区间）；
 * - 正确处理转义字符 `\"` 与 `\\`；
 * - 未找到起始 `{` 或括号不平衡时返回 undefined。
 */
export function extractBalancedJson(text: string): string | undefined {
  // 定位首个左花括号，无则直接返回
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        // 上一字符为转义反斜杠，当前字符被转义，重置标记
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
