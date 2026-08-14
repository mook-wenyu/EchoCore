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
