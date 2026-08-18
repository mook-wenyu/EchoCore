/**
 * O3 性能基准（数量级回归防护，非绝对吞吐）。
 *
 * 说明：
 * - 用普通 vitest `it` + performance.now 计时，随常规 `npx vitest run` 执行；
 *   不使用 vitest bench 模式（保证常规跑测也能收集）。
 * - 断言是「相对回归防护」而非「绝对性能门槛」：阈值取正常耗时约 10-50 倍，
 *   在 CI 机器抖动/冷启动下也绝不 flaky，只拦截数量级退化（例如某热路径被改成
 *   二次方复杂度、意外引入磁盘 IO/无界循环等导致耗时暴增）。
 * - 计时用较宽松的单测阈值，不是为了衡量性能，而是保证"明显变慢就红"。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { renderBudgetedPack } from '../src/render.js'
import { tokenize } from '../src/scoring.js'
import { migrateMemoryJson, SqliteKvTable } from '../src/sqlite-kv.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry, MemoryKind, NewMemoryInput, MemorySource } from '../src/types.js'
import { FakeTable } from './helpers.js'

/** 计时工具：返回耗时毫秒 */
function time(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/** 异步计时工具 */
async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

/** 构造一条批量记忆入参（内容随机化为独立去重键，避免 create 合并缩并条数） */
function makeInput(i: number, session: string, workspace: string): NewMemoryInput {
  const kind: MemoryKind = 'fact'
  const source: MemorySource = { sessionId: session, eventSeqs: [i], excerpt: `第 ${i} 条摘录` }
  return {
    workspace,
    sessionId: session,
    kind,
    content: `记忆条目 ${i}：项目使用 pnpm workspace 管理多包并采用评分检索策略`,
    importance: 5,
    tags: ['架构'],
    source,
    by: 'extractor',
  }
}

/** 临时 SQLite 数据库路径（每用例独立目录，防 WAL 残留互扰） */
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-bench-'))
  return join(dir, 'bench.sqlite')
}

describe('O3 性能基准（数量级回归防护）', () => {
  it('检索：1000 条假条目 search < 1000ms', async () => {
    const store = new MemoryStore(new FakeTable())
    // 批量新建 1000 条独立内容（分布式会话，跨会话聚合形态）
    for (let i = 0; i < 1000; i++) {
      await store.create(makeInput(i, `session-bench-${i % 8}`, `D:/ws-${i % 4}`))
    }
    // 第一次检索会重建 token 缓存，量级更真实（覆盖 R1 缓存热后路径）
    const elapsed = await timeAsync(async () => {
      store.search({ query: 'pnpm', limit: 8 })
    })
    // 宽松阈值约等于常规耗时的数十倍：只防数量级退化
    expect(elapsed).toBeLessThan(1000)
  })

  it('检索：1000 条假条目 3 段拼接查询（withScore）< 2000ms', async () => {
    const store = new MemoryStore(new FakeTable())
    for (let i = 0; i < 1000; i++) {
      await store.create(makeInput(i, `session-bench-${i % 8}`, `D:/ws-${i % 4}`))
    }
    // 3 段拼接查询，各段 100 字符（对齐 injector P3 的拼接形态，含近 3 个百字符段）
    const seg = '项目采用评分检索与跨会话聚合的记忆架构，pnpm workspace 管理多包并沉淀决策。'.repeat(10)
    const hundred = seg.slice(0, 100)
    const query = [hundred, hundred, hundred].join(' ')
    // withScore 返回 Array<{ entry, score }>——P1 三档注入的分档依据，须单独覆盖其热路径
    const elapsed = await timeAsync(async () => {
      const rows = store.search({ query, limit: 8, withScore: true })
      // withScore 形态断言：带条目的行是 { entry, score }（复合对象而非 MemoryEntry）
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0]?.entry).toBeDefined()
      expect(typeof rows[0]?.score).toBe('number')
    })
    // 宽松阈值：只防拼接+评分路径被意外改成二次方/引入磁盘 IO 的数量级退化
    expect(elapsed).toBeLessThan(2000)
  })

  it('注入渲染：renderBudgetedPack 100 条 < 200ms', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `mem-${i}`,
      // 适配 P1：renderBudgetedPack 接收预渲染行（{ id, line }）
      line: `- [fact] 记忆内容 ${i}：` + '项目采用评分检索与跨会话聚合'.repeat(3) + '（重要度 5，记忆 #mem-…）',
    }))
    const elapsed = time(() => {
      renderBudgetedPack(entries, 4096, '[参考记忆]', (skipped) => `…还有 ${skipped} 条被跳过`)
    })
    expect(elapsed).toBeLessThan(200)
  })

  it('tokenize 热路径：中文长文本 100 次 < 2000ms（含 jieba 词典一次性加载容忍）', () => {
    const longText =
      '会议决定采用评分检索与跨会话聚合的记忆架构，项目使用 pnpm workspace 管理多包，' +
      '用户偏好使用简体中文交流，并将决策以 insight 分类沉淀以供后续审计溯源。'.repeat(10)
    const elapsed = time(() => {
      for (let i = 0; i < 100; i++) {
        tokenize(longText)
      }
    })
    // 阈值宽松到 2s：主要覆盖"分词被意外改成 O(n²) 或每轮重建词典"这类数量级退化
    expect(elapsed).toBeLessThan(2000)
  })

  it('迁移：migrateMemoryJson 100 条导入 SQLite < 2000ms', async () => {
    const dbPath = tmpDbPath()
    const db = new DatabaseSync(dbPath)
    const table = new SqliteKvTable<{ id: string }>(db)
    // 构造 100 条 JSON 记录（legacy memory.json 的 tables.entries 字典形态）
    const entries: Record<string, { id: string }> = {}
    for (let i = 0; i < 100; i++) {
      entries[`mem-${i}`] = { id: `mem-${i}` }
    }
    const jsonPath = join(dbPath + '.json')
    writeFileSync(jsonPath, JSON.stringify({ tables: { entries } }))
    // 空表迁移：逐条 upsert 落盘
    const elapsed = await timeAsync(async () => {
      await migrateMemoryJson(jsonPath, table, () => true)
    })
    expect(elapsed).toBeLessThan(2000)
    db.close()
    rmSync(join(dbPath, '..'), { recursive: true, force: true })
  })
})

