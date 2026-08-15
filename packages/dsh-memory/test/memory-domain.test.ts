/**
 * 领域 schema 单元测试（R3-4/T4）。
 * 目的：钉住 memoryEntrySchema 的校验边界——持久层写入前的最后一道防线，
 * 非法枚举/形状必须被拒绝（此前零测试，schema 变更无防回归）。
 */

import { describe, expect, it } from 'vitest'

import { memoryEntrySchema } from '../src/memory-domain.js'
import type { MemoryEntry } from '../src/types.js'

/** 构造合法条目（schema 测试基准） */
function validEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'a05cc78e-1ee8-41bf-b893-96f3d2256466',
    workspace: 'D:/workspace',
    sessionId: 's1',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 5,
    tags: ['架构'],
    source: { sessionId: 's1', eventSeqs: [3, 4], excerpt: '…原文…' },
    dedupKey: 'abc123',
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    lastAccessAt: '2026-01-15T00:00:00.000Z',
    accessCount: 0,
    status: 'active',
    audit: [{ action: 'create', at: '2026-01-15T00:00:00.000Z', by: 'extractor' }],
    ...overrides,
  }
}

describe('memoryEntrySchema', () => {
  it('合法条目通过', () => {
    expect(memoryEntrySchema.safeParse(validEntry()).success).toBe(true)
  })

  it('拒绝非法 kind（枚举单源：MEMORY_KINDS 之外的值）', () => {
    const result = memoryEntrySchema.safeParse(validEntry({ kind: 'rumor' as MemoryEntry['kind'] }))
    expect(result.success).toBe(false)
  })

  it('拒绝非法 status（deleted 已在 D-D 裁决中删除，永不可写）', () => {
    const result = memoryEntrySchema.safeParse(validEntry({ status: 'deleted' as MemoryEntry['status'] }))
    expect(result.success).toBe(false)
  })

  it('拒绝非法审计动作', () => {
    const entry = validEntry()
    const result = memoryEntrySchema.safeParse({
      ...entry,
      audit: [{ action: 'explode', at: '2026-01-15T00:00:00.000Z', by: 'extractor' }],
    })
    expect(result.success).toBe(false)
  })

  it('拒绝负数重要度（无业务意义的输入）', () => {
    const result = memoryEntrySchema.safeParse(validEntry({ importance: -1 }))
    expect(result.success).toBe(false)
  })

  it('拒绝缺 source 锚点的记录（溯源不变量）', () => {
    const entry = validEntry()
    const { source: _source, ...withoutSource } = entry
    const result = memoryEntrySchema.safeParse(withoutSource)
    expect(result.success).toBe(false)
  })

  it('supersededBy/supersedes 可选：缺席与在场均通过', () => {
    expect(memoryEntrySchema.safeParse(validEntry()).success).toBe(true)
    expect(
      memoryEntrySchema.safeParse(validEntry({ supersededBy: 'b2', supersedes: 'b0' })).success,
    ).toBe(true)
  })
})
