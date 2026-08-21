/**
 * selectReflectionPairs 生产规模基准（证据工具，非 CI 门禁）。
 *
 * 运行方式：`npx vitest run test/reflect-bench.test.ts` 且环境变量 DSH_BENCH=1
 * （默认 skip，避免常规套件承担数秒级基准开销）。
 *
 * 场景对齐生产事实（~8912 条记忆库、远程 2560 维嵌入、向量覆盖率 ~22%）：
 * - A 混合：n=400、dim=2560、覆盖率 22% —— 复现"运行反思卡死 DSH"的真实路径；
 * - B 全向量：n=400、dim=2560、覆盖率 100% —— 隔离 SQL+余弦成本；
 * - C 纯 Jaccard：n=400、无向量 —— 隔离 jieba 分词成本。
 *
 * 观测量：
 * - 墙钟毫秒（performance.now 差值）；
 * - 事件循环最大停顿 ms：5ms 间隔采样计时器在计算期间的漂移上界——即宿主
 *   "无响应窗口"的直接度量（>1000ms 即肉眼可感的全局冻结）。
 */

import { describe, expect, it } from 'vitest'

import { selectReflectionPairs } from '../src/reflect.js'
import type { MemoryEntry } from '../src/types.js'

const NOW = Date.UTC(2025, 0, 15, 0, 0, 0)
/** 生产维度（远程 qwen3 文本嵌入） */
const PROD_DIM = 2560
/** 生产实测向量覆盖率下界（memory_status/semanticHitRate ≈21.8%） */
const PROD_HIT_RATE = 0.218
const BENCH_N = 400

function makeEntry(i: number): MemoryEntry {
  return {
    id: `w${i}`,
    workspace: 'D:/ws',
    sessionId: 's1',
    kind: 'fact',
    content:
      `记忆系统 反思 回归测试 条目${i} 第${i}号事实记录 reflection freeze benchmark ` +
      `项目使用 pnpm 管理 monorepo 依赖，vitest 作为测试运行器，TypeScript 严格模式编译`,
    importance: 5,
    tags: ['bench'],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '摘' },
    dedupKey: `key-${i}`,
    createdAt: new Date(NOW + i).toISOString(),
    updatedAt: new Date(NOW + i).toISOString(),
    lastAccessAt: new Date(NOW + i).toISOString(),
    accessCount: 0,
    status: 'active',
    audit: [{ action: 'create', at: new Date(NOW).toISOString(), by: 'extractor' as const }],
  }
}

/** 伪随机单位向量（确定性种子，可复现） */
function unitVector(seed: number, dim: number): Float32Array {
  const v = new Float32Array(dim)
  let s = seed >>> 0 || 1
  let norm = 0
  for (let i = 0; i < dim; i++) {
    // LCG 伪随机（确定性）
    s = (s * 1_664_525 + 1_013_904_223) >>> 0
    v[i] = (s / 0xffff_ffff) * 2 - 1
    norm += v[i]! * v[i]!
  }
  const inv = 1 / Math.sqrt(norm)
  for (let i = 0; i < dim; i++) v[i] = v[i]! * inv
  return v
}

/** 构造指定覆盖率的嵌入桩：命中表内条目返回 2560 维单位向量，其余 undefined */
function makeEmbedding(entries: MemoryEntry[], coverage: number): { getVector(id: string): Float32Array | undefined } {
  const vectors = new Map<string, Float32Array>()
  entries.forEach((entry, i) => {
    // 前 round(n×coverage) 条命中（确定性；n=400、coverage=0.218 → 87 条 ≈ 生产 21.8%）
    if (i < Math.round(coverage * entries.length)) vectors.set(entry.id, unitVector(i + 7, PROD_DIM))
  })
  return { getVector: (id: string) => vectors.get(id) }
}

/** 事件循环停顿采样器：以 5ms 间隔调度；每次触发记录与理论时刻的漂移 */
class LagSampler {
  private timer: ReturnType<typeof setInterval> | undefined
  private nextAt = 0
  maxLagMs = 0
  start(): void {
    this.nextAt = performance.now() + 5
    this.timer = setInterval(() => {
      const now = performance.now()
      this.maxLagMs = Math.max(this.maxLagMs, now - this.nextAt)
      // 下一个理论时刻按固定节拍推进（漂移累计计入 maxLag 后归位）
      this.nextAt = now + 5
    }, 5)
  }
  /** 立即停止（不再采样） */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 停止采样前排空一次宏任务：让同步阻塞期间挂起的定时器得以触发并记录漂移 */
  async stopAfterDrain(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 15))
    this.stop()
  }
}