/* ============================================================================
 * recall@k 检索质量评估（第三轮审计补齐：既有 4 例全是性能断言、无质量评估）。
 *
 * 与上方性能用例同仓（共用 FakeTable / MemoryStore / create 入参形态），但**不设
 * 性能门槛**——只评估检索质量：合成库上的 recall@k、常见词稀释无噪声泄漏、稀有词
 * 权重。
 *
 * 合成库设计（模拟真实库的"常见词稀释"）：
 * - 20 条"目标"：公共词内容 + 各自**唯一稀有标识词**（稀有汉字三元组，jieba/公共词
 *   词典几乎必然 OOV，且不与其他条目共享整串）。每条目标以自身标识词为查询时，命中
 *   relevance=1.0（唯一 max）。
 * - 180 条"干扰"：公共词内容 + 各自唯一编号（避免 create 去重合并，保证 200 条全部
 *   独立落库）。
 * - 200 条内容两两不同（dedupKey 互异）→ 互不合并、互不 supersede。
 *
 * 评分口径（scoring.ts，勿与实现相悖）：无语义向量时关键词路径
 *   score = idfWeightedRelevance(queryTokens, entryTokens) × timeImportanceFactor(entry, now)
 * idfWeightedRelevance = 命中 query token 的 BM25 idf 占全部 query token idf 之比（0..1）：
 *   全命中恒 = 1.0、零命中 = 0、0-1 绝对标定保持（注入三档 0.7/0.4 语义不变）；同命中数下
 *   稀有词 idf 权重大于常见词（主代理已并入 store 关键词分支的轻量 IDF/BM25 加权）。本
 *   文件把步 5 设计成在"纯重合率"与"IDF 加权"两种实现下都成立的健壮断言——IDF 只会让
 *   稀有词权重更高、断言不脆化，同时作为其生效验证。
 *
 * 断言取舍说明（避免脆测/假阳性）：
 * - 目标条目各自唯一标识词→ queries 相互独立，任何两条目标不会因共享 token 互相抬分，
 *   故 recall 判定用"目标在 top-k(k=5)"即可，无需跨条目去重；
 * - 每条第独立 workspace 规避 supersede 折叠（同 workspace + 高 Jaccard 公共词内容会被
 *   findSupersededTargets 整批标成 superseded、从默认检索隐藏，200 条实测只剩 8 条）；
 * - 时间因子全部同刻创建→ factor≈0.75（imp=5，recency≈1），分数带收敛，供稀释验证
 *   做"无虚高"的带宽断言（maxTarget 不超 maxDistractor + 容差）。
 * ========================================================================== */

