/**
 * 后台记忆整理（O8-M）单元测试。
 *
 * 覆盖：活动门、重复合并（Jaccard）、过期降级、标签整理、批预算、定时器清理。
 * 全部经公共接口驱动：FakeCtx 捕获监听器与 effect disposer；store 用 FakeTable
 * 注入固定时钟；定时行为用 vi.useFakeTimers 控制。
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { BACKFILL_BUDGET, MAINTENANCE_INTERVAL_MS, MemoryMaintenance } from '../src/maintenance.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry } from '../src/types.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 固定"现在"：用于过期判断与 store 时间戳（避免测试随时间漂移） */
const NOW = Date.UTC(2025, 0, 15, 0, 0, 0)
/** 一天毫秒数 */
const MS_PER_DAY = 86_400_000
/** 定时器触发所需推进量（整理间隔已常量化：G2 起为 1 小时） */
const INTERVAL_MS = MAINTENANCE_INTERVAL_MS

/** 构造 request/header 事件（模型路由来源） */
function headerEvent(seq: number): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: seq,
    data: { header: { config: { provider: 'deepseek', model: 'm' } }, reason: 'initial' },
  } as SessionEvent
}

/** 构造会话（带路由来源的 request/header） */
function makeSession(id: string): Session {
  return { id, header: { version: 0, id, createdAt: 1, cwd: 'D:/ws' }, events: [headerEvent(1)] } as Session
}

/** 条目工厂：直接在假表种入受控条目（审计/来源等字段按需补全） */
function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const base = {
    workspace: 'D:/ws',
    sessionId: 's1',
    kind: 'fact' as const,
    content: '内容',
    importance: 5,
    tags: [] as string[],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '亲' },
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

/** 组装被测对象：返回 maintenance / ctx / store / 监听器（整理行为已常量化：恒启用、间隔 1 小时） */
function setup() {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table, () => NOW)
  const maintenance = new MemoryMaintenance({
    store,
    logger: { warn: () => {}, info: () => {} },
    now: () => NOW,
  })
  maintenance.install(ctx as unknown as Context)
  return {
    ctx,
    table,
    store,
    maintenance,
    sessionEvent: ctx.listener('session/event') as (session: Session, event: SessionEvent) => void,
    preStep: ctx.listener('agent/pre-step') as (payload: unknown) => void,
  }
}

/** 通过 session/event 标记一次活动（驱动活动门） */
function activate(sessionEvent: (s: Session, e: SessionEvent) => void, session: Session): void {
  sessionEvent(session, headerEvent(1))
}