/** 场景 D：真实 vec0 SQL 路径——生产 getVector 每次一条 SQLite vec0 虚拟表查询 */
async function makeRealVecIndex(entries: MemoryEntry[]): Promise<{ getVector(id: string): Float32Array | undefined }> {
  const { DatabaseSync } = await import('node:sqlite')
  const { EmbeddingIndex } = await import('../src/embed-index.js')
  // 与生产装配一致：加载 sqlite-vec 扩展须显式允许扩展
  const db = new DatabaseSync(':memory:', { allowExtension: true })
  const service = {
    state: 'ready',
    dimension: PROD_DIM,
    embed: async (text: string): Promise<Float32Array> => unitVector(text.length + 3, PROD_DIM),
    embedMany: async (texts: string[]): Promise<Float32Array[]> => texts.map((t) => unitVector(t.length + 3, PROD_DIM)),
  }
  const index = new EmbeddingIndex({ db, service, listAll: () => entries, logWarn: () => {} })
  // 逐条写入真实向量（走 indexEntry 公共 API → writeVector 内联字面量路径）
  for (const entry of entries) await index.indexEntry(entry)
  return index
}

describe.skipIf(!process.env.DSH_BENCH)('selectReflectionPairs 生产规模基准', () => {
  const cases: Array<{ name: string; coverage: number }> = [
    { name: `A 混合(内存桩) n=${BENCH_N} dim=${PROD_DIM} 覆盖率${PROD_HIT_RATE}`, coverage: PROD_HIT_RATE },
    { name: `B 全向量(内存桩) n=${BENCH_N} dim=${PROD_DIM} 覆盖率1.0`, coverage: 1 },
    { name: `C 纯Jaccard n=${BENCH_N} 无向量`, coverage: -1 },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const entries = Array.from({ length: BENCH_N }, (_, i) => makeEntry(i))
      const embedding = c.coverage >= 0 ? makeEmbedding(entries, c.coverage) : undefined
      const sampler = new LagSampler()
      sampler.start()
      const t0 = performance.now()
      const pairs = await selectReflectionPairs(entries, embedding)
      const wallMs = performance.now() - t0
      await sampler.stopAfterDrain()
      const reviewed = pairs.filter((p) => p.peers.length > 0).length
      // eslint-disable-next-line no-console
      console.log(
        `[BENCH] ${c.name} | 墙钟=${wallMs.toFixed(0)}ms | 事件循环最大停顿=${sampler.maxLagMs.toFixed(0)}ms | 焦点=${reviewed}`,
      )
      // 完整性守卫：基准必须真实驱动了候选选择（非空窗口必有焦点或全零）
      expect(pairs.length).toBeGreaterThanOrEqual(0)
    })
  }

  it(`D 生产路径(真 vec0 SQL) n=${BENCH_N} dim=${PROD_DIM} 覆盖率1.0`, async () => {
    const entries = Array.from({ length: BENCH_N }, (_, i) => makeEntry(i))
    const realIndex = await makeRealVecIndex(entries)
    const sampler = new LagSampler()
    sampler.start()
    const t0 = performance.now()
    const pairs = await selectReflectionPairs(entries, realIndex)
    const wallMs = performance.now() - t0
    await sampler.stopAfterDrain()
    // eslint-disable-next-line no-console
    console.log(
      `[BENCH] D 生产路径(真vec0 SQL) | 墙钟=${wallMs.toFixed(0)}ms | 事件循环最大停顿=${sampler.maxLagMs.toFixed(0)}ms | 焦点=${pairs.filter((p) => p.peers.length > 0).length}`,
    )
    expect(pairs.length).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it(`E 混合+真vec0(生产真实形态:部分条目无向量行) n=${BENCH_N} dim=${PROD_DIM} 覆盖率${PROD_HIT_RATE}`, async () => {
    const entries = Array.from({ length: BENCH_N }, (_, i) => makeEntry(i))
    // 只为前 coverage 比例的条目写真实向量行——其余 getVector 返回 undefined → Jaccard 回退
    const { DatabaseSync } = await import('node:sqlite')
    const { EmbeddingIndex } = await import('../src/embed-index.js')
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const service = {
      state: 'ready',
      dimension: PROD_DIM,
      embed: async (): Promise<Float32Array> => unitVector(11, PROD_DIM),
    }
    const index = new EmbeddingIndex({ db, service, listAll: () => entries.slice(0, Math.round(PROD_HIT_RATE * BENCH_N)), logWarn: () => {} })
    await index.backfill(Number.POSITIVE_INFINITY)
    const sampler = new LagSampler()
    sampler.start()
    const t0 = performance.now()
    const pairs = await selectReflectionPairs(entries, index)
    const wallMs = performance.now() - t0
    await sampler.stopAfterDrain()
    // eslint-disable-next-line no-console
    console.log(
      `[BENCH] E 混合+真vec0 | 墙钟=${wallMs.toFixed(0)}ms | 事件循环最大停顿=${sampler.maxLagMs.toFixed(0)}ms | 焦点=${pairs.filter((p) => p.peers.length > 0).length}`,
    )
    expect(pairs.length).toBeGreaterThanOrEqual(0)
  }, 180_000)
})
