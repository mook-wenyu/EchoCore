/**
 * 评分模块单元测试：分词、相关性、时间衰减、重要性、综合分。
 * 全部为确定性纯函数断言。
 */

import { describe, expect, it } from 'vitest'

import {
  importanceFactor,
  memoryScore,
  recencyFactor,
  relevanceScore,
  scoreEntry,
  tokenize,
} from '../src/scoring.ts'
import { type MemoryEntry } from '../src/types.ts'

/** 构造一个最小记忆条目（测试辅助） */
function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'm1',
    workspace: 'D:/workspace',
    sessionId: 's1',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 5,
    tags: [],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '…' },
    dedupKey: 'k1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessAt: '2026-01-01T00:00:00.000Z',
    accessCount: 0,
    status: 'active',
    audit: [],
    ...overrides,
  }
}

describe('tokenize', () => {
  it('切分英文单词并小写', () => {
    expect(tokenize('Use Pnpm Workspace')).toEqual(['use', 'pnpm', 'workspace'])
  })

  it('切分中文为二元组', () => {
    expect(tokenize('项目')).toEqual(['项目'])
    expect(tokenize('使用pnpm')).toEqual(['pnpm', '使用'])
  })

  it('混合中英文与数字', () => {
    const tokens = tokenize('vite 5.0 构建 echoCore')
    expect(tokens).toContain('vite')
    expect(tokens).toContain('5')
    expect(tokens).toContain('0')
    expect(tokens).toContain('构建')
  })

  it('空文本返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('relevanceScore', () => {
  it('完全命中得 1 分', () => {
    expect(relevanceScore(['pnpm'], new Set(['pnpm']))).toBe(1)
  })

  it('部分命中按比例得分', () => {
    expect(relevanceScore(['pnpm', 'vite'], new Set(['pnpm']))).toBe(0.5)
  })

  it('空查询得 0 分', () => {
    expect(relevanceScore([], new Set(['pnpm']))).toBe(0)
  })
})

describe('recencyFactor', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')

  it('刚访问返回 1', () => {
    expect(recencyFactor('2026-01-15T00:00:00.000Z', now)).toBe(1)
  })

  it('一个半衰期（7 天）衰减到 0.5', () => {
    expect(recencyFactor('2026-01-08T00:00:00.000Z', now)).toBeCloseTo(0.5, 5)
  })

  it('未来时间戳钳制为 1', () => {
    expect(recencyFactor('2026-02-01T00:00:00.000Z', now)).toBe(1)
  })

  it('非法时间戳钳制为 1', () => {
    expect(recencyFactor('not-a-date', now)).toBe(1)
  })
})

describe('importanceFactor', () => {
  it('importance 10 得最高权重 1.0', () => {
    expect(importanceFactor(10)).toBe(1.0)
  })

  it('importance 0 得最低权重 0.5', () => {
    expect(importanceFactor(0)).toBe(0.5)
  })

  it('越界值被钳制', () => {
    expect(importanceFactor(99)).toBe(1.0)
    expect(importanceFactor(-5)).toBe(0.5)
  })
})

describe('memoryScore / scoreEntry', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')

  it('无关条目得 0 分', () => {
    const e = entry({})
    expect(scoreEntry(e, '完全无关的话题xyz', now)).toBe(0)
  })

  it('相关且重要的条目得分更高（重要性调制）', () => {
    const low = entry({ id: 'a', importance: 1 })
    const high = entry({ id: 'b', importance: 10 })
    expect(memoryScore(high, ['pnpm'], now)).toBeGreaterThan(memoryScore(low, ['pnpm'], now))
  })

  it('更近访问的条目得分更高（时间衰减调制）', () => {
    const stale = entry({ id: 'a', lastAccessAt: '2025-01-01T00:00:00.000Z' })
    const fresh = entry({ id: 'b', lastAccessAt: '2026-01-14T00:00:00.000Z' })
    expect(memoryScore(fresh, ['pnpm'], now)).toBeGreaterThan(memoryScore(stale, ['pnpm'], now))
  })

  it('标签参与相关性命中', () => {
    const tagged = entry({ tags: ['架构'] })
    expect(scoreEntry(tagged, '架构', now)).toBeGreaterThan(0)
  })
})
