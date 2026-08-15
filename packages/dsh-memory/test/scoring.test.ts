/**
 * 评分模块单元测试：分词、相关性、时间衰减、重要性、综合分。
 * 全部为确定性纯函数断言。
 */

import { describe, expect, it } from 'vitest'

import {
  adaptiveHalfLifeDays,
  importanceFactor,
  memoryScore,
  modulatedHalfLifeDays,
  recencyFactor,
  relevanceScore,
  rrfScore,
  SALIENCE_FLOOR_IMPORTANCE,
  SALIENCE_FLOOR_RECENCY,
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

// P3（OPTIMIZATION_PLAN_3）：importance 感知半衰期 + salience floor
describe('adaptiveHalfLifeDays（P3）', () => {
  it('importance 5 为基础半衰期 7 天（与 P3 前行为一致）', () => {
    expect(adaptiveHalfLifeDays(5)).toBeCloseTo(7, 10)
  })

  it('importance 每 +2 半衰期翻倍（7→14→28）', () => {
    expect(adaptiveHalfLifeDays(7)).toBeCloseTo(14, 10)
    expect(adaptiveHalfLifeDays(9)).toBeCloseTo(28, 10)
  })

  it('importance 10 半衰期约 39.6 天', () => {
    expect(adaptiveHalfLifeDays(10)).toBeCloseTo(7 * 2 ** 2.5, 6)
  })

  it('单调递增且越界钳制', () => {
    expect(adaptiveHalfLifeDays(3)).toBeLessThan(adaptiveHalfLifeDays(6))
    expect(adaptiveHalfLifeDays(6)).toBeLessThan(adaptiveHalfLifeDays(9))
    expect(adaptiveHalfLifeDays(99)).toBe(adaptiveHalfLifeDays(10))
    expect(adaptiveHalfLifeDays(-5)).toBe(adaptiveHalfLifeDays(0))
  })
})

describe('memoryScore 衰减增强（P3）', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')
  const VERY_OLD = '2025-01-01T00:00:00.000Z' // 一年前

  it('高重要度久未访问的记忆得分高于低重要度久未访问（自适应半衰期）', () => {
    const high = entry({ id: 'a', importance: 9, lastAccessAt: VERY_OLD })
    const low = entry({ id: 'b', importance: 3, lastAccessAt: VERY_OLD })
    // 同 relevance（内容相同）；imp 9 半衰期 28 天 + floor，imp 3 半衰期 ~3.5 天无 floor
    expect(memoryScore(high, ['pnpm'], now)).toBeGreaterThan(memoryScore(low, ['pnpm'], now))
  })

  it('salience floor：importance ≥ 8 时时间因子被钳制（保活）', () => {
    const floored = entry({ id: 'a', importance: SALIENCE_FLOOR_IMPORTANCE, lastAccessAt: VERY_OLD })
    const below = entry({ id: 'b', importance: SALIENCE_FLOOR_IMPORTANCE - 1, lastAccessAt: VERY_OLD })
    // 一年远大于两者的半衰期：无 floor 时 recency ≈ 0（因子 0.6）；有 floor 时 recency=0.5（因子 0.8）
    expect(memoryScore(floored, ['pnpm'], now)).toBeGreaterThan(memoryScore(below, ['pnpm'], now))
  })

  it('floor 常量语义：recency 下限 0.5 → 时间调制因子下限 0.8', () => {
    expect(SALIENCE_FLOOR_RECENCY).toBe(0.5)
    expect(0.6 + 0.4 * SALIENCE_FLOOR_RECENCY).toBe(0.8)
  })

  it('新近访问仍占优（自适应半衰期不逆转"新"优势）', () => {
    const fresh = entry({ id: 'a', importance: 9, lastAccessAt: '2026-01-14T00:00:00.000Z' })
    const old = entry({ id: 'b', importance: 9, lastAccessAt: '2025-12-01T00:00:00.000Z' })
    expect(memoryScore(fresh, ['pnpm'], now)).toBeGreaterThan(memoryScore(old, ['pnpm'], now))
  })
})

describe('modulatedHalfLifeDays（访问频率调制衰减，B2）', () => {
  it('访问次数延长半衰期：0→1×、1→2×、3→3×、7→4×（1+log2(1+n)）', () => {
    const base = adaptiveHalfLifeDays(5) // 7 天
    expect(modulatedHalfLifeDays(5, 0)).toBeCloseTo(base)
    expect(modulatedHalfLifeDays(5, 1)).toBeCloseTo(base * 2)
    expect(modulatedHalfLifeDays(5, 3)).toBeCloseTo(base * 3)
    expect(modulatedHalfLifeDays(5, 7)).toBeCloseTo(base * 4)
    expect(modulatedHalfLifeDays(5, 15)).toBeCloseTo(base * 5)
  })

  it('与 importance 感知叠加：高频访问的高重要度记忆衰减最慢', () => {
    const lowFreqLowImp = modulatedHalfLifeDays(3, 0)
    const highFreqHighImp = modulatedHalfLifeDays(9, 7)
    expect(highFreqHighImp).toBeGreaterThan(lowFreqLowImp * 4)
  })

  it('高频访问的久远记忆得分高于低频访问（召回抬回）', () => {
    const now = Date.parse('2026-01-15T00:00:00.000Z')
    const VERY_OLD = '2025-01-01T00:00:00.000Z' // 一年前
    const visited = entry({ id: 'a', importance: 5, lastAccessAt: VERY_OLD, accessCount: 15 })
    const ignored = entry({ id: 'b', importance: 5, lastAccessAt: VERY_OLD, accessCount: 0 })
    expect(memoryScore(visited, ['pnpm'], now)).toBeGreaterThan(memoryScore(ignored, ['pnpm'], now))
  })
})

describe('rrfScore（RRF 排名融合，B1）', () => {  it('双榜第一 = 1（归一化上界）', () => {
    expect(rrfScore(1, 1)).toBe(1)
  })

  it('单榜第一 = 0.5（归一化半权）', () => {
    expect(rrfScore(1, undefined)).toBe(0.5)
    expect(rrfScore(undefined, 1)).toBe(0.5)
  })

  it('双榜均不在榜 = 0', () => {
    expect(rrfScore(undefined, undefined)).toBe(0)
  })

  it('排名越靠前贡献越大且单调', () => {
    expect(rrfScore(1, 1)).toBeGreaterThan(rrfScore(2, 1))
    expect(rrfScore(3, 3)).toBeGreaterThan(rrfScore(4, 4))
    // 单榜第二 < 单榜第一
    expect(rrfScore(2, undefined)).toBeLessThan(rrfScore(1, undefined))
  })

  it('双榜靠前优于单榜靠前（两通道证据叠加）', () => {
    expect(rrfScore(2, 2)).toBeGreaterThan(rrfScore(1, undefined))
  })
})
