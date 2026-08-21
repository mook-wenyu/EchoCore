/**
 * 模型工具集单元测试：六个工具的 schema 注册、执行行为与规范输出。
 * 直接调用 defineTool 定义上的 execute（注册表验证由 DSH 侧保证）。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { MemoryCausalStore } from '../src/causal.js'
import { registerMemoryTools, sessionIdOf, toDetail, toSummary, workspaceOf, type RuntimeHealth } from '../src/tools.js'
import { MemoryStore } from '../src/store.js'
import { MemoryStableSnapshot } from '../src/stable-snapshot.js'
import type { MemoryCausalEdge, MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 假执行上下文（workspace/路由解析用；agent 带空 options——真实 Agent 必有该字段） */
function fakeExec(agentId = 's1', cwd = 'D:/workspace') {
  return {
    agent: { id: agentId, session: { id: agentId, header: { cwd } }, options: {} },
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
 * - snapshotOf：通过即可注入快照 id 视图（缺省假快照空集 = 不触发去重）；
 * - runtime：O1 运行健康指标（缺省不传 = 占位路径）；
 * - causal：因果边表（memory_audit 因果视图用例）；
 * - reflector：反思器（memory_reflect 用例）。 */
function setup(opts?: {
  snapshotOf?: (workspace: string) => ReadonlySet<string>
  store?: MemoryStore
  runtime?: RuntimeHealth
  causal?: MemoryCausalStore
  reflector?: { runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }): Promise<import('../src/reflect.js').ReflectionSummary | undefined> }
  causalExtractor?: { runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }): Promise<import('../src/causal.js').CausalSummary | undefined> }
}) {
  const ctx = new FakeCtx()
  const table = opts?.store !== undefined ? undefined : new FakeTable()
  const store = opts?.store ?? new MemoryStore(table!)
  registerMemoryTools(ctx as unknown as Context, {
    store,
    snapshot: fakeSnapshot(opts?.snapshotOf),
    runtime: opts?.runtime,
    causal: opts?.causal,
    reflector: opts?.reflector,
    causalExtractor: opts?.causalExtractor,
  })
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
  it('八个工具全部注册（含 memory_reflect / memory_causal）', () => {
    const { tools } = setup()
    for (const name of ['memory_recall', 'memory_search', 'memory_note', 'memory_forget', 'memory_audit', 'memory_status', 'memory_reflect', 'memory_causal']) {
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
    // Q5 修复：非合并时返回对象**不含** mergedWithId 键（宿主 dsh-tools 对工具 output
    // 做 lossless-JSON 校验，undefined 属性值会整体拒绝 → 记忆已入库但工具误报失败）
    expect('mergedWithId' in result).toBe(false)
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

  it('W2：带 selfRelevance 时 detail 投影该键；缺省时省略键（lossless-JSON 契约）', async () => {
    const { store } = setup()
    const id = await seed(store)
    const entry = store.getById(id)
    if (entry === undefined) throw new Error('条目缺失')
    const withSelf: MemoryEntry = { ...entry, selfRelevance: 8 }
    expect(toDetail(withSelf).selfRelevance).toBe(8)
    // 缺省：键不出现（非 undefined 值——与 Q5 lossless 修复同纪律：可选字段省略键）
    expect(toDetail(entry)).not.toHaveProperty('selfRelevance')
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

  it('O1 运行健康：runtime 注入时覆盖 writeFailures/embeddingState/lastMaintenanceAt；未注入时占位', async () => {
    const { tools, store } = setup()
    await seed(store)
    const def = toolOf(tools, 'memory_status')
    // 未注入 runtime：占位（0/unknown/null）
    const plain = (await def.execute({}, fakeExec() as never)) as {
      writeFailures: number
      embeddingState: string
      lastMaintenanceAt: string | null
    }
    expect(plain.writeFailures).toBe(0)
    expect(plain.embeddingState).toBe('unknown')
    expect(plain.lastMaintenanceAt).toBeNull()
    // 注入 runtime：装配层值覆盖
    const rt = { writeFailures: 3, embeddingState: 'ready', lastMaintenanceAt: '2026-08-16T00:00:00.000Z' }
    const withRuntime = await toolOf(setup({ runtime: rt }).tools, 'memory_status').execute({}, fakeExec() as never)
    expect(withRuntime.writeFailures).toBe(3)
    expect(withRuntime.embeddingState).toBe('ready')
    expect(withRuntime.lastMaintenanceAt).toBe('2026-08-16T00:00:00.000Z')
  })

  it('R2：P2 写端门拒绝计数进 memory_status（rejectedCount 直读 store）', async () => {
    const { tools, store } = setup()
    // 触发写端门：extractor 通道 importance=0（零价值被拒）
    await store.create({
      workspace: 'D:/workspace',
      sessionId: 's1',
      by: 'extractor',
      kind: 'fact',
      content: '正常内容足够长',
      importance: 0,
      source: { sessionId: 's1', eventSeqs: [1], excerpt: '原文' },
    })
    const result = (await toolOf(tools, 'memory_status').execute({}, fakeExec() as never)) as { rejectedCount: number }
    expect(result.rejectedCount).toBe(1)
    // 再次拒绝（纯噪声单字）→ 计数递增（单调不归零）
    await store.create({
      workspace: 'D:/workspace',
      sessionId: 's1',
      by: 'extractor',
      kind: 'fact',
      content: '甲',
      importance: 1,
      source: { sessionId: 's1', eventSeqs: [2], excerpt: '原文' },
    })
    const again = (await toolOf(tools, 'memory_status').execute({}, fakeExec() as never)) as { rejectedCount: number }
    expect(again.rejectedCount).toBe(2)
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

// ── memory_reflect：手动反思触发（拍板：维护周期自动 + 手动工具/RPC 共享同一 runOnce） ──
describe('memory_reflect', () => {
  it('未接线反思器时诚实返回 ran:false（不抛错）', async () => {
    const { tools } = setup()
    const result = (await toolOf(tools, 'memory_reflect').execute({}, fakeExec() as never)) as { ran: boolean }
    expect(result.ran).toBe(false)
  })

  it('接线后 force 触发：把当前会话路由传给反思器，返回执行观察量', async () => {
    const calls: Array<{ route: { provider: string; model: string } | undefined; opts?: { force?: boolean } }> = []
    const reflector = {
      async runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }) {
        calls.push({ route, opts })
        return { reviewed: 3, decisions: 2, merged: 1, archived: 1, skipped: 1 }
      },
    }
    const { tools } = setup({ reflector })
    // 带 request/header 的会话 → resolveRoute 可得 provider/model
    const exec = fakeExec('s1', 'D:/workspace') as {
      agent: { id: string; session: { id: string; header: { cwd: string }; events: unknown[] } }
    }
    exec.agent.session.events = [
      { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'm' } } } },
    ] as never
    const result = (await toolOf(tools, 'memory_reflect').execute({}, exec as never)) as {
      ran: boolean
      merged: number
      archived: number
    }
    expect(result.ran).toBe(true)
    expect(result.merged).toBe(1)
    expect(result.archived).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.route).toEqual({ provider: 'deepseek', model: 'm' })
    expect(calls[0]?.opts?.force).toBe(true)
  })

  it('反思器返回 undefined（无路由缓存）时诚实返回 ran:false', async () => {
    const reflector = { async runOnce() { return undefined } }
    const { tools } = setup({ reflector })
    // 会话无 request/header → resolveRoute 返回 undefined → 反思器无缓存路由 → ran:false
    const exec = fakeExec() as { agent: { id: string; session: { id: string; header: { cwd: string }; events: unknown[] } } }
    exec.agent.session.events = []
    const result = (await toolOf(tools, 'memory_reflect').execute({}, exec as never)) as { ran: boolean }
    expect(result.ran).toBe(false)
  })
})

// ── memory_causal：手动因果抽取触发（C35，2026-08-18 拍板：维护批自动 + 手动工具共享同一 runOnce） ──
describe('memory_causal', () => {
  it('未接线抽取器时诚实返回 ran:false（不抛错）', async () => {
    const { tools } = setup()
    const result = (await toolOf(tools, 'memory_causal').execute({}, fakeExec() as never)) as { ran: boolean }
    expect(result.ran).toBe(false)
  })

  it('接线后 force 触发：把当前会话路由传给抽取器，返回执行观察量', async () => {
    const calls: Array<{ route: { provider: string; model: string } | undefined; opts?: { force?: boolean } }> = []
    const causalExtractor = {
      async runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }) {
        calls.push({ route, opts })
        return { reviewed: 4, edges: 2, created: 2, skipped: 1 }
      },
    }
    const { tools } = setup({ causalExtractor })
    const exec = fakeExec('s1', 'D:/workspace') as {
      agent: { id: string; session: { id: string; header: { cwd: string }; events: unknown[] } }
    }
    exec.agent.session.events = [
      { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek', model: 'm' } } } },
    ] as never
    const result = (await toolOf(tools, 'memory_causal').execute({}, exec as never)) as {
      ran: boolean
      edges: number
      created: number
    }
    expect(result.ran).toBe(true)
    expect(result.edges).toBe(2)
    expect(result.created).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.route).toEqual({ provider: 'deepseek', model: 'm' })
    expect(calls[0]?.opts?.force).toBe(true)
  })

  it('抽取器返回 undefined（无路由缓存）时诚实返回 ran:false', async () => {
    const causalExtractor = { async runOnce() { return undefined } }
    const { tools } = setup({ causalExtractor })
    const exec = fakeExec() as { agent: { id: string; session: { id: string; header: { cwd: string }; events: unknown[] } } }
    exec.agent.session.events = []
    const result = (await toolOf(tools, 'memory_causal').execute({}, exec as never)) as { ran: boolean }
    expect(result.ran).toBe(false)
  })
})

