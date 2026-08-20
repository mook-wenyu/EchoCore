/**
 * 客户端面板 API（createMemoryApi）单元测试——纯逻辑，不测组件渲染。
 * - 用假 connection 校验各端点的载荷形状（channel '/memory'、端点名、payload）
 * - 校验 RpcResult 解包：ok:false 时 reject（抛错），ok:true 时返回规范化值
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

import { createMemoryApi, type MemoryPanelApi } from '../src/client.js'

// client.ts 模块顶层 import * as React（仅供组件渲染用）；测试环境 node 无 react 依赖。
// 用例只测 createMemoryApi（纯逻辑，不触 React），故用工厂桩替代，满足模块解析即可。
// 需透传 Component 以支持 PanelErrorBoundary（extends React.Component）的类定义
vi.mock('react', async () => {
  const actual = (await vi.importActual('react')) as Record<string, unknown>
  return { ...actual, createElement: () => null }
})

/** 假 connection：记录每次 rpc.call 的参数，并回放预设结果序列 */
interface FakeConnection {
  rpc: { call: ReturnType<typeof vi.fn> }
}

function fakeCtx(results: Array<RpcResult<unknown>>, calls?: FakeConnection): { ctx: Context; api: MemoryPanelApi; recorded: Array<{ channel: string; endpoint: string; payload: unknown }> } {
  const recorded: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
    recorded.push({ channel, endpoint, payload })
    const result = results.shift()
    if (result === undefined) throw new Error('假 connection 结果序列已耗尽')
    return result
  })
  const connection = { rpc: { call } } as unknown as FakeConnection
  const ctx = {
    get: (name: string) => (name === 'connection' ? connection : undefined),
  } as unknown as Context
  const api = createMemoryApi(ctx)
  return { ctx, api, recorded }
}

/** 快捷构造 ok 结果 */
function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

/** 快捷构造 internal 错误结果 */
function err(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

describe('createMemoryApi 端点载荷', () => {
  it('list：channel /memory、端点 list、payload 透传 status 与 limit', async () => {
    const { api, recorded } = fakeCtx([ok({ entries: [], total: 0 })])
    await api.list('archived', 5)
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'list', payload: { status: 'archived', limit: 5 } }])
  })

  it('search：payload 含 query/kind/status 固定 limit=50', async () => {
    const { api, recorded } = fakeCtx([ok({ entries: [], total: 0 })])
    await api.search('重构', 'todo', 'active')
    expect(recorded).toEqual([
      { channel: '/memory', endpoint: 'search', payload: { query: '重构', kind: 'todo', status: 'active', limit: 50 } },
    ])
  })

  it('search：workspace 透传（O4——面板 workspace 过滤依赖该参数到宿主）', async () => {
    const { api, recorded } = fakeCtx([ok({ entries: [], total: 0 })])
    await api.search('重构', 'todo', 'active', 'D:\\ProjA')
    expect(recorded).toEqual([
      { channel: '/memory', endpoint: 'search', payload: { query: '重构', kind: 'todo', status: 'active', limit: 50, workspace: 'D:\\ProjA' } },
    ])
  })

  it('search：workspace 缺省时不出现在 payload（跨项目全库浏览语义保留）', async () => {
    const { api, recorded } = fakeCtx([ok({ entries: [], total: 0 })])
    await api.search('重构')
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'search', payload: { query: '重构', limit: 50 } }])
  })

  it('get：payload 为 { id }', async () => {
    const { api, recorded } = fakeCtx([ok({ found: true, entry: {} })])
    const result = await api.get('id-1')
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'get', payload: { id: 'id-1' } }])
    expect(result).toEqual({})
  })

  it('get 未命中（found=false）返回 undefined', async () => {
    const { api } = fakeCtx([ok({ found: false })])
    await expect(api.get('missing')).resolves.toBeUndefined()
  })

  it('archive：payload 为 { id }，返回 archived 布尔', async () => {
    const { api, recorded } = fakeCtx([ok({ id: 'id-1', archived: true })])
    const archived = await api.archive('id-1')
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'archive', payload: { id: 'id-1' } }])
    expect(archived).toBe(true)
  })

  it('status：channel /memory、端点 status、空 payload', async () => {
    const { api, recorded } = fakeCtx([ok({ total: 3, active: 2, archived: 1, byKind: { fact: 1 } })])
    const status = await api.status()
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'status', payload: {} }])
    expect(status.total).toBe(3)
    expect(status.active).toBe(2)
  })

  it('getConfig：端点 getConfig、空 payload，返回配置视图', async () => {
    const { api, recorded } = fakeCtx([ok({ config: { embeddingModel: '', embeddingApiKeyResolved: false } })])
    const config = await api.getConfig()
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'getConfig', payload: {} }])
    expect(config.embeddingModel).toBe('')
    expect(config.embeddingApiKeyResolved).toBe(false)
  })

  it('setConfig：端点 setConfig、payload 为变更项 partial，返回更新后配置', async () => {
    const { api, recorded } = fakeCtx([ok({ config: { embeddingModel: 'BAAI/bge-m3', embeddingDimension: 512 } })])
    const config = await api.setConfig({ embeddingModel: 'BAAI/bge-m3', embeddingDimension: 512 })
    expect(recorded).toEqual([
      { channel: '/memory', endpoint: 'setConfig', payload: { embeddingModel: 'BAAI/bge-m3', embeddingDimension: 512 } },
    ])
    expect(config.embeddingModel).toBe('BAAI/bge-m3')
  })
})

