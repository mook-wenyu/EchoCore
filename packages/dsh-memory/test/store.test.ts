/**
 * 存储模块单元测试：CRUD、去重合并、检索排序、状态流转、统计。
 * 使用内存假表注入，不依赖 Cordis 运行时与真实磁盘后端。
 */

import { describe, expect, it } from 'vitest'

import { MemoryStore, type SearchOptions } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeTable, settle } from './helpers.js'

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
    expect(store.stats().total).toBe(1)
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

  it('archive 后从检索消失、可 restore 恢复', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input({ content: '用户偏好使用简体中文交流' }))

    expect(store.search({ query: '中文' })).toHaveLength(1)
    expect(await store.archive(entry.id, 'tool')).toBe(true)
    expect(store.search({ query: '中文' })).toHaveLength(0)
    expect(await store.restore(entry.id, 'user')).toBe(true)
    expect(store.search({ query: '中文' })).toHaveLength(1)
  })

  it('hardDelete 物理移除并清理去重索引', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input())
    expect(await store.hardDelete(entry.id, 'user')).toBe(true)
    expect(store.getById(entry.id)).toBeUndefined()
    // 同内容可再次新建（去重索引已清理）
    const again = await store.create(input())
    expect(again.outcome.merged).toBe(false)
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
    const store = new MemoryStore(new FakeTable(), nowFn)
    await store.create(input({ sessionId: 's1', content: '甲' }))
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
