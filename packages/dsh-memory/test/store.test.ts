/**
 * 存储模块单元测试：CRUD、去重合并、检索排序、状态流转、统计。
 * 使用内存假表注入，不依赖 Cordis 运行时与真实磁盘后端。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryStore, type SearchOptions } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeTable, settle } from './helpers.js'

/**
 * 可控 id 序列：为「createdAt 相同时按 id 稳定排序」提供确定性 id。
 * 仅当 idSeq 非空时覆盖 newMemoryId（否则回退真实实现），供指定测试注入。
 * 注：vi.mock 提升到模块顶部执行，工厂首次 import 时才运行，idSeq 此刻已就绪。
 */
let idSeq: string[] = []
vi.mock('../src/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/types.js')>()
  return {
    ...actual,
    newMemoryId: () => (idSeq.length > 0 ? (idSeq.shift() as string) : actual.newMemoryId()),
  }
})
beforeEach(() => {
  idSeq = []
})

/** 固定时钟：store 内部全部时间戳由此产生，断言确定 */
const FIXED_NOW = Date.parse('2026-01-15T00:00:00.000Z')
const nowFn = (): number => FIXED_NOW

/** 构造创建入参（测试辅助） */
function input(overrides: Partial<NewMemoryInput> = {}): NewMemoryInput {
  return {
    workspace: 'D:/workspace',
    sessionId: 's1',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 5,
    tags: ['架构'],
    source: { sessionId: 's1', eventSeqs: [3, 4], excerpt: '…原文…' },
    by: 'extractor',
    ...overrides,
  }
}

/** 等待 fire-and-forget 的访问追踪写回落地 */
async function settleAccessWrites(): Promise<void> {
  await settle()
}

describe('MemoryStore.create', () => {
  it('新建条目：默认字段、审计 create、去重索引建立', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry, outcome } = await store.create(input())

    expect(outcome.merged).toBe(false)
    expect(entry.id).toBeTruthy()
    expect(entry.status).toBe('active')
    expect(entry.accessCount).toBe(0)
    expect(entry.importance).toBe(5)
    expect(entry.audit).toEqual([{ action: 'create', at: new Date(FIXED_NOW).toISOString(), by: 'extractor' }])
    expect(store.getById(entry.id)).toBe(entry)
  })

  it('同 workspace 同内容去重合并：来源序号并集、重要性取大、保留既有内容', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const first = await store.create(input({ importance: 3, source: { sessionId: 's1', eventSeqs: [1, 2], excerpt: 'a' } }))
    const second = await store.create(
      input({ importance: 8, source: { sessionId: 's1', eventSeqs: [2, 5], excerpt: 'b' } }),
    )

    expect(second.outcome.merged).toBe(true)
    expect(second.outcome.existingId).toBe(first.entry.id)
    expect(store.getById(first.entry.id)?.importance).toBe(8)
    expect(store.getById(first.entry.id)?.source.eventSeqs).toEqual([1, 2, 5])
    expect(store.getById(first.entry.id)?.content).toBe('项目使用 pnpm workspace 管理多包')
    // 合并时 excerpt 取【新来源】（信息更新，而非保留旧摘录）
    expect(store.getById(first.entry.id)?.source.excerpt).toBe('b')
    expect(store.stats().total).toBe(1)
  })

  it('同内容不同 kind 不合并（O3：索引粒度含 kind，各自成条）', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ kind: 'fact', content: '用户采用 pnpm 管理依赖' }))
    const decision = await store.create(input({ kind: 'decision', content: '用户采用 pnpm 管理依赖' }))
    expect(decision.outcome.merged).toBe(false)
    expect(store.stats().total).toBe(2)
  })

  it('不同 workspace 相同内容不合并，各自成条', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input())
    const other = await store.create(input({ workspace: 'D:/other' }))
    expect(other.outcome.merged).toBe(false)
    expect(store.stats().total).toBe(2)
  })
})

describe('MemoryStore 状态流转', () => {
  it('update 修改字段并追加审计；不存在返回 undefined', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input())
    const updated = await store.update(entry.id, { importance: 9 }, 'tool')
    expect(updated?.importance).toBe(9)
    expect(updated?.audit.at(-1)).toMatchObject({ action: 'update', by: 'tool' })
    expect(await store.update('missing', {}, 'tool')).toBeUndefined()
  })

  it('更新白名单不含 content（O3 编译期契约：改正文必须走 create，防 dedupKey 漂移）', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input())
    // @ts-expect-error -- patch 白名单不再包含 content，由 tsc --noEmit 校验该契约
    await store.update(entry.id, { content: '不应可更新' }, 'tool')
    // 运行期（类型擦除）不强断言正文：compile-time 契约由 tsc 把关
    expect(store.getById(entry.id)).toBeDefined()
  })

  it('archive 后从检索消失（D-D 裁决：无 restore，恢复=重建）', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input({ content: '用户偏好使用简体中文交流' }))

    expect(store.search({ query: '中文' })).toHaveLength(1)
    expect(await store.archive(entry.id, 'tool')).toBe(true)
    expect(store.search({ query: '中文' })).toHaveLength(0)
    // 归档后同内容新建：不被归档条目吞并（O3 守卫），得到新条目
    const again = await store.create(input({ content: '用户偏好使用简体中文交流' }))
    expect(again.outcome.merged).toBe(false)
    expect(store.search({ query: '中文' })).toHaveLength(1)
    expect(store.getById(again.entry.id)?.status).toBe('active')
  })
})

