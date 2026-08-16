/**
 * 宿主 RPC 通道单元测试：端点分发、载荷校验、业务结果形态。
 */

import { describe, expect, it } from 'vitest'

import { createMemoryRpcHandler } from '../src/host-rpc.js'
import { MemoryStore } from '../src/store.js'
import type { NewMemoryInput } from '../src/types.js'
import { DEFAULTS, type ResolvedConfig } from '../src/config.js'
import { FakeTable } from './helpers.js'

/** 组装被测对象 */
function setup() {
  const table = new FakeTable()
  const store = new MemoryStore(table)
  // 假配置上下文：记录持久化/生效调用与顺序；config 可变（模拟 settings 变更后视图刷新）
  const rpcConfig: Record<string, unknown> = { ...DEFAULTS }
  const calls: string[] = []
  const settingsUpdates: Array<Record<string, unknown>> = []
  const applied: Array<Record<string, unknown>> = []
  const rpc = {
    config: () => rpcConfig as unknown as ResolvedConfig,
    settings: {
      async update(patch: Record<string, unknown>): Promise<void> {
        calls.push('settings.update')
        settingsUpdates.push(patch)
        Object.assign(rpcConfig, patch)
      },
    },
    async applyChange(next: Record<string, unknown>): Promise<void> {
      calls.push('applyChange')
      applied.push(next)
      Object.assign(rpcConfig, next)
    },
  }
  const handler = createMemoryRpcHandler(store, rpc)
  return { store, handler, table, rpc, rpcConfig, calls, settingsUpdates, applied }
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
    expect(active.ok).toBe(true)
    if (!active.ok) return
    expect((active.value as { total: number }).total).toBe(1)
  })

  it('search：关键词/分类过滤', async () => {
    const { store, handler } = setup()
    await seed(store)
    await seed(store, { kind: 'todo', content: '待办：重构评分模块' })

    const byKind = await handler('search', { kind: 'todo' })
    expect(byKind.ok).toBe(true)
    if (!byKind.ok) return
    expect((byKind.value as { total: number }).total).toBe(1)

    const byQuery = await handler('search', { query: 'pnpm' })
    expect(byQuery.ok).toBe(true)
    if (!byQuery.ok) return
    expect((byQuery.value as { total: number }).total).toBe(1)
  })

  it('R3 search：workspace 过滤（传则限定该工作区；不传保持全库）', async () => {
    const { store, handler } = setup()
    await seed(store)
    await seed(store, { workspace: 'D:/other', content: '另一个项目的技术栈：rust 异步' })
    // 带 workspace：只返回该工作区命中
    const scoped = await handler('search', { query: 'rust', workspace: 'D:/other' })
    expect(scoped.ok).toBe(true)
    if (!scoped.ok) return
    expect((scoped.value as { total: number }).total).toBe(1)
    // 不带 workspace：全库命中（面板管理语义保留）
    const global = await handler('search', { query: 'rust' })
    expect(global.ok).toBe(true)
    if (!global.ok) return
    expect((global.value as { total: number }).total).toBe(1)
    // 工作区隔离验证：另一工作区查不到本区内容
    const miss = await handler('search', { query: 'pnpm', workspace: 'D:/other' })
    expect(miss.ok).toBe(true)
    if (!miss.ok) return
    expect((miss.value as { total: number }).total).toBe(0)
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
    expect(miss.ok).toBe(true)
    if (!miss.ok) return
    expect((miss.value as { found: boolean }).found).toBe(false)
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
    if (!result.ok) return
    expect((result.value as { total: number }).total).toBe(1)
  })

  it('status：透出嵌入后端标签与远程验证失败原因（2026-08-17 状态可见化——杜绝"ready 但远程未生效"静默）', async () => {
    const { store, handler } = setup()
    // runtime 注入：当前后端 local 顶班 + 远程验证失败原因（本根因场景）
    const withRuntime = createMemoryRpcHandler(store, {
      config: () => ({ ...DEFAULTS }) as ResolvedConfig,
      settings: { update: async () => {} },
      applyChange: async () => {},
    }, {
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      embeddingBackend: 'local',
      embeddingInitError: '远程嵌入返回维度 1024 ≠ 配置维度 2048（请核对 embeddingDimension 并删除旧嵌入索引重建）',
    })
    const result = await withRuntime('status', null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { embeddingBackend?: string; embeddingInitError?: string }
    expect(value.embeddingBackend).toBe('local')
    expect(value.embeddingInitError).toContain('维度')
  })

  it('status：无 runtime（测试直连）时不带可见化字段（可选访问，不影响旧宿主）', async () => {
    const { store, handler } = setup()
    const result = await handler('status', null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { embeddingBackend?: string; embeddingInitError?: string }
    expect(value.embeddingBackend).toBeUndefined()
    expect(value.embeddingInitError).toBeUndefined()
  })
})

