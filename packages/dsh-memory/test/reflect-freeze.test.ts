/**
 * 反思卡死回归测试（2026-08-20 用户报告：手动点击"运行反思"导致 DSH 主机整体冻结）。
 *
 * 根因（代码事实链，量化证据见 test/reflect-bench.test.ts）：
 * selectReflectionPairs 对窗口做 O(n²) 两两对比；旧实现每对 pairSim 内联执行：
 * - embedding.getVector(id)：每次一条 SQLite vec0 虚拟表查询（生产 2560 维 ≈10KB BLOB）；
 * - 任一侧缺向量时 tokenize(content+tags)：jieba 同步分词（~0.4ms/次，且同一条目
 *   在不同对里被反复重切）。
 * 生产规模（n=400、向量覆盖率 ~22%）下同步 CPU 阻塞达数十秒且全程占用宿主事件
 * 循环 → GUI/RPC/agent 全部无响应（"卡死"）。
 *
 * 修复语义（架构预算判据——确定性、不测墙钟时间，避免 CI 计时抖动）：
 * - 向量预算：getVector 每条目至多调用一次（预取缓存），O(n²) 内循环零 IO；
 * - 分词预算：tokenize 每条目至多调用一次（token 预取缓存），内循环纯集合运算。
 * 取 n=40 小窗口：红态本身秒级可跑完（计数断言失败即红，无需付真实生产 CPU 代价）。
 */

import { describe, expect, it, vi } from 'vitest'

// 以 spy 包装 tokenize（保留原实现语义），统计调用次数——验证"每条目至多分词一次"预算。
// vi.mock 会被提升到文件顶部，只影响本文件的模块图（reflect.test.ts 不受影响）。
vi.mock('../src/scoring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scoring.js')>()
  return { ...actual, tokenize: vi.fn(actual.tokenize) }
})

// mock 提升后，此处拿到的是与被测模块共享的同一被包装模块单例
import { tokenize } from '../src/scoring.js'

import { selectReflectionPairs } from '../src/reflect.js'
import type { MemoryEntry } from '../src/types.js'

/** 固定"现在"（条目时间戳；与其它测试文件同模式） */
const NOW = Date.UTC(2025, 0, 15, 0, 0, 0)

/** 条目工厂：完整 MemoryEntry 形状（字段集与 reflect.test.ts 的本地工厂一致） */
function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const base = {
    workspace: 'D:/ws',
    sessionId: 's1',
    kind: 'fact' as const,
    content: '内容',
    importance: 5,
    tags: [] as string[],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '摘' },
    dedupKey: `key-${overrides.id}`,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastAccessAt: new Date(NOW).toISOString(),
    accessCount: 0,
    status: 'active' as const,
    audit: [{ action: 'create' as const, at: new Date(NOW).toISOString(), by: 'extractor' as const }],
  }
  return { ...base, ...overrides }
}

/** 构造 n 条同 workspace 条目（内容互异且两两有公共 token，保证全部进入完整相似度计算） */
function makeWindow(n: number): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) =>
    makeEntry({
      id: `w${i}`,
      // 公共词 "记忆系统 反思" 保证 Jaccard ∈ [0.08,0.85) 有意义；专属词保证互异
      content: `记忆系统 反思 回归测试 条目${i} 第${i}号事实记录 reflection freeze`,
      importance: 5,
    }),
  )
}

describe('selectReflectionPairs 资源预算（反思卡死回归）', () => {
  it('向量预算：全侧有向量时 getVector 至多每条目调用一次（旧实现每对 2 次 ≈ 数千次）', async () => {
    const entries = makeWindow(40)
    let calls = 0
    // 4 维小向量：让红态本身快速跑完（本断言只验证调用次数预算，不付大维度 CPU 代价）
    const countingEmbedding = {
      getVector: (_id: string) => {
        calls++
        return new Float32Array([1, 0, 0, 0])
      },
    }
    await selectReflectionPairs(entries, countingEmbedding)
    // 预算上界 = 条目数（预取语义）；旧实现 ≈ 2·C(40,2)+焦点复核 ≈ 数千次 → 红
    expect(calls).toBeLessThanOrEqual(entries.length)
  })

  it('分词预算：无向量全走 Jaccard 回退时 tokenize 至多每条目一次（旧实现每对双方各切一次）', async () => {
    const mockedTokenize = vi.mocked(tokenize)
    try {
      mockedTokenize.mockClear()
      const entries = makeWindow(40)
      // 不传 embedding → 全部落入 token-Jaccard 回退分支
      await selectReflectionPairs(entries)
      // 预算上界 = 条目数（token 预取语义）；旧实现 ≈ 2·C(40,2) ≈ 1560 次 → 红
      expect(mockedTokenize.mock.calls.length).toBeLessThanOrEqual(entries.length)
    } finally {
      mockedTokenize.mockClear()
    }
  })

  it('行为不回归：预取改造后焦点/候选带判定结果与既有语义一致', async () => {
    // 高重合对（Jaccard 带内）仍入选，孤条目不作焦点——与 reflect.test.ts 主语义互证
    const older = makeEntry({ id: 'dupOld', content: 'CourtGrantTypes 迁至 Project persistence', importance: 7 })
    const newer = makeEntry({ id: 'dupNew', content: 'CourtGrantTypes 迁至 Project persistence 机制', importance: 6 })
    const isolated = makeEntry({ id: 'isolated', content: '完全无关的话题 zzz qqq', importance: 9 })
    const pairs = await selectReflectionPairs([older, newer, isolated])
    expect(pairs.map((p) => p.focus.id)).toContain('dupOld')
    expect(pairs.find((p) => p.focus.id === 'dupOld')?.peers.map((x) => x.id)).toContain('dupNew')
  })
})