describe('MemoryMaintenance 活动门', () => {
  it('无活动不启动计时，运行期不执行任何整理', async () => {
    vi.useFakeTimers()
    try {
      const { table, maintenance } = setup()
      const stale = makeEntry({ id: 'stale', content: '过期记忆甲', updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(), importance: 2 })
      await table.put(stale.id, stale)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      await maintenance.runOnce() // 显式调用亦因无活动返回
      expect(table.get(stale.id)?.status).toBe('active') // 无活动则永不整理
    } finally {
      vi.useRealTimers()
    }
  })

  it('有活动后定时触发一次整理', async () => {
    vi.useFakeTimers()
    try {
      const { table, store, sessionEvent, maintenance } = setup()
      const stale = makeEntry({ id: 'stale', content: '过期记忆乙', updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(), importance: 2 })
      await table.put(stale.id, stale)
      activate(sessionEvent, makeSession('s1')) // 标记活动 → 启动计时
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + 1) // 推进过一个周期
      expect(store.getById(stale.id)?.status).toBe('archived')
      expect(store.stats().active).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('无可用模型路由时跳过本批，不动任何条目', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const session = { id: 's1', header: { version: 0, id: 's1', createdAt: 1, cwd: 'D:/ws' }, events: [] } as unknown as Session
    const stale = makeEntry({ id: 'stale', content: '过期记忆丙', updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(), importance: 2 })
    await table.put(stale.id, stale)
    activate(sessionEvent, session) // 会话无 request/header → 无路由
    await maintenance.runOnce()
    expect(store.getById(stale.id)?.status).toBe('active')
  })
})

describe('MemoryMaintenance 重复合并（任务 a）', () => {
  it('Jaccard≥0.85 的近似重复对：保留新者并提升重要度，旧者归档', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 二者高度相似（仅差一个词），重要度差 2（7 vs 5）→ 合并后新者重要度应升至 7
    const older = makeEntry({
      id: 'old',
      content: 'keep all logs for compliance and audit',
      importance: 7,
      createdAt: new Date(NOW - 2 * MS_PER_DAY).toISOString(),
    })
    const newer = makeEntry({
      id: 'new',
      content: 'keep all logs for compliance and audit forever',
      importance: 5,
      createdAt: new Date(NOW).toISOString(),
    })
    await table.put(older.id, older)
    await table.put(newer.id, newer)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()

    expect(store.getById('old')?.status).toBe('archived') // 旧者归档
    expect(store.getById('new')?.status).toBe('active') // 新者保留
    expect(store.getById('new')?.importance).toBe(7) // 重要度取更大者
  })

  it('低相似度对不合并', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const a = makeEntry({ id: 'a', content: 'completely different topic about weather processing' })
    const b = makeEntry({ id: 'b', content: 'unrelated need to fix engine performance bug' })
    await table.put(a.id, a)
    await table.put(b.id, b)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById('a')?.status).toBe('active')
    expect(store.getById('b')?.status).toBe('active')
    expect(store.stats().active).toBe(2)
  })

  it('与 extractor 提取并发写入：无交错损坏，合并与新写入都正确（P1-2 交叠补盲）', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 预置一对近似重复（maintenance 合并目标；时间差明确合并方向）
    const older = makeEntry({ id: 'old', content: 'keep all logs for compliance and audit', createdAt: new Date(NOW - 2 * MS_PER_DAY).toISOString() })
    const newer = makeEntry({ id: 'new', content: 'keep all logs for compliance and audit forever' })
    await table.put(older.id, older)
    await table.put(newer.id, newer)
    activate(sessionEvent, makeSession('s1'))

    // 模拟 extractor 批次并发写入（同一 store；内容互不近似，不与维护窗口配对）
    const concurrentWrites = Promise.all([
      store.create({
        workspace: 'D:/ws',
        sessionId: 's1',
        kind: 'fact',
        content: 'pnpm workspace 管理多包依赖',
        source: { sessionId: 's1', eventSeqs: [9], excerpt: '摘录' },
        by: 'extractor',
      }),
      store.create({
        workspace: 'D:/ws',
        sessionId: 's1',
        kind: 'fact',
        content: 'vitest 配置测试环境',
        source: { sessionId: 's1', eventSeqs: [10], excerpt: '摘录' },
        by: 'extractor',
      }),
    ])

    // maintenance 与 extractor 写入并发执行（Promise.all 交错调度）
    const [results, ,] = await Promise.all([concurrentWrites, maintenance.runOnce()])
    const created = results.map((r) => r.entry.id)
    expect(created).toHaveLength(2)
    // 合并正常完成：旧者归档、新者保留
    expect(store.getById('old')?.status).toBe('archived')
    expect(store.getById('new')?.status).toBe('active')
    // 并发写入无丢失、无串写（两条独立事实都在且未被合并误伤）
    for (const id of created) {
      expect(store.getById(id)?.status).toBe('active')
    }
    expect(store.stats().total).toBe(4)
  })

  it('create supersede 优先于维护合并：被覆盖条目不参与配对（P1-2 交错语义）', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 预置一条旧表述；随后顺序创建两条互为近似重复（Jaccant 0.889 ≥ 0.85）
    const old = makeEntry({ id: 'old', content: 'keep all logs for compliance and audit', createdAt: new Date(NOW - 2 * MS_PER_DAY).toISOString() })
    await table.put(old.id, old)
    activate(sessionEvent, makeSession('s1'))

    // 顺序创建（真实提取批次语义：串行 await）——create2 完成 supersede create1
    const r1 = await store.create({
      workspace: 'D:/ws', sessionId: 's1', kind: 'fact',
      content: '并发写入的独立事实',
      source: { sessionId: 's1', eventSeqs: [9], excerpt: '摘录' }, by: 'extractor',
    })
    const r2 = await store.create({
      workspace: 'D:/ws', sessionId: 's1', kind: 'fact',
      content: '并发写入的独立事实二',
      source: { sessionId: 's1', eventSeqs: [10], excerpt: '摘录' }, by: 'extractor',
    })
    // create2 已 supersede create1（检索排除 create1）；维护不得再合并/归档
    // "现行表述"（create2）——否则两个都从检索消失。注意 create 返回值是
    // 本地构造快照，supersede 回写在 table 上——须重读断言。
    expect(store.getById(r1.entry.id)?.supersededBy).toBeDefined()
    expect(store.getById(r2.entry.id)?.supersededBy).toBeUndefined()
    await maintenance.runOnce()
    expect(store.getById(r2.entry.id)?.status).toBe('active')
    // 检索仍能命中现行表述（未被维护误归档）
    const hits = store.search({ query: '独立事实', kind: 'fact' })
    expect(hits.map((e) => e.id)).toContain(r2.entry.id)
    expect(hits.map((e) => e.id)).not.toContain(r1.entry.id)
  })

  it('同刻 createdAt 的合并方向确定：归档 id 小者（tie-breaker，不依赖扫描序，P1-2 回归）', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 同刻创建（并发写入/同批导入）：合并方向必须确定——保留 id 大者、归档 id 小者
    const small = makeEntry({ id: 'aaa', content: 'keep all logs for compliance and audit' })
    const large = makeEntry({ id: 'zzz', content: 'keep all logs for compliance and audit forever' })
    await table.put(small.id, small)
    await table.put(large.id, large)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    // 'zzz' > 'aaa' → zzz 保留、aaa 归档（不依赖窗口扫描顺序）
    expect(store.getById('aaa')?.status).toBe('archived')
    expect(store.getById('zzz')?.status).toBe('active')
  })
})