describe('MemoryStore.search', () => {
  it('空查询返回空', () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    expect(store.search({ query: '  ' })).toEqual([])
  })

  it('按综合分降序返回并受 limit 约束', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ content: 'pnpm workspace 管理多包', importance: 9 }))
    await store.create(input({ content: 'pnpm 版本管理', importance: 1 }))
    await store.create(input({ content: 'vite 构建', importance: 5 }))

    const results = store.search({ query: 'pnpm', limit: 2 })
    expect(results).toHaveLength(2)
    expect(results[0]?.content).toBe('pnpm workspace 管理多包')
  })

  it('kind 过滤生效', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ kind: 'todo', content: '待办：重构评分模块' }))
    await store.create(input({ kind: 'decision', content: '决定：采用评分检索' }))
    const todos = store.search({ query: '重构', kind: 'todo' })
    expect(todos).toHaveLength(1)
    expect(todos[0]?.kind).toBe('todo')
  })

  it('命中后异步回写访问计数与时间', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input())
    store.search({ query: 'pnpm' })
    await settleAccessWrites()
    const after = store.getById(entry.id)
    expect(after?.accessCount).toBe(1)
    expect(after?.lastAccessAt).toBe(new Date(FIXED_NOW).toISOString())
  })

  it('workspace 过滤：跨项目记忆不串入', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ content: '本项目的 pnpm 配置' }))
    await store.create(input({ workspace: 'D:/other', content: '他项目的 pnpm 配置' }))
    const results = store.search({ query: 'pnpm', workspace: 'D:/workspace' })
    expect(results).toHaveLength(1)
    expect(results[0]?.workspace).toBe('D:/workspace')
  })

  it('低于最低分的弱命中被过滤', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ content: 'pnpm workspace', importance: 0 }))
    const results = store.search({ query: 'pnpm workspace 完全不相关的词', minScore: 0.5 })
    expect(results).toEqual([])
  })
})

describe('MemoryStore 统计与列表', () => {
  it('stats 分类计数', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ kind: 'fact' }))
    await store.create(input({ kind: 'todo', content: '待办事项甲' }))
    await store.create(input({ kind: 'todo', content: '待办事项乙' }))
    await store.create(input({ kind: 'decision', content: '决定事项' }))

    const stats = store.stats()
    expect(stats.total).toBe(4)
    expect(stats.active).toBe(4)
    expect(stats.byKind.fact).toBe(1)
    expect(stats.byKind.todo).toBe(2)
    expect(stats.byKind.decision).toBe(1)
  })

  it('listBySession 按会话过滤并按创建时间升序', async () => {
    let clock = FIXED_NOW
    const store = new MemoryStore(new FakeTable(), () => clock)
    await store.create(input({ sessionId: 's1', content: '甲' }))
    clock += 1000 // 推进时钟：'甲' 严格早于 '丙'，验证「创建时间升序」而非依赖 id 排序
    await store.create(input({ sessionId: 's2', content: '乙' }))
    await store.create(input({ sessionId: 's1', content: '丙' }))
    const list = store.listBySession('s1')
    expect(list.map((e) => e.content)).toEqual(['甲', '丙'])
  })
})

describe('SearchOptions 完整性', () => {
  it('检索选项全部可省略（默认值路径）', () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const options: SearchOptions = { query: 'x' }
    expect(store.search(options)).toEqual([])
  })
})