describe('memory RPC 载荷校验', () => {
  it('未知端点返回 internal 错误', async () => {
    const { handler } = setup()
    const result = await handler('explode', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('internal')
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

  it('存储真实异常经 wrapper 转 internal 并透传消息（P1-2 错误传播语义）', async () => {
    const { store, handler, table } = setup()
    const id = await seed(store)
    // 注入一次底层写入失败（模拟磁盘 IO 错误），archive 应返回 internal 而非上抛
    table.failNextWrite(new Error('磁盘写入失败'))
    const result = await handler('archive', { id })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('internal')
    expect(result.error.message).toContain('磁盘写入失败')
  })
})

describe('memory RPC 配置端点（面板配置）', () => {
  it('getConfig：返回当前生效配置字段与 apiKey 解析状态', async () => {
    const { handler } = setup()
    const result = await handler('getConfig', null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { config: Record<string, unknown> }
    expect(value.config.embeddingApiBaseUrl).toBe('')
    expect(value.config.embeddingApiKey).toBe('')
    expect(value.config.embeddingModel).toBe('')
    expect(value.config.embeddingDimension).toBe(DEFAULTS.embeddingDimension)
    // 配置面最小化防回归：行为参数/开关/本地目录均已删除
    expect('embeddingEnabled' in value.config).toBe(false)
    expect('topK' in value.config).toBe(false)
    expect('embeddingModelDir' in value.config).toBe(false)
  })

  it('getConfig：随 config() 动态读取（settings 变更后视图即时刷新）', async () => {
    const { handler, rpcConfig } = setup()
    rpcConfig.embeddingModel = 'BAAI/bge-m3'
    const result = await handler('getConfig', null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as { config: { embeddingModel: string } }).config.embeddingModel).toBe('BAAI/bge-m3')
  })

  it('setConfig：合法载荷先持久化到 settings（partial）再内存重启生效（合并后完整配置）', async () => {
    const { handler, calls, settingsUpdates, applied } = setup()
    const result = await handler('setConfig', { embeddingModel: 'BAAI/bge-m3', embeddingDimension: 512 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 顺序契约：持久化先于生效（settings.yaml 落盘后插件才重启）
    expect(calls).toEqual(['settings.update', 'applyChange'])
    // 持久化通道收到白名单校验后的变更项
    expect(settingsUpdates[0]).toEqual({ embeddingModel: 'BAAI/bge-m3', embeddingDimension: 512 })
    // 生效收到合并后完整配置（未传字段保留当前值）
    expect(applied[0]?.embeddingModel).toBe('BAAI/bge-m3')
    expect(applied[0]?.embeddingDimension).toBe(512)
    expect(applied[0]?.embeddingApiBaseUrl).toBe(DEFAULTS.embeddingApiBaseUrl)
    // 响应返回更新后配置
    const value = result.value as { config: Record<string, unknown> }
    expect(value.config.embeddingModel).toBe('BAAI/bge-m3')
  })

  it('setConfig：持久化失败整体拒绝且不重启（不静默"保存成功"）', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table)
    const calls: string[] = []
    const rpc = {
      config: () => ({ ...DEFAULTS }),
      settings: {
        async update(): Promise<void> {
          calls.push('settings.update')
          throw new Error('settings.yaml 写入失败')
        },
      },
      async applyChange(): Promise<void> {
        calls.push('applyChange')
      },
    }
    const handler = createMemoryRpcHandler(store, rpc)
    const result = await handler('setConfig', { embeddingModel: 'm' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('写入失败')
    expect(calls).toEqual(['settings.update'])
  })

  it('setConfig：未知键拒绝（internal）', async () => {
    const { handler, calls } = setup()
    const result = await handler('setConfig', { 不存在的键: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('未知配置键')
    expect(calls).toHaveLength(0)
  })

  it('setConfig：已删除的旧配置键拒绝（配置面最小化后不再是合法键）', async () => {
    const { handler, calls } = setup()
    const result = await handler('setConfig', { topK: 12 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('未知配置键')
    expect(calls).toHaveLength(0)
  })

  it('setConfig：类型错误拒绝（internal）', async () => {
    const { handler, calls } = setup()
    const result = await handler('setConfig', { embeddingDimension: '不是数字' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(calls).toHaveLength(0)
  })

  it('setConfig：数值越界拒绝（embeddingDimension 0）', async () => {
    const { handler, calls } = setup()
    const result = await handler('setConfig', { embeddingDimension: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(calls).toHaveLength(0)
  })

  it('setConfig：空载荷拒绝', async () => {
    const { handler, calls } = setup()
    const result = await handler('setConfig', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(calls).toHaveLength(0)
  })
})
