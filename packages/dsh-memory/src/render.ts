/**
 * @module @echocore/dsh-memory/render
 *
 * 记忆条目渲染单源（R2-7/B7）：
 * - injector 的自动注入包逐条 bullet 与 tools 的工具输出行共用同一格式，
 *   此前两处各自实现（DRY 违例，改格式时容易漂移）；
 * - 输入为展平的 MemoryLineView（id/kind/content/importance/sessionId），
 *   调用方（MemoryEntry 或工具输出形状）各自适配，渲染层不感知存储结构。
 */

import { shortSessionId } from './constants.js'

/** 渲染记忆行所需的最小视图形状（MemoryEntry 与工具输出均满足） */
export interface MemoryLineView {
  id: string
  kind: string
  content: string
  importance: number
  sessionId: string
}

/** 单条记忆渲染：分类、内容、重要度、短 id（可追溯）、来源会话短 id */
export function formatMemoryLine(entry: MemoryLineView): string {
  const memoryId = entry.id.slice(0, 8)
  // 短会话 id 去 'session-' 前缀（直接 slice 会截到前缀本身，见 shortSessionId 注释）
  const sourceSession = shortSessionId(entry.sessionId)
  return `- [${entry.kind}] ${entry.content}（重要度 ${entry.importance}，记忆 #${memoryId}，来自会话 ${sourceSession}）`
}
