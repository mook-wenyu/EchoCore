/**
 * @module @echocore/dsh-memory/host-rpc
 *
 * 记忆面板的宿主 RPC 通道（Client ↔ Host 数据面）。
 * 基于 `ctx.connection.rpc` 双面通用通道（区别于动态插件的 harness.handle）：
 * - 宿主：`rpc.handle('/memory', handler, { authority: 'loopback' })`
 * - 客户端：`rpc.call('/memory', '<endpoint>', payload)`
 *
 * 约定（防兜底）：
 * - 业务结果一律以 ok:true 的值形态返回（未找到 → { found: false }）；
 * - 仅真正未预期的异常走 { ok: false, code: 'internal' }（RpcErrorCode 为
 *   应用级封闭联合，internal 是文档化的兜底码）；
 * - 载荷严格校验，形状不符即拒绝，绝不静默修正。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

import type { MemoryStore } from './store.js'
import { toDetail, toSummary } from './tools.js'
import type { MemoryKind } from './types.js'

/** RPC 端点载荷（严格校验用） */
interface ListPayload {
  status?: 'active' | 'archived'
  limit: number
}
interface SearchPayload {
  query?: string
  kind?: MemoryKind
  tag?: string
  status?: 'active' | 'archived'
  limit?: number
}
interface IdPayload {
  id: string
}

/** 端点分发器：独立于 ctx 的纯函数，便于单测 */
export type MemoryRpcHandler = (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>

/** 构造 RPC 分发器 */
export function createMemoryRpcHandler(store: MemoryStore): MemoryRpcHandler {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'list') return ok(await handleList(store, payload))
      if (endpoint === 'search') return ok(await handleSearch(store, payload))
      if (endpoint === 'get') return ok(handleGet(store, payload))
      if (endpoint === 'archive') return ok(await handleArchive(store, payload))
      if (endpoint === 'status') return ok(store.stats())
      return internalError(`未知记忆端点：${endpoint}`)
    } catch (error) {
      return internalError(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * 注册到 ctx.connection.rpc。
 * R2-3（B3）：connection 已声明为硬 inject（index.ts）——Cordis 语义"缺失则不加载"，
 * 运行期必有该服务，删除 optional 守卫（防御性死代码）。
 * ctx.get 返回 unknown，类型强转保留（Cordis 未在 Context 类型声明 connection）。
 */
export function registerMemoryRpc(ctx: Context, store: MemoryStore): void {
  const connection = ctx.get('connection') as {
    rpc: { handle(channel: string, handler: MemoryRpcHandler, options: { authority: string }): () => Promise<void> }
  }
  const dispose = connection.rpc.handle('/memory', createMemoryRpcHandler(store), { authority: 'loopback' })
  ctx.effect(() => () => {
    void dispose()
  })
}

/** list：最近条目浏览（面板首页） */
async function handleList(store: MemoryStore, payload: unknown): Promise<{ entries: unknown[]; total: number }> {
  const parsed = parseListPayload(payload)
  const entries = store.listRecent(parsed.limit, parsed.status)
  return { entries: entries.map(toSummary), total: entries.length }
}

/** search：关键词/分类/标签/状态检索 */
async function handleSearch(store: MemoryStore, payload: unknown): Promise<{ entries: unknown[]; total: number }> {
  const parsed = parseSearchPayload(payload)
  const entries = store.search({
    query: parsed.query ?? '',
    kind: parsed.kind,
    tag: parsed.tag,
    status: parsed.status,
    limit: parsed.limit,
  })
  return { entries: entries.map(toSummary), total: entries.length }
}

/** get：单条详情（含来源与审计） */
function handleGet(store: MemoryStore, payload: unknown): { found: boolean; entry?: unknown } {
  const { id } = parseIdPayload(payload)
  const entry = store.getById(id)
  return entry === undefined ? { found: false } : { found: true, entry: toDetail(entry) }
}

/** archive：归档（软删除） */
async function handleArchive(store: MemoryStore, payload: unknown): Promise<{ id: string; archived: boolean }> {
  const { id } = parseIdPayload(payload)
  const archived = await store.archive(id, 'user')
  return { id, archived }
}

// ── 载荷校验（严格：形状不符抛错 → internal） ─────────────────────────

function parseListPayload(payload: unknown): ListPayload {
  const record = requireRecord(payload)
  return {
    status: optionalEnum(record.status, ['active', 'archived']),
    limit: optionalInt(record.limit, 200),
  }
}

function parseSearchPayload(payload: unknown): SearchPayload {
  const record = requireRecord(payload)
  return {
    query: optionalString(record.query),
    kind: optionalEnum(record.kind, ['fact', 'preference', 'decision', 'todo', 'insight']) as MemoryKind | undefined,
    tag: optionalString(record.tag),
    status: optionalEnum(record.status, ['active', 'archived']),
    limit: optionalInt(record.limit, 50),
  }
}

function parseIdPayload(payload: unknown): IdPayload {
  const record = requireRecord(payload)
  const id = record.id
  if (typeof id !== 'string' || id.trim() === '') throw new Error('id 必须为非空字符串')
  return { id }
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('载荷必须是对象')
  }
  return payload as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('字段类型必须是字符串')
  return value
}

function optionalInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error('limit 必须是正整数')
  return value
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`字段必须是以下值之一：${allowed.join('/')}`)
  }
  return value as T
}

// ── RpcResult 构造 ─────────────────────────────────────────────────────

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function internalError(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}
