/**
 * @module @echocore/dsh-memory/client/api
 *
 * 面板数据 API 层（纯 RPC，无 React 依赖，node 可单测）。
 * 职责：通过 ctx.connection.rpc.call('/memory', endpoint, payload) 与宿主通信，
 * 统一 unwrap RpcResult 并暴露类型化的 MemoryPanelApi。
 * 解耦说明：本模块不导入 React、slots、样式，仅依赖 Context 与 RpcResult，
 * 可在 node 环境以 fake connection 直接单测，不触 DOM。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

// ── 视图类型（与宿主 toSummary/toDetail 对齐） ──────────────────────────

/** 记忆条目展示形态（与宿主 toSummary 对齐） */
export interface MemorySummaryView {
  id: string
  kind: string
  content: string
  importance: number
  tags: string[]
  sessionId: string
  status: string
  createdAt: string
}

/** 详情展示形态（与宿主 toDetail 对齐） */
export interface MemoryDetailView extends MemorySummaryView {
  workspace: string
  source: { sessionId: string; eventSeqs: number[]; excerpt: string }
  accessCount: number
  audit: Array<{ action: string; at: string; by: string; detail?: string }>
  supersededBy?: string
  supersedes?: string
}

/** 统计展示形态（与宿主 MemoryStats 对齐，无 deleted 字段） */
export interface MemoryStatsView {
  total: number
  active: number
  archived: number
  byKind: Record<string, number>
  /**
   * O1 观测闭环扩展（可选项）：宿主 status 端点尚未下发这些字段时缺失，
   * 面板以可选访问展示——缺则整行不渲染（防旧宿主/防未来字段名漂移）。
   */
  writeFailures?: number
  embeddingState?: string
  /** 当前嵌入后端标签（'remote' | 'local'；状态可见化——区分 ready(remote) 与 ready(local) 顶班） */
  embeddingBackend?: string
  /** 最近一次远程验证失败原因（远程未生效时展示，杜绝静默回退） */
  embeddingInitError?: string
  lastMaintenanceAt?: string | null
  /** 降级原因（Q1/A：远程维度≠本地时显式 disabled 原因） */
  embeddingDegradedReason?: string
  /** E：反思/因果观测（宿主 status 已下发；缺则不渲染——跨版本兼容；宿主对未运行发 null） */
  reflection?: { reviewed: number; decisions: number; merged: number; archived: number; skipped: number } | null
  reflectionCumulative?: { runs: number; decisions: number; merged: number; archived: number; skipped: number } | null
  lastReflectionAt?: string | null
  causal?: { reviewed: number; edges: number; created: number; skipped: number } | null
  lastCausalAt?: string | null
}

/**
 * 配置视图（与宿主 configView 对齐）：当前生效配置字段 +
 * embeddingApiKeyResolved（apiKey 解析状态——字面 key 或 env:NAME 环境变量
 * 引用是否可用；面板展示用，不泄露解析后的 key 值）。
 * 配置面最小化（用户拍板）：仅远程嵌入 4 项，其余行为参数已固化为代码常量。
 */
export interface MemoryPanelConfigView {
  embeddingApiBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimension: number
  embeddingApiKeyResolved: boolean
}

/** 反思执行结果视图（与宿主 handleReflect 对齐） */
export interface ReflectResultView {
  ran: boolean
  reviewed: number
  decisions: number
  merged: number
  archived: number
  skipped: number
}

/** 面板数据 API（apply 期从 ctx 装配，随组件 props 传递） */
export interface MemoryPanelApi {
  list(status?: string, limit?: number): Promise<MemorySummaryView[]>
  /** R3：workspace 可选——传则限定该工作区搜索；面板默认不传（跨项目管理浏览） */
  search(query: string, kind?: string, status?: string, workspace?: string): Promise<MemorySummaryView[]>
  get(id: string): Promise<MemoryDetailView | undefined>
  archive(id: string): Promise<boolean>
  status(): Promise<MemoryStatsView>
  /** E：手动触发一轮 LLM 反思（RPC reflect 端点；force 即时执行，审计可回滚） */
  reflect(): Promise<ReflectResultView>
  /** 读取当前生效配置（含 apiKey 解析状态） */
  getConfig(): Promise<MemoryPanelConfigView>
  /** 更新配置（仅变更项；宿主校验并持久化到 settings.yaml，插件内存重启生效） */
  setConfig(partial: Record<string, unknown>): Promise<MemoryPanelConfigView>
}

/** 从 ctx 装配面板 API（R2-3/B3：connection 为硬 inject，缺失则插件不加载，运行期必有） */
export function createMemoryApi(ctx: Context): MemoryPanelApi {
  // ctx.get 返回 unknown（Cordis 未在 Context 类型声明 connection 服务），
  // 类型强转保留；optional 守卫删除——守卫是防御性死代码（inject 语义保证存在）
  const connection = ctx.get('connection') as {
    rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> }
  }
  const call = (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> =>
    connection.rpc.call('/memory', endpoint, payload)
  const unwrap = (result: RpcResult<unknown>): unknown => {
    if (result.ok) return result.value
    throw new Error(result.error.message)
  }
  return {
    async list(status, limit) {
      const result = await call('list', { status, limit })
      const value = unwrap(result) as { entries: MemorySummaryView[] }
      return value.entries
    },
    async search(query, kind, status, workspace) {
      const result = await call('search', { query, kind, status, limit: 50, workspace })
      const value = unwrap(result) as { entries: MemorySummaryView[] }
      return value.entries
    },
    async get(id) {
      const result = await call('get', { id })
      const value = unwrap(result) as { found: boolean; entry?: MemoryDetailView }
      return value.found ? value.entry : undefined
    },
    async archive(id) {
      const result = await call('archive', { id })
      const value = unwrap(result) as { archived: boolean }
      return value.archived
    },
    async reflect() {
      const result = await call('reflect', {})
      return unwrap(result) as ReflectResultView
    },
    async status() {
      const result = await call('status', {})
      return unwrap(result) as MemoryStatsView
    },
    async getConfig() {
      const result = await call('getConfig', {})
      const value = unwrap(result) as { config: MemoryPanelConfigView }
      return value.config
    },
    async setConfig(partial) {
      const result = await call('setConfig', partial)
      const value = unwrap(result) as { config: MemoryPanelConfigView }
      return value.config
    },
  }
}
