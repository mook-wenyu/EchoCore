/**
 * 渲染单源单元测试（R2-7/B7）。
 * 目的：钉住 formatMemoryLine 的输出格式——injector 自动注入包与 tools 工具
 * 输出共用此实现，改格式前必须先改本测试（防两处漂移）。
 */

import { describe, expect, it } from 'vitest'

import { MEMORY_INJECTION_HEADER } from '../src/constants.js'
import { formatMemoryLine, renderBudgetedPack, type MemoryLineView } from '../src/render.js'

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

describe('renderBudgetedPack 预算边界（P1-2 补盲）', () => {
  const note = (skipped: number) => `（另有 ${skipped} 条未展示）`

  it('预算恰好容纳 header + 一条：渲染该条并提示 1 条被跳过', () => {
    const first = view({ id: 'a0000001', content: '短' })
    const second = view({ id: 'b0000002', content: '另一条' })
    const oneLine = formatMemoryLine(first)
    const budget = MEMORY_INJECTION_HEADER.length + 1 + oneLine.length + 1
    const pack = renderBudgetedPack([first, second], budget, MEMORY_INJECTION_HEADER, note)
    expect(pack).toBeDefined()
    expect(pack?.renderedIds).toEqual([first.id])
    // 第二条放不下 → 跳过并提示（跳过不截断尾部）
    expect(pack?.text).toBe(`${MEMORY_INJECTION_HEADER}\n${oneLine}\n（另有 1 条未展示）`)
  })

  it('预算小于 header + 最短行：返回 undefined（不注入空包）', () => {
    const pack = renderBudgetedPack([view()], MEMORY_INJECTION_HEADER.length, MEMORY_INJECTION_HEADER, note)
    expect(pack).toBeUndefined()
  })

  it('超长单条跳过且后续短条仍渲染（跳过不饿死后续）', () => {
    const long = view({ id: 'l0000001', content: '超'.repeat(500) })
    const short = view({ id: 's0000002', content: '短条目' })
    const shortLine = formatMemoryLine(short)
    const budget = MEMORY_INJECTION_HEADER.length + 1 + shortLine.length + 1
    const pack = renderBudgetedPack([long, short], budget, MEMORY_INJECTION_HEADER, note)
    expect(pack).toBeDefined()
    expect(pack?.renderedIds).toEqual([short.id])
    expect(pack?.text).toContain(shortLine)
    expect(pack?.text).toContain('另有 1 条未展示')
  })
})