/** 公共词内容：每条目标/干扰都含它，制造"常见词稀释"；保证『项目』等词 200 条全覆盖 */
const COMMON_SENTENCE =
  '项目采用评分检索与跨会话聚合的记忆架构，用户偏好使用简体中文交流，并将决策以 insight 分类沉淀以供后续审计溯源。'

/** 20 个互不相同的稀有汉字三元组标识词（稀有镧系/锕系元素字/偏僻字，公共词词典外） */
const RARE_MARKERS = [
  '锕钐钆', '铷钪钛', '钒铬锰', '锇锑锗', '铪钽钨',
  '铼锇铱', '铂铑钯', '钌锫锎', '镄钔锘', '锿镅钚',
  '镎镅锔', '锫镎镤', '锗镓镝', '镨钕钐', '铕钆铽',
  '镝钬铒', '铥镱镥', '铋锑锆', '锆铪钽', '镅钐铕',
]

const TARGET_COUNT = RARE_MARKERS.length // 20
const DISTRACTOR_COUNT = 180
const TOTAL_COUNT = TARGET_COUNT + DISTRACTOR_COUNT

/** 构造一条合成记忆入参；by 用 'tool'（显式通道）绕开 extractor 写端门，保证必落库 */
function synthInput(i: number, content: string, session: string, workspace: string): NewMemoryInput {
  const source: MemorySource = { sessionId: session, eventSeqs: [i], excerpt: `合成库第 ${i} 条摘录` }
  return { workspace, sessionId: session, kind: 'fact', content, importance: 5, tags: ['recall-bench'], source, by: 'tool' }
}

/** 构造合成库：20 目标（唯一标识词）+ 180 干扰（公共词 + 唯一编号），返回 store */
async function synthLibrary(): Promise<MemoryStore> {
  const store = new MemoryStore(new FakeTable())
  // 180 干扰先落（位置 0..179）——供"常见词稀释"验证典型形态。
  // 每条独立 workspace（`D:/bench/ws-<序号>`）：findSupersededTargets 按 workspace 扫描，
  // 独立 workspace 使 200 条互不覆盖（同 workspace 下的高 Jaccard 公共词内容会触发
  // supersede 折叠）；search 默认不按 workspace 过滤，独立 workspace 不影响召回全量。
  for (let i = 0; i < DISTRACTOR_COUNT; i++) {
    await store.create(synthInput(i, `${COMMON_SENTENCE} 日常记录编号 ${i}，一般性内容。`, `session-d-${i % 8}`, `D:/bench/ws-${i}`))
  }
  // 20 目标后落（位置 180..199），每条含唯一稀有标识词
  for (let i = 0; i < TARGET_COUNT; i++) {
    const marker = RARE_MARKERS[i]
    await store.create(
      synthInput(
        DISTRACTOR_COUNT + i,
        `${COMMON_SENTENCE} 稀有标识 ${marker} 的技术要点需重点记录。`,
        `session-t-${i}`,
        `D:/bench/ws-${DISTRACTOR_COUNT + i}`,
      ),
    )
  }
  return store
}

/** 通过内容判定位居 target 的条目（按唯一标识词归属） */
function isTarget(entry: MemoryEntry, index: number): boolean {
  return entry.content.includes(RARE_MARKERS[index])
}
function isAnyTarget(entry: MemoryEntry): boolean {
  return RARE_MARKERS.some((m) => entry.content.includes(m))
}

