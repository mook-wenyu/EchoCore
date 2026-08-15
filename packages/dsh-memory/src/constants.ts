/**
 * @module @echocore/dsh-memory/constants
 *
 * 跨模块共享常量。
 */

/** 本插件包 id（用于消息来源标记与注入自检） */
export const MEMORY_PLUGIN_ID = '@echocore/dsh-memory'

/** 来源摘录最大字符数（审计展示原文依据，免读历史日志） */
export const EXCERPT_MAX_CHARS = 400

/** workspace 缺失时的回退键 */
export const DEFAULT_WORKSPACE = 'default'

/**
 * 会话短 id：去 `session-` 前缀后取前 8 位。
 * 会话 id 形如 `session-63bbf845-9e8d-…`——直接 slice(0,8) 只截到前缀本身，
 * 渲染出的"来自会话 session-"毫无区分度（用户报告 bug）。本函数取 uuid 主体
 * 前 8 位；无前缀的纯 uuid 同样兼容。
 */
export function shortSessionId(sessionId: string): string {
  const body = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return body.slice(0, 8)
}