describe('MemoryStore D-A 后向引用（supersede, O3）', () => {
  // 使用 Jaccard≥0.7 的一对记忆（实测 0.778）：旧决策被新决策覆盖
  const OLD = '决定采用评分检索'
  const NEW = '决定采用评分检索方案'

  it('新决策覆盖旧决策（Jaccard≥0.7）：旧条目标记 supersededBy，新条目标记 supersedes', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const oldE = (await store.create(input({ kind: 'decision', content: OLD }))).entry
    const newE = (await store.create(input({ kind: 'decision', content: NEW }))).entry
    expect(store.getById(oldE.id)?.supersededBy).toBe(newE.id)
    expect(store.getById(newE.id)?.supersedes).toBe(oldE.id)
    // 被覆盖条目的 status 不变（仍 active，仅检索隐藏）
    expect(store.getById(oldE.id)?.status).toBe('active')
  })

  it('重合度不足（<0.7）不覆盖', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const first = (await store.create(input({ kind: 'decision', content: '决定采用 Node.js 后端' }))).entry
    const second = (await store.create(input({ kind: 'decision', content: '前端改用 React' }))).entry
    expect(store.getById(first.id)?.supersededBy).toBeUndefined()
    expect(store.getById(second.id)?.supersedes).toBeUndefined()
    expect(store.stats().total).toBe(2)
  })

  it('检索默认排除被覆盖条目', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ kind: 'decision', content: OLD }))
    const newE = (await store.create(input({ kind: 'decision', content: NEW }))).entry
    const results = store.search({ query: '评分', kind: 'decision' })
    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe(newE.id)
    expect(results[0]?.supersededBy).toBeUndefined()
  })

  it('includeSuperseded 时可见被覆盖条目', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const oldE = (await store.create(input({ kind: 'decision', content: OLD }))).entry
    const newE = (await store.create(input({ kind: 'decision', content: NEW }))).entry
    const results = store.search({ query: '', kind: 'decision', includeSuperseded: true })
    const ids = results.map((e) => e.id)
    expect(ids).toContain(oldE.id)
    expect(ids).toContain(newE.id)
  })

  it('supersede 审计：旧条目追加 supersede 动作与说明', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const oldE = (await store.create(input({ kind: 'decision', content: OLD }))).entry
    const newE = (await store.create(input({ kind: 'decision', content: NEW }))).entry
    const audit = store.getById(oldE.id)?.audit
    expect(audit?.at(-1)).toMatchObject({ action: 'supersede', by: 'extractor' })
    expect(audit?.at(-1)?.detail).toMatch(/被记忆 #.+覆盖/)
    expect(audit?.at(-1)?.detail).toContain(newE.id)
  })

  it('跨 kind 不互相覆盖', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const factE = (await store.create(input({ kind: 'fact', content: NEW }))).entry
    const decisionE = (await store.create(input({ kind: 'decision', content: NEW }))).entry
    expect(store.getById(factE.id)?.supersededBy).toBeUndefined()
    expect(store.getById(decisionE.id)?.supersedes).toBeUndefined()
  })
})

describe('MemoryStore 排序 tie-breaker（O3）', () => {
  it('createdAt 相同时按 id 稳定排序（search 空查询 / listBySession / listRecent）', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    idSeq = ['mem-c', 'mem-a', 'mem-b']
    const a = (await store.create(input({ content: '甲' }))).entry
    const b = (await store.create(input({ content: '乙' }))).entry
    const c = (await store.create(input({ content: '丙' }))).entry
    // 固定时钟 → 三者 createdAt 相同
    expect(a.createdAt).toBe(b.createdAt)
    expect(b.createdAt).toBe(c.createdAt)
    // listBySession 升序：按 id 升序
    expect(store.listBySession('s1').map((e) => e.id)).toEqual(['mem-a', 'mem-b', 'mem-c'])
    // listRecent 降序：按 id 降序
    expect(store.listRecent(10).map((e) => e.id)).toEqual(['mem-c', 'mem-b', 'mem-a'])
    // search 空查询+过滤 降序：按 id 降序
    expect(store.search({ query: '', kind: 'fact' }).map((e) => e.id)).toEqual(['mem-c', 'mem-b', 'mem-a'])
  })
})

describe('MemoryStore 访问追踪节流（O6）', () => {
  it('60s 内重复命中同一记忆只回写一次（注入固定时钟）', async () => {
    let clock = FIXED_NOW
    const store = new MemoryStore(new FakeTable(), () => clock)
    const { entry } = await store.create(input())
    store.search({ query: 'pnpm' })
    await settleAccessWrites()
    expect(store.getById(entry.id)?.accessCount).toBe(1)
    // 60s 内再次命中：不再回写
    store.search({ query: 'pnpm' })
    await settleAccessWrites()
    expect(store.getById(entry.id)?.accessCount).toBe(1)
  })

  it('超过 60s 再次命中执行更新', async () => {
    let clock = FIXED_NOW
    const store = new MemoryStore(new FakeTable(), () => clock)
    const { entry } = await store.create(input())
    store.search({ query: 'pnpm' })
    await settleAccessWrites()
    expect(store.getById(entry.id)?.accessCount).toBe(1)
    clock += 61_000 // 越过 60s 阈值
    store.search({ query: 'pnpm' })
    await settleAccessWrites()
    expect(store.getById(entry.id)?.accessCount).toBe(2)
  })
})
