/**
 * 模型工具集单元测试：六个工具的 schema 注册、执行行为与规范输出。
 * 直接调用 defineTool 定义上的 execute（注册表验证由 DSH 侧保证）。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { registerMemoryTools, sessionIdOf, toDetail, toSummary, workspaceOf } from '../src/tools.js'
import { MemoryStore } from '../src/store.js'
import { MemoryStableSnapshot } from '../src/stable-snapshot.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 假执行上下文（workspace 解析用） */
function fakeExec(agentId = 's1', cwd = 'D:/workspace') {
  return {
    agent: { id: agentId, session: { id: agentId, header: { cwd } } },
    signal: new AbortController().signal,
  }
}

/**
 * 快照依赖假对象（G3 去重回路专用）：tools.deps.snapshot 要求 MemoryStableSnapshot
 * 结构（仅消费 snapshotIds(workspace) 同步方法）。测试用最小假对象注入可控的
 * 「快照已含 id 集」——默认空集 = 快照不干涉，既有 recall/search 用例保持
 * "未去重检索"语义；去重用例显式传入目标 id 集（详见快照去重 describe）。
 * 与 injector.ts 共用同一型号：工具只读快照 ids 做显式召回层的去重。
 */
function fakeSnapshot(snapshotIdsOf: (workspace: string) => ReadonlySet<string> = () => new Set()): MemoryStableSnapshot {
  return { snapshotIds: snapshotIdsOf } as unknown as MemoryStableSnapshot
}

/** 组装被测对象：注册全部工具，返回定义表、store 与 table（R3-1：统一 FakeCtx）
 * - store：可注入既有 MemoryStore（去重用例需让工具与播种共享同一存储）；
 * - snapshotOf：通过即可注入快照 id 视图（缺省假快照空集 = 不触发去重）。 */
function setup(opts?: { snapshotOf?: (workspace: string) => ReadonlySet<string>; store?: MemoryStore }) {
  const ctx = new FakeCtx()
  const table = opts?.store !== undefined ? undefined : new FakeTable()
  const store = opts?.store ?? new MemoryStore(table!)
  registerMemoryTools(ctx as unknown as Context, { store, snapshot: fakeSnapshot(opts?.snapshotOf) })
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
      returned: number
    }
    expect(result.returned).toBe(1)
    expect(result.memories[0]?.id).toBe(id)
    expect(result.memories[0]?.sessionId).toBe('s-old')
    expect(result.memories[0]?.eventSeqs).toEqual([1, 2])
  })

  it('无命中返回空数组', async () => {
    const { tools, store } = setup()
    await seed(store)
    const def = toolOf(tools, 'memory_recall')
    const result = (await def.execute({ query: '完全无关词汇xyz' }, fakeExec() as never)) as { returned: number }
    expect(result.returned).toBe(0)
  })

  // G3/R2-6：召回输出投影须含 createdAt（与注入包渲染一致，模型可判记忆新旧——
  // 此前 recall 投影缺 createdAt 而注入渲染带创建日期，F3 一致性断裂）。
  it('召回结果含 createdAt（供模型判断新旧）', async () => {
    const harness = setup()
    const id = await seed(harness.store)
    // 显式钉住创建时间（NewMemoryInput 无 createdAt，经 table 回改以断言投影字段）
    await harness.table.update(id, (entry) => ({ ...entry, createdAt: '2026-08-01T00:00:00.000Z' }))
    const def = toolOf(harness.tools, 'memory_recall')
    const result = await def.execute({ query: 'pnpm', limit: 5 }, fakeExec() as never)
    expect(result.memories[0]?.createdAt).toBe('2026-08-01T00:00:00.000Z')
  })

  // G3：显式查询与快照/注入重复时快照优先——recall 只补快照未含的，防三处重复消化。
  it('快照已含的记忆不出现在 recall 结果（快照优先，工具只补缺失）', async () => {
    const harness = setup()
    const id = await seed(harness.store) // 重要度 8，属"高重要度快照候选"
    await seed(harness.store, {
      content: '项目使用 pnpm 也用于测试运行',
      importance: 5,
      createdAt: '2026-08-01T00:00:00.000Z',
    })
    // 复用同一 store，假快照把首条标记为"已含"→ recall 应去重它，仅剩未入快照的第二条
    const def = toolOf(setup({ store: harness.store, snapshotOf: () => new Set([id]) }).tools, 'memory_recall')
    const r = (await def.execute({ query: '项目', limit: 10 }, fakeExec() as never)) as {
      memories: Array<{ id: string }>
      returned: number
    }
    expect(r.returned).toBe(1)
    expect(r.memories.some((m) => m.id === id)).toBe(false)
  })

  // G3：去重后 returned 反映"返回条数"；快照全去重时 returned=0（快照不重复消化）。
  it('recall 全部命中被快照去重时 returned=0', async () => {
    const harness = setup()
    const id = await seed(harness.store)
    const def = toolOf(setup({ store: harness.store, snapshotOf: () => new Set([id]) }).tools, 'memory_recall')
    const r = (await def.execute({ query: 'pnpm', limit: 5 }, fakeExec() as never)) as { returned: number }
    expect(r.returned).toBe(0)
  })
})

