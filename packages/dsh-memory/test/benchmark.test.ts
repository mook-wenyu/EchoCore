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
import type { MemoryKind, NewMemoryInput, MemorySource } from '../src/types.js'
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