describe('MemoryMaintenance 过期降级（任务 c）', () => {
  it('91 天前、从未访问、重要度≤5 的条目被归档', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const stale = makeEntry({
      id: 'stale',
      content: '过期事实',
      importance: 5,
      accessCount: 0,
      updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(),
    })
    await table.put(stale.id, stale)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById(stale.id)?.status).toBe('archived')
  })

  it('G2 新语义回归：imp=5 中低重要度 + 从未访问 + 超 90 天也被降权（旧条件 imp>3 不放行）', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // G2 前 MAX_STALE_IMPORTANCE=3，imp=4/5 仅 36 条可降级，2108 条 imp 4-7 永不回收；
    // 放宽至 5 后，imp=5 且长期未访问必须归档，防止记忆库只进难收。
    const stale = makeEntry({
      id: 'stale5',
      content: '中低重要度长期未访问',
      importance: 5,
      accessCount: 0,
      updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(),
    })
    await table.put(stale.id, stale)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById(stale.id)?.status).toBe('archived')
  })

  it('G2 防回归保活：imp=6 及以上的条目不因长期未访问而降权', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // imp≥6 为高重要度保活语义（MAX_STALE_IMPORTANCE=5），即使从未访问且超 90 天也不回收，
    // 避免把用户真正重视的项目规则/事实清出检索。
    const high = makeEntry({
      id: 'imp6',
      content: '高重要度事实',
      importance: 6,
      accessCount: 0,
      updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(),
    })
    await table.put(high.id, high)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById(high.id)?.status).toBe('active')
  })

  it('被访问过 或 重要度高(≥6) 或 距现在不足 90 天的条目不降级', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const accessed = makeEntry({ id: 'acc', content: '被访问过', accessCount: 3, updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString() })
    // G2 变更记录：原用例 const imp 用 importance: 4（MAX_STALE_IMPORTANCE=3 时代 imp>3 不降级）
    // 断言 active；放宽到 ≤5 后 imp=4 会被回收，故改高为 6 以保持"不降级"分支语义（保活）。
    const important = makeEntry({ id: 'imp', content: '重要', importance: 6, updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString() })
    const fresh = makeEntry({ id: 'fresh', content: '较新', importance: 1, updatedAt: new Date(NOW - 10 * MS_PER_DAY).toISOString() })
    await table.put(accessed.id, accessed)
    await table.put(important.id, important)
    await table.put(fresh.id, fresh)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById('acc')?.status).toBe('active')
    expect(store.getById('imp')?.status).toBe('active')
    expect(store.getById('fresh')?.status).toBe('active')
    expect(store.stats().active).toBe(3)
  })
})

describe('MemoryMaintenance 标签整理（任务 d）', () => {
  it('大小写变体统一为小写并去重', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const entry = makeEntry({ id: 'tag', content: '标签演示', tags: ['Vite', 'vite', 'USE'] })
    await table.put(entry.id, entry)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById('tag')?.tags).toEqual(['vite', 'use'])
  })
})

