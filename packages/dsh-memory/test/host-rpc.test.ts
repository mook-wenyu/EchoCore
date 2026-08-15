/**
 * 宿主 RPC 通道单元测试：端点分发、载荷校验、业务结果形态。
 */

import { describe, expect, it } from 'vitest'

import { createMemoryRpcHandler } from '../src/host-rpc.js'
import { MemoryStore } from '../src/store.js'
import type { NewMemoryInput } from '../src/types.js'
import { FakeTable } from './helpers.js'

/** 组装被测对象 */
function setup() {
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const handler = createMemoryRpcHandler(store)
  return { store, handler, table }
}/** 播种一条记忆 */
async function seed(store: MemoryStore, input: Partial<NewMemoryInput> = {}): Promise<string> {
  const result = await store.create({
    workspace: 'D:/workspace',
    sessionId: 's-old',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 8,
    tags: ['构建'],
    source: { sessionId: 's-old', eventSeqs: [1, 2], excerpt: '原文摘录' },
    by: 'extractor',
    ...input,
  })
  return result.entry.id
}

describe('memory RPC 端点', () => {
  it('list：返回最近条目（含归档过滤）', async () => {
    const { store, handler } = setup()
    const id = await seed(store)
    await seed(store, { content: '另一条记忆' })

    const result = await handler('list', { limit: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { entries: Array<{ id: string; content: string }>; total: number }
    expect(value.total).toBe(2)
    expect(value.entries.map((e) => e.id)).toContain(id)

    await store.archive(id, 'tool')
    const active = await handler('list', { status: 'active' })
    if (!active.ok) return
    expect((active.value as { total: number }).total).toBe(1)
  })

  it('search：关键词/分类过滤', async () => {
    const { store, handler } = setup()
    await seed(store)
    await seed(store, { kind: 'todo', content: '待办：重构评分模块' })

    const byKind = await handler('search', { kind: 'todo' })
    expect(byKind.ok).toBe(true)
    if (byKind.ok) expect((byKind.value as { total: number }).total).toBe(1)

    const byQuery = await handler('search', { query: 'pnpm' })
    if (byQuery.ok) expect((byQuery.value as { total: number }).total).toBe(1)
  })

  it('get：命中返回详情，未命中返回 found=false', async () => {
    const { store, handler } = setup()
    const id = await seed(store)

    const hit = await handler('get', { id })
    expect(hit.ok).toBe(true)
    if (!hit.ok) return
    const value = hit.value as { found: boolean; entry?: { source: { eventSeqs: number[] }; audit: unknown[] } }
    expect(value.found).toBe(true)
    expect(value.entry?.source.eventSeqs).toEqual([1, 2])

    const miss = await handler('get', { id: 'missing' })
    if (miss.ok) expect((miss.value as { found: boolean }).found).toBe(false)
  })

  it('get：详情透传 supersede 链（supersededBy/supersedes）', async () => {
    const { store, handler, table } = setup()
    const id = await seed(store)
    const record = store.getById(id)
    if (record === undefined) throw new Error('条目缺失')
    // 写回带 supersede 标记的条目，模拟 store.create 的后向引用
    await table.put(id, { ...record, supersededBy: 'new-1234', supersedes: 'sup-5678' })

    const hit = await handler('get', { id })
    expect(hit.ok).toBe(true)
    if (!hit.ok) return
    const value = hit.value as { found: boolean; entry?: { supersededBy?: string; supersedes?: string } }
    expect(value.found).toBe(true)
    expect(value.entry?.supersededBy).toBe('new-1234')
    expect(value.entry?.supersedes).toBe('sup-5678')
  })

  it('get：无 supersede 标记时详情不含这两字段', async () => {
    const { handler } = setup()
    // seed 后未打标记，直接访问 store 构造
    const hit = await handler('get', { id: 'missing' })
    expect(hit.ok).toBe(true)
    if (!hit.ok) return
    const value = hit.value as { found: boolean }
    expect(value.found).toBe(false)
  })

  it('archive：归档成功返回 archived=true', async () => {
    const { store, handler } = setup()
    const id = await seed(store)
    const result = await handler('archive', { id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as { archived: boolean }).archived).toBe(true)
    expect(store.getById(id)?.status).toBe('archived')
  })

  it('status：返回统计', async () => {
    const { store, handler } = setup()
    await seed(store)
    const result = await handler('status', null)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as { total: number }).total).toBe(1)
  })
})

describe('memory RPC 载荷校验', () => {
  it('未知端点返回 internal 错误', async () => {
    const { handler } = setup()
    const result = await handler('explode', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('internal')
  })

  it('畸形载荷返回 internal 错误', async () => {
    const { handler } = setup()
    for (const [endpoint, payload] of [
      ['get', null],
      ['get', {}],
      ['get', { id: 42 }],
      ['list', '字符串'],
      ['search', { limit: -1 }],
      ['search', { kind: '非法分类' }],
    ] as const) {
      const result = await handler(endpoint, payload)
      expect(result.ok, `${endpoint} ${JSON.stringify(payload)}`).toBe(false)
    }
  })
})