// ── memory_audit 因果视图（保守利用：v1 仅审计展示，不做检索扩散） ──────────────
describe('memory_audit 因果视图', () => {
  /** 构造一个 Map 支撑的 MemoryCausalStore（与 causal.test.ts 同思路，免 sqlite） */
  function makeCausalStore(): MemoryCausalStore {
    const map = new Map<string, MemoryCausalEdge>()
    const table: KvTable<string, MemoryCausalEdge> = {
      get: (key) => map.get(key),
      entries: () => map.entries(),
      keys: () => map.keys(),
      get size() {
        return map.size
      },
      put: async (key, value) => {
        map.set(key, value)
      },
      delete: async (key) => map.delete(key),
      update: async (key, fn) => {
        const current = map.get(key)
        if (current === undefined) throw new Error(`missing: ${key}`)
        const next = fn(current)
        map.set(key, next)
        return next
      },
    }
    return new MemoryCausalStore(table, () => Date.now())
  }

  it('未接线因果边表时不返回 causal 字段', async () => {
    const { tools, store } = setup()
    const id = await seed(store)
    const result = (await toolOf(tools, 'memory_audit').execute({ id }, fakeExec() as never)) as { found: boolean; causal?: unknown }
    expect(result.found).toBe(true)
    expect(result.causal).toBeUndefined()
  })

  it('接线后返回因果装订：causedBy=入边源、causeOf=出边目标', async () => {
    const causal = makeCausalStore()
    const { tools, store } = setup({ causal })
    const a = await seed(store, { content: 'A 是根因' })
    const b = await seed(store, { content: 'B 由 A 导致' })
    // 方向语义：A 是 B 的因/前提
    const entryA = store.getById(a)
    const entryB = store.getById(b)
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    await causal.upsertEdge({ sourceId: a, targetId: b, relation: 'causal', confidence: 0.9, source: entryA!.source })

    const forB = (await toolOf(tools, 'memory_audit').execute({ id: b }, fakeExec() as never)) as {
      causal?: { causedBy: Array<{ id: string; confidence: number }>; causeOf: Array<{ id: string; confidence: number }> }
    }
    expect(forB.causal?.causedBy).toEqual([{ id: a.slice(0, 8), confidence: 0.9 }])
    expect(forB.causal?.causeOf).toEqual([])

    const forA = (await toolOf(tools, 'memory_audit').execute({ id: a }, fakeExec() as never)) as {
      causal?: { causedBy: Array<{ id: string; confidence: number }>; causeOf: Array<{ id: string; confidence: number }> }
    }
    expect(forA.causal?.causeOf).toEqual([{ id: b.slice(0, 8), confidence: 0.9 }])
    expect(forA.causal?.causedBy).toEqual([])
  })
})