describe('memory_search', () => {
  it('支持分类/标签/状态过滤与关键词', async () => {
    const { tools, store } = setup()
    const todoId = await seed(store, { kind: 'todo', content: '待办：重构评分模块', tags: ['重构'] })
    await seed(store, { kind: 'decision', content: '决定：采用评分检索', tags: ['架构'] })

    const def = toolOf(tools, 'memory_search')
    const byKind = (await def.execute({ kind: 'todo' }, fakeExec() as never)) as { returned: number }
    expect(byKind.returned).toBe(1)

    const byTag = (await def.execute({ tag: '架构' }, fakeExec() as never)) as { returned: number }
    expect(byTag.returned).toBe(1)

    const byQuery = (await def.execute({ query: '重构', limit: 10 }, fakeExec() as never)) as { returned: number }
    expect(byQuery.returned).toBe(1)

    void todoId
  })

  it('归档条目默认不出现，指定 status 可出现', async () => {
    const { tools, store } = setup()
    const id = await seed(store)
    await store.archive(id, 'tool')

    const def = toolOf(tools, 'memory_search')
    const active = (await def.execute({ query: 'pnpm' }, fakeExec() as never)) as { returned: number }
    expect(active.returned).toBe(0)
    const archived = (await def.execute({ query: 'pnpm', status: 'archived' }, fakeExec() as never)) as { returned: number }
    expect(archived.returned).toBe(1)
  })

  // G3：与 recall 同规则——search 结构化浏览同样过滤快照已含条目（快照优先）
  it('快照已含的记忆不出现在 search 结果', async () => {
    const harness = setup()
    const id = await seed(harness.store)
    // 第二条同为 pnpm 主题但不在快照（快照仅含首条）→ 去重后应只返回它
    const keepId = await seed(harness.store, { content: 'pnpm 也用于运行测试与发布', importance: 4 })
    const def = toolOf(setup({ store: harness.store, snapshotOf: () => new Set([id]) }).tools, 'memory_search')
    const r = (await def.execute({ query: 'pnpm', limit: 10 }, fakeExec() as never)) as {
      memories: Array<{ id: string }>
      returned: number
    }
    expect(r.returned).toBe(1)
    expect(r.memories.map((m) => m.id)).toEqual([keepId])
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

// workspaceOf 语义钉住：agent 缺失回退默认工作区（"无项目"是合法业务语义，落入全局池）——
// 与 sessionIdOf 的"缺失即抛"形成对照：workspace 有默认池语义，sessionId 没有
describe('workspaceOf（回退语义）', () => {
  it('agent 存在时取 cwd', () => {
    expect(workspaceOf({ agent: { session: { header: { cwd: 'D:/workspace' } } } })).toBe('D:/workspace')
  })

  it('agent 缺失时回退默认工作区（全局池语义）', () => {
    expect(workspaceOf({ agent: undefined })).toBe('default')
  })
})

// 压测回归（2026-08-15）：memory_audit 对真实条目报
// "value.entry.sessionId 未声明"——output.schema 的 additionalProperties:false
// 与返回形状（toSummary/toDetail 含 sessionId/createdAt/updatedAt）不一致，
// 导致工具对任何存在的记忆 100% 校验失败。本组测试钉住：
// 输出 schema 声明的字段必须覆盖实际返回形状的全部字段。
describe('工具输出 schema 覆盖返回形状（防 additionalProperties 拒绝回归）', () => {
  /** 构造一个最小合法条目（含全部必填字段） */
  function fullEntry(): MemoryEntry {
    return {
      id: 'm-1',
      workspace: 'D:/workspace',
      sessionId: 's-1',
      kind: 'decision',
      content: '测试决策内容',
      importance: 5,
      tags: ['测试'],
      source: { sessionId: 's-1', eventSeqs: [1], excerpt: '摘录' },
      status: 'active',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
      lastAccessAt: '2026-08-15T00:00:00.000Z',
      accessCount: 0,
      audit: [{ action: 'create', at: '2026-08-15T00:00:00.000Z', by: 'extractor' }],
      dedupKey: 'k',
    }
  }

  /** 取工具 output.schema 中 items/entry 的 properties 声明 */
  function declaredProps(def: ToolDefinition, path: 'items' | 'entry'): string[] {
    const schema = def.output.schema as {
      properties: { memories?: { items: { properties: Record<string, unknown> } }; entry?: { properties: Record<string, unknown> } }
    }
    const props =
      path === 'items' ? schema.properties.memories?.items.properties : schema.properties.entry?.properties
    if (props === undefined) throw new Error(`schema 缺 ${path} 声明`)
    return Object.keys(props)
  }

  it('memory_search：items schema 覆盖 toSummary 返回的全部字段', () => {
    const { tools } = setup()
    const def = toolOf(tools, 'memory_search')
    const declared = declaredProps(def, 'items')
    for (const field of Object.keys(toSummary(fullEntry()))) {
      expect(declared, `memory_search schema 漏字段 ${field}`).toContain(field)
    }
  })

  it('memory_audit：entry schema 覆盖 toDetail 返回的全部字段', () => {
    const { tools } = setup()
    const def = toolOf(tools, 'memory_audit')
    const declared = declaredProps(def, 'entry')
    for (const field of Object.keys(toDetail(fullEntry()))) {
      expect(declared, `memory_audit schema 漏字段 ${field}`).toContain(field)
    }
  })
})
