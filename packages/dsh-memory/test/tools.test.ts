/**
 * 模型工具集单元测试：六个工具的 schema 注册、执行行为与规范输出。
 * 直接调用 defineTool 定义上的 execute（注册表验证由 DSH 侧保证）。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { registerMemoryTools, sessionIdOf, toDetail } from '../src/tools.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 假执行上下文（workspace 解析用） */
function fakeExec(agentId = 's1', cwd = 'D:/workspace') {
  return {
    agent: { id: agentId, session: { id: agentId, header: { cwd } } },
    signal: new AbortController().signal,
  }
}

/** 组装被测对象：注册全部工具，返回定义表与 store（R3-1：统一 FakeCtx） */
function setup() {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  registerMemoryTools(ctx as unknown as Context, { store })
  return { tools: ctx.toolDefs, store, table }
}

/** 取一个工具定义 */
function toolOf(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
  const def = tools.get(name)
  if (def === undefined) throw new Error(`工具 ${name} 未注册`)
  return def
}

/** 播种一条记忆 */
async function seed(store: MemoryStore, input: Partial<NewMemoryInput> = {}): Promise<string> {
  const result = await store.create({
    workspace: 'D:/workspace',
    sessionId: 's-old',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 8,
    tags: ['构建'],
    source: { sessionId: 's-old', eventSeqs: [1, 2], excerpt: '原文摘录内容' },
    by: 'extractor',
    ...input,
  })
  return result.entry.id
}

describe('工具注册', () => {
  it('六个工具全部注册', () => {
    const { tools } = setup()
    for (const name of ['memory_recall', 'memory_search', 'memory_note', 'memory_forget', 'memory_audit', 'memory_status']) {
      expect(tools.has(name), name).toBe(true)
    }
  })
})

describe('memory_recall', () => {
  it('按查询返回相关记忆（带 id 与来源会话），workspace 隔离', async () => {
    const { tools, store } = setup()
    const id = await seed(store)
    await seed(store, { workspace: 'D:/other', content: '他项目的 pnpm' })

    const def = toolOf(tools, 'memory_recall')
    const result = (await def.execute({ query: 'pnpm workspace', limit: 5 }, fakeExec() as never)) as {
      memories: Array<{ id: string; sessionId: string; eventSeqs: number[] }>
      total: number
    }
    expect(result.total).toBe(1)
    expect(result.memories[0]?.id).toBe(id)
    expect(result.memories[0]?.sessionId).toBe('s-old')
    expect(result.memories[0]?.eventSeqs).toEqual([1, 2])
  })

  it('无命中返回空数组', async () => {
    const { tools, store } = setup()
    await seed(store)
    const def = toolOf(tools, 'memory_recall')
    const result = (await def.execute({ query: '完全无关词汇xyz' }, fakeExec() as never)) as { total: number }
    expect(result.total).toBe(0)
  })
})

describe('memory_search', () => {
  it('支持分类/标签/状态过滤与关键词', async () => {
    const { tools, store } = setup()
    const todoId = await seed(store, { kind: 'todo', content: '待办：重构评分模块', tags: ['重构'] })
    await seed(store, { kind: 'decision', content: '决定：采用评分检索', tags: ['架构'] })

    const def = toolOf(tools, 'memory_search')
    const byKind = (await def.execute({ kind: 'todo' }, fakeExec() as never)) as { total: number }
    expect(byKind.total).toBe(1)

    const byTag = (await def.execute({ tag: '架构' }, fakeExec() as never)) as { total: number }
    expect(byTag.total).toBe(1)

    const byQuery = (await def.execute({ query: '重构', limit: 10 }, fakeExec() as never)) as { total: number }
    expect(byQuery.total).toBe(1)

    void todoId
  })

  it('归档条目默认不出现，指定 status 可出现', async () => {
    const { tools, store } = setup()
    const id = await seed(store)
    await store.archive(id, 'tool')

    const def = toolOf(tools, 'memory_search')
    const active = (await def.execute({ query: 'pnpm' }, fakeExec() as never)) as { total: number }
    expect(active.total).toBe(0)
    const archived = (await def.execute({ query: 'pnpm', status: 'archived' }, fakeExec() as never)) as { total: number }
    expect(archived.total).toBe(1)
  })
})

describe('memory_note', () => {
  it('创建条目并带来源', async () => {
    const { tools, store } = setup()
    const def = toolOf(tools, 'memory_note')
    const result = (await def.execute(
      { content: '用户偏好使用简体中文', kind: 'preference', importance: 9, tags: ['语言'] },
      fakeExec() as never,
    )) as { id: string; merged: boolean }
    expect(result.merged).toBe(false)
    const entry = store.getById(result.id)
    expect(entry?.kind).toBe('preference')
    expect(entry?.source.sessionId).toBe('s1')
    expect(entry?.audit.at(-1)).toMatchObject({ by: 'tool' })
  })

  it('重复内容与既有记忆合并', async () => {
    const { tools, store } = setup()
    const existingId = await seed(store)
    const def = toolOf(tools, 'memory_note')
    const result = (await def.execute(
      { content: '项目使用 pnpm workspace 管理多包' },
      fakeExec() as never,
    )) as { merged: boolean; mergedWithId: string | undefined }
    expect(result.merged).toBe(true)
    // R2-6/B6：合并时 mergedWithId 指向既有条目；未合并时该字段缺席（不再伪造空串）
    expect(result.mergedWithId).toBe(existingId)
    expect(store.stats().total).toBe(1)
  })
})