// ── memory_status 自进化/因果观测透出（A′ 建议 5：先可观测，再谈优化） ─────────
describe('memory_status 自进化/因果观测', () => {
  it('runtime 提供反思/因果观察量时透出；缺省为 null', async () => {
    const plain = (await toolOf(setup().tools, 'memory_status').execute({}, fakeExec() as never)) as {
      reflection: unknown
      causal: unknown
      lastReflectionAt: unknown
    }
    expect(plain.reflection).toBeNull()
    expect(plain.causal).toBeNull()
    expect(plain.lastReflectionAt).toBeNull()

    const rt: RuntimeHealth = {
      writeFailures: 1,
      embeddingState: 'ready',
      lastMaintenanceAt: '2026-08-16T00:00:00.000Z',
      reflection: { reviewed: 3, decisions: 2, merged: 1, archived: 1, skipped: 1 },
      lastReflectionAt: '2026-08-17T00:00:00.000Z',
      causal: { reviewed: 4, edges: 2, created: 2, skipped: 0 },
      lastCausalAt: '2026-08-17T01:00:00.000Z',
    }
    const withRt = (await toolOf(setup({ runtime: rt }).tools, 'memory_status').execute({}, fakeExec() as never)) as {
      reflection: { reviewed: number }
      causal: { created: number }
      lastCausalAt: string | null
    }
    expect(withRt.reflection?.reviewed).toBe(3)
    expect(withRt.causal?.created).toBe(2)
    expect(withRt.lastCausalAt).toBe('2026-08-17T01:00:00.000Z')
  })
})

