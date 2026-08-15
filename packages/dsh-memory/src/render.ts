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

/** 渲染记忆行所需的最小视图形状（MemoryEntry 与工具输出均满足；createdAt 可选——工具输出无此字段） */
export interface MemoryLineView {
  id: string
  kind: string
  content: string
  importance: number
  sessionId: string
  /** 创建时间 ISO（F3 防污染：渲染时效字段，模型可判断记忆新旧；缺省不渲染） */
  createdAt?: string
}

/**
 * 单条记忆渲染：分类、内容、重要度、短 id（可追溯）、来源会话短 id、创建日期。
 * F3（防上下文污染）：渲染创建日期——模型可判断记忆新旧，避免把过时记忆
 * 当现行事实（审计证据：无时效字段时模型只能依赖笼统"可能过时"声明）。
 */
export function formatMemoryLine(entry: MemoryLineView): string {
  const memoryId = entry.id.slice(0, 8)
  // 短会话 id 去 'session-' 前缀（直接 slice 会截到前缀本身，见 shortSessionId 注释）
  const sourceSession = shortSessionId(entry.sessionId)
  const created = entry.createdAt !== undefined ? `，创建于 ${entry.createdAt.slice(0, 10)}` : ''
  return `- [${entry.kind}] ${entry.content}（重要度 ${entry.importance}，记忆 #${memoryId}，来自会话 ${sourceSession}${created}）`
}

/** 预算渲染结果：文本 + 实际渲染条目的 id 列表（跳过制下不能按前 N 条推断） */
export interface BudgetedPack {
  text: string
  renderedIds: string[]
}

/**
 * 预算内逐条渲染共享实现（DRY：injector 实时包与 stable-snapshot 稳定快照
 * 共用同一"声明头 + 逐行 bullet + 预算截断 + 超限提示"拼装逻辑，避免两处
 * 各自实现导致格式漂移）。
 * - header：注入声明头（MEMORY_INJECTION_HEADER）；
 * - 预算按字符硬截断：放不下的条目**跳过并继续后续**（而非整体截断尾部）——
 *   排序在前但超长的单条不应饿死后续较短的记忆（快照按重要度、实时包按
 *   相关性排序，超长条目跳过是显式语义，不破坏顺序）；
 * - 有跳过时追加超限提示（note 文案由调用方给——两处的提示措辞不同）。
 * 返回 undefined 表示一条都放不下（不注入，避免空消息）。
 */
export function renderBudgetedPack(
  entries: MemoryLineView[],
  budgetChars: number,
  header: string,
  truncatedNote: (skipped: number) => string,
): BudgetedPack | undefined {
  const lines: string[] = []
  const renderedIds: string[] = []
  let used = header.length + 1
  let skipped = 0
  for (const entry of entries) {
    const line = formatMemoryLine(entry)
    if (used + line.length + 1 > budgetChars) {
      skipped++
      continue
    }
    lines.push(line)
    renderedIds.push(entry.id)
    used += line.length + 1
  }
  if (lines.length === 0) return undefined
  let text = `${header}\n${lines.join('\n')}`
  if (skipped > 0) {
    text += `\n${truncatedNote(skipped)}`
  }
  return { text, renderedIds }
}