describe('createMemoryApi unwrap 错误路径', () => {
  it('ok:false 时 list 抛错（reject，携带错误消息）', async () => {
    const { api } = fakeCtx([err('连接被拒')])
    await expect(api.list()).rejects.toThrow('连接被拒')
  })

  it('ok:false 时 status 抛错', async () => {
    const { api } = fakeCtx([err('存储不可用')])
    await expect(api.status()).rejects.toThrow('存储不可用')
  })

  it('ok:false 时 get 抛错', async () => {
    const { api } = fakeCtx([err('id 非法')])
    await expect(api.get('bad-id')).rejects.toThrow('id 非法')
  })

  it('ok:false 时 setConfig 抛错（载荷校验失败透传）', async () => {
    const { api } = fakeCtx([err('未知配置键：topKk')])
    await expect(api.setConfig({ topKk: 1 })).rejects.toThrow('未知配置键')
  })

  // R2-3/B3：connection 已声明为硬 inject（缺失则插件不加载），运行期必有。
  // 缺失时直接 TypeError（契约违例暴露）——不再返回 internal 伪错误（旧的优雅降级已删除）。
  it('connection 缺失时调用抛 TypeError（契约违例暴露，不静默降级）', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const api = createMemoryApi(ctx)
    await expect(api.status()).rejects.toThrow(TypeError)
  })
})

/**
 * TDD 新增：解耦验证（api 可在 node 单测，不依赖 React）
 * - 直接从 src/client/api.js 导入（绕过 client.ts 的 React 依赖链），验证纯 RPC 层可独立测试
 * - 验证 reflect 端点载荷与错误透传（与面板"运行反思"按钮联动的底层契约）
 */
describe('createMemoryApi 解耦与 reflect 契约（TDD 新增）', () => {
  it('api 可从 client/api 直接导入（无 React 依赖，node 单测）且 reflect 正常透传', async () => {
    // 直接导入 api 层（不经过 client.ts 的 React/Panel 链）
    const { createMemoryApi: createApiDirect } = await import('../src/client/api.js')
    const recorded: Array<{ channel: string; endpoint: string; payload: unknown }> = []
    const call = vi.fn(async (channel: string, endpoint: string, payload: unknown) => {
      recorded.push({ channel, endpoint, payload })
      return { ok: true, value: { ran: true, reviewed: 5, decisions: 1, merged: 1, archived: 0, skipped: 0 } } as RpcResult<unknown>
    })
    const ctx = { get: (n: string) => (n === 'connection' ? { rpc: { call } } : undefined) } as unknown as Context
    const api = createApiDirect(ctx)
    const result = await api.reflect()
    expect(recorded).toEqual([{ channel: '/memory', endpoint: 'reflect', payload: {} }])
    expect(result.ran).toBe(true)
    expect(result.reviewed).toBe(5)
  })

  it('reflect 在 ok:false 时抛错（错误透传与 unwrap 一致）', async () => {
    const { api } = fakeCtx([err('反思器未就绪')])
    await expect(api.reflect()).rejects.toThrow('反思器未就绪')
  })
})