// ── P1 补覆盖：tools.ts:283-689 的 render 分支（TDD，目标 >90%） ───────────
describe('P1 补覆盖：工具 render 分支（283-689）', () => {
  it('各工具 render 分支全覆盖（8 工具的文本渲染，显式分支）', async () => {
    // 中文注释：render 是纯函数，负责模型/UI 呈现；未覆盖会导致面板与日志不可观测
    const { tools } = setup()
    // memory_recall：0 条与 N 条分支
    const recall = toolOf(tools, 'memory_recall')
    const recallRender = recall.output.render as (args: unknown, value: { memories: Array<{ id: string; kind: string; content: string; importance: number; sessionId: string; eventSeqs: number[]; createdAt: string }>; returned: number }) => Array<{ text: string }>
    expect(recallRender({}, { memories: [], returned: 0 })[0]?.text).toContain('未找到')
    expect(recallRender({}, { memories: [{ id: 'a-12345678', kind: 'fact', content: '内容', importance: 5, sessionId: 's1', eventSeqs: [1], createdAt: '2026-08-01T00:00:00.000Z' }], returned: 1 })[0]?.text).toContain('找到 1 条')

    // memory_search
    const search = toolOf(tools, 'memory_search')
    const searchRender = search.output.render as (args: unknown, value: { memories: Array<{ id: string; kind: string; content: string; importance: number; tags: string[]; sessionId: string; status: string; createdAt: string; updatedAt: string }>; returned: number }) => Array<{ text: string }>
    expect(searchRender({}, { memories: [], returned: 0 })[0]?.text).toContain('共 0 条')

    // memory_note：merged true/false
    const note = toolOf(tools, 'memory_note')
    const noteRender = note.output.render as (args: unknown, value: { id: string; merged: boolean; mergedWithId?: string }) => Array<{ text: string }>
    expect(noteRender({}, { id: 'a-12345678', merged: false })[0]?.text).toContain('已记录')
    expect(noteRender({}, { id: 'b-12345678', merged: true, mergedWithId: 'a-12345678' })[0]?.text).toContain('合并')

    // memory_forget：archived true/false
    const forget = toolOf(tools, 'memory_forget')
    const forgetRender = forget.output.render as (args: unknown, value: { id: string; archived: boolean }) => Array<{ text: string }>
    expect(forgetRender({}, { id: 'a-12345678', archived: true })[0]?.text).toContain('已归档')
    expect(forgetRender({}, { id: 'missing', archived: false })[0]?.text).toContain('未找到')

    // memory_audit：未找到 / 找到（含 supersede/因果/摘录截断）
    const audit = toolOf(tools, 'memory_audit')
    const auditRender = audit.output.render as (args: unknown, value: { found: boolean; entry?: { id: string; kind: string; content: string; importance: number; tags: string[]; workspace: string; sessionId: string; createdAt: string; updatedAt: string; source: { sessionId: string; eventSeqs: number[]; excerpt: string }; accessCount: number; status: string; audit: Array<{ action: string; at: string; by: string; detail?: string }>; supersededBy?: string; supersedes?: string }; causal?: { causedBy: Array<{ id: string; confidence: number }>; causeOf: Array<{ id: string; confidence: number }> } }) => Array<{ text: string }>
    expect(auditRender({}, { found: false })[0]?.text).toContain('未找到')
    const longExcerpt = 'x'.repeat(300)
    expect(
      auditRender({}, {
        found: true,
        entry: {
          id: 'a-12345678', kind: 'fact', content: '内容', importance: 5, tags: [], workspace: 'D:/ws', sessionId: 's1',
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
          source: { sessionId: 's1', eventSeqs: [1], excerpt: longExcerpt },
          accessCount: 3, status: 'active',
          supersededBy: 'b-12345678', supersedes: 'c-12345678',
          audit: [{ action: 'create', at: '2026-08-01T00:00:00.000Z', by: 'tool', detail: '原因' }],
        },
        causal: { causedBy: [{ id: 'b1234567', confidence: 0.9 }], causeOf: [{ id: 'c1234567', confidence: 0.8 }] },
      })[0]?.text,
    ).toContain('supersede')
    // 无 supersede/因果的简洁分支
    expect(
      auditRender({}, {
        found: true,
        entry: {
          id: 'a-12345678', kind: 'fact', content: '内容', importance: 5, tags: [], workspace: 'D:/ws', sessionId: 's1',
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
          source: { sessionId: 's1', eventSeqs: [], excerpt: '短摘录' },
          accessCount: 0, status: 'active', audit: [{ action: 'create', at: '2026-08-01T00:00:00.000Z', by: 'tool' }],
        },
      })[0]?.text,
    ).toContain('来源事件序号')

    // memory_status：含后端/降级原因/累计的分支
    const status = toolOf(tools, 'memory_status')
    const statusRender = status.output.render as (args: unknown, value: { total: number; active: number; archived: number; byKind: { fact: number; preference: number; decision: number; todo: number; insight: number }; writeFailures: number; embeddingState: string; embeddingBackend: string | null; embeddingInitError: string | null; embeddingDegradedReason: string | null; lastMaintenanceAt: string | null; rejectedCount: number; reflection: unknown; lastReflectionAt: string | null; reflectionCumulative: unknown; causal: unknown; lastCausalAt: string | null; injectStats?: unknown }) => Array<{ text: string }>
    // 分支：无后端/有后端、有降级原因、有累计
    expect(statusRender({}, { total: 0, active: 0, archived: 0, byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 }, writeFailures: 0, embeddingState: 'ready', embeddingBackend: 'remote', embeddingInitError: '鉴权失败', embeddingDegradedReason: '维度不匹配已降级', lastMaintenanceAt: null, rejectedCount: 0, reflection: { reviewed: 2, decisions: 1, merged: 1, archived: 0, skipped: 0 }, lastReflectionAt: '2026-08-17T00:00:00.000Z', reflectionCumulative: { runs: 2, decisions: 2, merged: 1, archived: 0, skipped: 1 }, causal: { reviewed: 4, edges: 2, created: 2, skipped: 0 }, lastCausalAt: '2026-08-17T01:00:00.000Z' })[0]?.text).toContain('嵌入降级原因')
    expect(statusRender({}, { total: 1, active: 1, archived: 0, byKind: { fact: 1, preference: 0, decision: 0, todo: 0, insight: 0 }, writeFailures: 0, embeddingState: 'disabled', embeddingBackend: null, embeddingInitError: null, embeddingDegradedReason: null, lastMaintenanceAt: '2026-08-16T00:00:00.000Z', rejectedCount: 1, reflection: null, lastReflectionAt: null, reflectionCumulative: null, causal: null, lastCausalAt: null })[0]?.text).toContain('记忆库统计')
    // Q5=A：注入观测计数行（有 injectStats 时渲染；null 时缺席）
    expect(statusRender({}, { total: 1, active: 1, archived: 0, byKind: { fact: 1, preference: 0, decision: 0, todo: 0, insight: 0 }, writeFailures: 0, embeddingState: 'ready', embeddingBackend: null, embeddingInitError: null, embeddingDegradedReason: null, lastMaintenanceAt: null, rejectedCount: 0, reflection: null, lastReflectionAt: null, reflectionCumulative: null, causal: null, lastCausalAt: null, injectStats: { steps: 3, injectedPacks: 2, injectedEntries: 5, dedupSkipped: 1, snapshotSkipped: 0, foldedDuplicates: 1, budgetSkipped: 0, searchMs: 12.5 } })[0]?.text).toContain('注入观测：步 3')

    // memory_reflect：ran true/false
    const reflect = toolOf(tools, 'memory_reflect')
    const reflectRender = reflect.output.render as (args: unknown, value: { ran: boolean; reviewed: number; decisions: number; merged: number; archived: number; skipped: number }) => Array<{ text: string }>
    expect(reflectRender({}, { ran: false, reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 })[0]?.text).toContain('未执行')
    expect(reflectRender({}, { ran: true, reviewed: 2, decisions: 1, merged: 1, archived: 0, skipped: 1 })[0]?.text).toContain('反思完成')

    // memory_causal：ran true/false
    const causal = toolOf(tools, 'memory_causal')
    const causalRender = causal.output.render as (args: unknown, value: { ran: boolean; reviewed: number; edges: number; created: number; skipped: number }) => Array<{ text: string }>
    expect(causalRender({}, { ran: false, reviewed: 0, edges: 0, created: 0, skipped: 0 })[0]?.text).toContain('未执行')
    expect(causalRender({}, { ran: true, reviewed: 4, edges: 2, created: 2, skipped: 1 })[0]?.text).toContain('因果抽取完成')
  })
})

