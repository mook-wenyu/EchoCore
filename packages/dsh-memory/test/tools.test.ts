/**
 * 模型工具集单元测试：六个工具的 schema 注册、执行行为与规范输出。
 * 直接调用 defineTool 定义上的 execute（注册表验证由 DSH 侧保证）。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { registerMemoryTools } from '../src/tools.js'
import { MemoryStore } from '../src/store.js'
import type { NewMemoryInput } from '../src/types.js'
import { FakeTable } from './helpers.js'

/** 假 ctx：tools 服务形状（register 捕获定义） */
class FakeCtx {
  readonly definitions = new Map<string, ToolDefinition>()
  readonly tools = {
    register: (def: ToolDefinition): void => {
      this.definitions.set(def.name, def)
    },
  }
}

/** 假执行上下文（workspace 解析用） */
function fakeExec(agentId = 's1', cwd = 'D:/workspace') {
  return {
    agent: { id: agentId, session: { id: agentId, header: { cwd } } },
    signal: new AbortController().signal,
  }
}

/** 组装被测对象：注册全部工具，返回定义表与 store */
function setup() {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  registerMemoryTools(ctx as unknown as Context, { store })
  return { tools: ctx.definitions, store }
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
    )) as { merged: boolean; existingId: string }
    expect(result.merged).toBe(true)
    expect(result.existingId).toBe(existingId)
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
})
