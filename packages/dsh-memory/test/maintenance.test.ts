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

import { MemoryMaintenance, type MaintenanceConfig } from '../src/maintenance.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry } from '../src/types.js'
import { FakeTable } from './helpers.js'

/** 固定"现在"：用于过期判断与 store 时间戳（避免测试随时间漂移） */
const NOW = Date.UTC(2025, 0, 15, 0, 0, 0)
/** 一天毫秒数 */
const MS_PER_DAY = 86_400_000
/** 定时器触发所需推进量（config 间隔取 1 小时） */
const INTERVAL_MS = 3_600_000

/** 假 ctx：捕获监听器与 effect disposer */
class FakeCtx {
  readonly listeners = new Map<string, Function>()
  disposer?: () => void
  on(type: string, listener: Function): void {
    this.listeners.set(type, listener)
  }
  effect(fn: () => () => void): void {
    this.disposer = fn()
  }
}

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

/** 配置工厂 */
function config(overrides: Partial<MaintenanceConfig> = {}): MaintenanceConfig {
  return { enableMaintenance: true, maintenanceIntervalHours: 1, ...overrides }
}

/** 组装被测对象：返回 maintenance / ctx / store / 监听器 */
function setup(overrides: Partial<MaintenanceConfig> = {}) {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table, () => NOW)
  const maintenance = new MemoryMaintenance({
    store,
    logger: { warn: () => {}, info: () => {} },
    config: config(overrides),
    now: () => NOW,
  })
  maintenance.install(ctx as unknown as Context)
  return {
    ctx,
    table,
    store,
    maintenance,
    sessionEvent: ctx.listeners.get('session/event') as (session: Session, event: SessionEvent) => void,
    preStep: ctx.listeners.get('agent/pre-step') as (payload: unknown) => void,
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
})

describe('MemoryMaintenance 过期降级（任务 c）', () => {
  it('91 天前、从未访问、重要度≤3 的条目被归档', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const stale = makeEntry({
      id: 'stale',
      content: '过期事实',
      importance: 3,
      accessCount: 0,
      updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString(),
    })
    await table.put(stale.id, stale)
    activate(sessionEvent, makeSession('s1'))
    await maintenance.runOnce()
    expect(store.getById(stale.id)?.status).toBe('archived')
  })

  it('被访问过 或 重要度高 或 距现在不足 90 天的条目不降级', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    const accessed = makeEntry({ id: 'acc', content: '被访问过', accessCount: 3, updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString() })
    const important = makeEntry({ id: 'imp', content: '重要', importance: 4, updatedAt: new Date(NOW - 91 * MS_PER_DAY).toISOString() })
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
  it('候选超过预算只处理前 20 条', async () => {
    const { table, store, sessionEvent, maintenance } = setup()
    // 25 条全部满足过期降级条件的条目；预算 20 → 仅前 20 归档
    for (let i = 0; i < 25; i++) {
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
    expect(store.stats().archived).toBe(20)
    expect(store.stats().active).toBe(5)
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
      ctx.disposer?.()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      expect(store.getById(stale.id)?.status).toBe('active') // 不再触发
    } finally {
      vi.useRealTimers()
    }
  })

  it('enableMaintenance=false 时完全不接线', async () => {
    const ctx = new FakeCtx()
    const store = new MemoryStore(new FakeTable(), () => NOW)
    const maintenance = new MemoryMaintenance({
      store,
      logger: { warn: () => {}, info: () => {} },
      config: config({ enableMaintenance: false }),
      now: () => NOW,
    })
    maintenance.install(ctx as unknown as Context)
    expect(ctx.listeners.size).toBe(0) // 未注册任何监听
    expect(ctx.disposer).toBeUndefined()
  })
})