describe('MemoryMaintenance 批预算', () => {
  it('候选超过预算只处理前 200 条（G2 由 20→200）', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // G2 前 BATCH_BUDGET=20，单批仅处理最新 20 条；放宽到 200（含候选窗口上限 200）
    // 后对 3441 条规模更游刃有余。此处 250 条全部满足过期降级 → 单批最多处理 200 条。
    for (let i = 0; i < 250; i++) {
      const entry = makeEntry({
        id: `e${i}`,
        content: `过期条目 ${i}`,
        importance: 1,
        accessCount: 0,
        createdAt: new Date(NOW - i * MS_PER_DAY).toISOString(),
        updatedAt: new Date(NOW - 95 * MS_PER_DAY).toISOString(),
      })
      await table.put(entry.id, entry)
    }
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.stats().archived).toBe(200)
    expect(store.stats().active).toBe(50)
  })
})

describe('MemoryMaintenance 重入互斥（定时+手动并发合并为一次）', () => {
  it('并发调用 runOnce 两次：返回同一 promise，只执行一次完整批次；结束后 running 复位可再开新批次', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 计数 listRecent：每次开启一个完整批次都会调用它（作为"完整批次执行"观测点）
    let listRecentCalls = 0
    const origListRecent = store.listRecent.bind(store)
    store.listRecent = ((limit: number, status?: unknown) => {
      listRecentCalls++
      return origListRecent(limit, status as Parameters<typeof origListRecent>[1])
    }) as typeof store.listRecent

    // 预置一对将被合并的近似重复（保证批次有真实工作：merge/archive）
    const older = makeEntry({ id: 'old', content: 'keep all logs for compliance and audit', createdAt: new Date(NOW - 2 * MS_PER_DAY).toISOString() })
    const newer = makeEntry({ id: 'new', content: 'keep all logs for compliance and audit forever' })
    await table.put(older.id, older)
    await table.put(newer.id, newer)
    activate(sessionEvent, makeSession('s1'))

    // 并发调用两次（第二次发生在第一次执行中）→ 合并到同一 promise，不重复执行
    const p1 = maintenance.runOnce()
    const p2 = maintenance.runOnce()
    expect(p2).toBe(p1) // 返回同一 promise
    await Promise.all([p1, p2])
    expect(listRecentCalls).toBe(1) // 只执行一次完整批次（未重复）

    // 结束后 running 已复位：再次调用开启新批次（不残留死锁）
    await maintenance.runOnce()
    expect(listRecentCalls).toBe(2)

    // 合并结果正确（并发不破坏）
    expect(store.getById('old')?.status).toBe('archived')
    expect(store.getById('new')?.status).toBe('active')
  })
})

describe('MemoryMaintenance 重读补查 supersededBy（P1-2 并发一致性）', () => {
  it('archiveStale 不归档被 supersededBy 覆盖的过期条目（与 mergeDuplicates 同语义）', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 过期 + 从未访问 + 低重要度，但已被 supersededBy 覆盖（P1-2：批次快照后被
    // 并发 create 覆盖的窗口条目——listRecent 快照时尚未 supersede，archiveStale
    // 重读时才看到）。用 includeSuperseded 变体让它进入窗口以模拟该竞态。
    const superseded = makeEntry({
      id: 'sup',
      content: '旧表述',
      importance: 2,
      accessCount: 0,
      createdAt: new Date(NOW - 95 * MS_PER_DAY).toISOString(),
      updatedAt: new Date(NOW - 95 * MS_PER_DAY).toISOString(),
      supersededBy: 'new',
    })
    await table.put(superseded.id, superseded)
    // 复刻"窗口快照已包含该条目"：强制 listRecent 把被覆盖条目也纳入窗口
    const origListRecent = store.listRecent.bind(store)
    store.listRecent = ((limit: number, status?: unknown) =>
      origListRecent(limit, status as Parameters<typeof origListRecent>[1], true)) as typeof store.listRecent

    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    // 被覆盖条目不得被归档（否则"现行表述"体系被破坏）
    expect(store.getById('sup')?.status).toBe('active')
  })

  it('normalizeTags 不改写被 supersededBy 覆盖条目的标签', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const superseded = makeEntry({
      id: 'suptag',
      content: '旧表述',
      tags: ['Vite', 'vite', 'USE'], // 需归一化的大小写分裂标签
      supersededBy: 'new',
    })
    await table.put(superseded.id, superseded)
    const origListRecent = store.listRecent.bind(store)
    store.listRecent = ((limit: number, status?: unknown) =>
      origListRecent(limit, status as Parameters<typeof origListRecent>[1], true)) as typeof store.listRecent

    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    // 被覆盖条目标签保持原样（不归一化白跑）
    expect(store.getById('suptag')?.tags).toEqual(['Vite', 'vite', 'USE'])
  })
})