describe('memory_forget', () => {
  it('归档后从检索消失', async () => {
    const { tools, store } = setup()
    const id = await seed(store)
    const def = toolOf(tools, 'memory_forget')
    const result = (await def.execute({ id }, fakeExec() as never)) as { archived: boolean }
    expect(result.archived).toBe(true)
    expect(store.getById(id)?.status).toBe('archived')
  })

  it('不存在的 id 返回 archived=false', async () => {
    const { tools } = setup()
    const def = toolOf(tools, 'memory_forget')
    const result = (await def.execute({ id: 'missing' }, fakeExec() as never)) as { archived: boolean }
    expect(result.archived).toBe(false)
  })
})

describe('toDetail supersede 投影', () => {
  it('带 supersededBy/supersedes 时投射可选字段供审计展示覆盖链', async () => {
    const { store, table } = setup()
    const oldId = await seed(store, { content: '旧事实：A 方案' })
    // 直接对被覆盖条目打上 supersede 后向引用（模拟 store.create 的 supersede 标记）
    const record = store.getById(oldId)
    if (record === undefined) throw new Error('条目缺失')
    const superseded: MemoryEntry = {
      ...record,
      supersededBy: 'new-1234',
      supersedes: 'sup-5678',
    }

    const detail = toDetail(superseded)
    expect(detail.supersededBy).toBe('new-1234')
    expect(detail.supersedes).toBe('sup-5678')
  })

  it('无 supersede 标记时字段不出现', async () => {
    const { store } = setup()
    const id = await seed(store)
    const entry = store.getById(id)
    if (entry === undefined) throw new Error('条目缺失')
    const detail = toDetail(entry)
    expect(detail.supersededBy).toBeUndefined()
    expect(detail.supersedes).toBeUndefined()
  })
})

describe('memory_audit', () => {
  it('返回完整溯源（来源/摘录/审计日志）', async () => {
    const { tools, store } = setup()
    const id = await seed(store)
    await store.archive(id, 'tool')
    const def = toolOf(tools, 'memory_audit')
    const result = (await def.execute({ id }, fakeExec() as never)) as {
      found: boolean
      entry: { source: { sessionId: string; eventSeqs: number[]; excerpt: string }; audit: Array<{ action: string }> }
    }
    expect(result.found).toBe(true)
    expect(result.entry?.source.sessionId).toBe('s-old')
    expect(result.entry?.source.eventSeqs).toEqual([1, 2])
    expect(result.entry?.source.excerpt).toBe('原文摘录内容')
    expect(result.entry?.audit.map((r) => r.action)).toEqual(['create', 'archive'])
  })

  it('不存在的 id 返回 found=false', async () => {
    const { tools } = setup()
    const def = toolOf(tools, 'memory_audit')
    const result = (await def.execute({ id: 'missing' }, fakeExec() as never)) as { found: boolean }
    expect(result.found).toBe(false)
  })
})

describe('memory_status', () => {
  it('返回分类统计', async () => {
    const { tools, store } = setup()
    await seed(store, { kind: 'fact' })
    await seed(store, { kind: 'todo', content: '待办甲' })
    const def = toolOf(tools, 'memory_status')
    const result = (await def.execute({}, fakeExec() as never)) as {
      total: number
      active: number
      byKind: Record<string, number>
    }
    expect(result.total).toBe(2)
    expect(result.active).toBe(2)
    expect(result.byKind.fact).toBe(1)
    expect(result.byKind.todo).toBe(1)
  })

  it('统计输出不含已删除的 deleted 字段（MemoryStats 契约）', async () => {
    const { tools, store } = setup()
    await seed(store)
    const def = toolOf(tools, 'memory_status')
    const result = (await def.execute({}, fakeExec() as never)) as Record<string, unknown>
    expect(result).not.toHaveProperty('deleted')
  })
})

// R2-5/B5：sessionId 解析——agent 缺失即抛错，禁止用 workspace 键伪造（改动前返回 DEFAULT_WORKSPACE，本测试失败）
describe('sessionIdOf（B5 契约）', () => {
  it('agent 存在时返回其 id', () => {
    expect(sessionIdOf({ agent: { id: 's1', session: { id: 's1', header: { cwd: 'D:/workspace' } } } })).toBe('s1')
  })

  it('agent 缺失时抛错暴露契约违例', () => {
    expect(() => sessionIdOf({ agent: undefined })).toThrow('缺少 agent 上下文')
  })
})