describe('recall@k 检索质量评估（合成库）', () => {
  it('recall@5：200 条合成库，20 条目标各以唯一标识词作查询，目标命中 top-5 ≥ 0.9', async () => {
    const store = await synthLibrary()
    let hits = 0
    for (let t = 0; t < TARGET_COUNT; t++) {
      const marker = RARE_MARKERS[t]
      // 仅用稀有标识词作查询（不复用公共词，隔离目标归属的唯一判据）
      const scored = store.search({ query: marker, limit: 5, minScore: 0, withScore: true })
      // minScore=0 + relevance 独大：目标应稳定居首才算命中
      const hit = scored.some(({ entry }) => isTarget(entry, t)) && scored.length > 0
      if (hit) hits++
    }
    const recall = hits / TARGET_COUNT
    // 宽松阈值 ≥0.9（20 中 ≥18）：防 jieba 对个别 OOV 三元组切分抖动
    expect(recall).toBeGreaterThanOrEqual(0.9)
  })

  it('常见词稀释：只查公共词『项目』→ 200 条全部命中且无一目标条目被标识词虚高抬到前排', async () => {
    const store = await synthLibrary()
    const scored = store.search({ query: '项目', limit: TOTAL_COUNT, minScore: 0, withScore: true })

    // 常见词 200 条全覆盖：一条不漏（relevance=1.0 全命中，minScore=0 全放行）
    expect(scored).toHaveLength(TOTAL_COUNT)

    // 无噪声泄漏：公共词查询下，任一目标条目（自带稀有标识词）的分数不得超过
    // 干扰条目的最高分向上一丁点容差。因为 relevance 只看查询 token『项目』，
    // 目标多出的稀有标识词对该查询毫无增益，任何目标的虚高都属噪声泄漏。
    const targetMax = Math.max(...scored.filter(({ entry }) => isAnyTarget(entry)).map(({ score }) => score))
    const distractorMax = Math.max(...scored.filter(({ entry }) => !isAnyTarget(entry)).map(({ score }) => score))
    // 容差 1e-6 仅吸收同刻创建的时间因子浮点微差，杜绝目标因标识词被抬分
    expect(targetMax - distractorMax).toBeLessThan(1e-6)

    // 干扰条目"正常返回"的形态佐证（宽松、不依赖排序）：200 条公共词查询分数应收敛
    // 到同一 0-1 基线带（全命中 → idf 加权 relevance=1.0 × 时间因子≈0.75），无任何一条
    // 被异常拔高——标识词存在与否都对『项目』查询无增益，分数带宽即噪声泄漏探测器。
    const scores = scored.map(({ score }) => score)
    const lo = Math.min(...scores)
    const hi = Math.max(...scores)
    expect(hi - lo).toBeLessThan(0.01)
  })

  it('稀有词权重：同一公共内容，含稀有标识词的条目查询该词时严格高于不含者（IDF 预期行为）', async () => {
    const store = new MemoryStore(new FakeTable())
    const marker = '锕钐钆'
    // A：公共内容 + 稀有标识词；B：仅公共内容（无标识词）。不同 workspace → 触发不了
    // supersede 扫描（按 workspace 隔离），两条都保持 active 参与检索。
    await store.create(synthInput(0, `${COMMON_SENTENCE} 稀有标识 ${marker} 的技术要点。`, 'session-a', 'D:/ws-a'))
    await store.create(synthInput(1, `${COMMON_SENTENCE} 一般性日常内容。`, 'session-b', 'D:/ws-b'))

    const scored = store.search({ query: marker, limit: 10, minScore: 0, withScore: true })
    const rowA = scored.find(({ entry }) => entry.content.includes(marker))
    const rowB = scored.find(({ entry }) => !entry.content.includes(marker))

    // Q4 接线后的新契约（2026-08-17 用户拍板）：关键词路径噪声下限
    // MIN_RELEVANCE_SCORE=0.3——A 命中标识词 rel=1.0 ≥ 下限 → 返回且 ≥0.5 高置信带；
    // B 零重合（rel=0 < 下限）→ 被噪声下限过滤（此前 minScore=0 时也会返回 score=0，
    // 现由下限直接排除——精度优先，宁缺毋滥；语义路径仍可独立召回）。
    expect(rowA).toBeDefined()
    expect(rowB).toBeUndefined()
    expect(rowA!.score).toBeGreaterThanOrEqual(0.5)
  })
})