describe('MemoryMaintenance 定时器清理', () => {
  it('install 后有活动启动计时；dispose 后不再触发', async () => {
    vi.useFakeTimers()
    try {
      const { table, store, ctx, sessionEvent } = setup()
      const stale = makeEntry({ id: 'stale', content: '清理前', updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(), importance: 2 })
      await table.put(stale.id, stale)
      activate(sessionEvent, makeSession('s1')) // 活动 → 计时挂起
      // 生命周期 dispose：清空定时，解除活动态
      ctx.disposers[0]?.()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      expect(store.getById(stale.id)?.status).toBe('active') // 不再触发
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MemoryMaintenance LLM 子任务接线（反思/因果）', () => {
  it('注入反思/因果子任务后 runOnce 依次调用并透传路由（规则任务之后）', async () => {
    const calls: string[] = []
    const reflector = {
      async runOnce(route: { provider: string; model: string }) {
        calls.push(`reflect:${route.provider}/${route.model}`)
        return { reviewed: 1, decisions: 0, merged: 0, archived: 0, skipped: 0 }
      },
    }
    const causal = {
      async runOnce(route: { provider: string; model: string }) {
        calls.push(`causal:${route.provider}/${route.model}`)
        return { reviewed: 1, edges: 0, created: 0, skipped: 0 }
      },
    }
    const ctx = new FakeCtx()
    const table = new FakeTable()
    const store = new MemoryStore(table, () => NOW)
    const maintenance = new MemoryMaintenance({
      store,
      logger: { warn: () => {}, info: () => {} },
      now: () => NOW,
      reflector,
      causal,
    })
    maintenance.install(ctx as unknown as Context)
    const sessionEvent = ctx.listener('session/event') as (session: Session, event: SessionEvent) => void
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    // 规则任务后按序调用：反思 → 因果；路由来自会话 request/header
    expect(calls).toEqual(['reflect:deepseek/m', 'causal:deepseek/m'])
  })

  it('C33：注入 backfill 后 runOnce 调用一次且预算恒为 BACKFILL_BUDGET', async () => {
    const calls: string[] = []
    const backfill = async (budget: number) => {
      calls.push(`backfill:${budget}`)
      return 0
    }
    const ctx = new FakeCtx()
    const table = new FakeTable()
    const store = new MemoryStore(table, () => NOW)
    const maintenance = new MemoryMaintenance({
      store,
      logger: { warn: () => {}, info: () => {} },
      now: () => NOW,
      backfill,
    })
    maintenance.install(ctx as unknown as Context)
    const sessionEvent = ctx.listener('session/event') as (session: Session, event: SessionEvent) => void
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    // 每维护周期补一档（限速防限流）；常量必须导出且唯一
    expect(calls).toEqual([`backfill:${BACKFILL_BUDGET}`])
  })

  it('子任务抛错不打断批次：warn 后继续执行其余子任务，批次完成记录照常更新', async () => {
    const calls: string[] = []
    const reflector = {
      async runOnce() {
        throw new Error('反思器爆炸')
      },
    }
    const causal = {
      async runOnce(route: { provider: string; model: string }) {
        calls.push(`causal:${route.provider}/${route.model}`)
        return { reviewed: 0, edges: 0, created: 0, skipped: 0 }
      },
    }
    const ctx = new FakeCtx()
    const table = new FakeTable()
    const store = new MemoryStore(table, () => NOW)
    const maintenance = new MemoryMaintenance({
      store,
      logger: { warn: () => {}, info: () => {} },
      now: () => NOW,
      reflector,
      causal,
    })
    maintenance.install(ctx as unknown as Context)
    const sessionEvent = ctx.listener('session/event') as (session: Session, event: SessionEvent) => void
    activate(sessionEvent, makeSession('s1'))
    await expect(maintenance.runOnce()).resolves.toBeUndefined()
    expect(calls).toEqual(['causal:deepseek/m'])
    expect(maintenance.lastRunAt).not.toBeNull() // 批次成功完成（子任务失败被收容）
  })
})

