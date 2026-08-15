/**
 * 渲染单源单元测试（R2-7/B7）。
 * 目的：钉住 formatMemoryLine 的输出格式——injector 自动注入包与 tools 工具
 * 输出共用此实现，改格式前必须先改本测试（防两处漂移）。
 */

import { describe, expect, it } from 'vitest'

import { formatMemoryLine, type MemoryLineView } from '../src/render.js'

/** 构造渲染视图形状（MemoryEntry 展平与工具输出形状共用） */
function view(overrides: Partial<MemoryLineView> = {}): MemoryLineView {
  return {
    id: 'a05cc78e-1ee8-41bf-b893-96f3d2256466',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 5,
    sessionId: 'session-63bbf845',
    ...overrides,
  }
}

describe('formatMemoryLine（渲染单源）', () => {
  it('输出含分类/内容/重要度/短记忆 id/短会话 id', () => {
    const line = formatMemoryLine(view())
    expect(line).toBe(
      '- [fact] 项目使用 pnpm workspace 管理多包（重要度 5，记忆 #a05cc78e，来自会话 63bbf845）',
    )
  })

  it('会话 id 短化去掉 session- 前缀（防截断回归：直接 slice(0,8) 会截到前缀本身）', () => {
    const line = formatMemoryLine(view({ sessionId: 'session-63bbf845' }))
    expect(line).toContain('来自会话 63bbf845')
    expect(line).not.toContain('session-')
  })

  it('kind 与重要度如实呈现', () => {
    const line = formatMemoryLine(view({ kind: 'decision', importance: 9 }))
    expect(line).toContain('[decision]')
    expect(line).toContain('重要度 9')
  })
})
