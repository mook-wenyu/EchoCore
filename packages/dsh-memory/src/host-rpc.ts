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
import { toDetail, toSummary, type RuntimeHealth } from './tools.js'
import type { ReflectionSummary } from './reflect.js'
import type { MemoryKind } from './types.js'
import { Config, DEFAULTS, type ResolvedConfig } from './config.js'
import { resolveApiKey } from './embedding.js'

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
  /** R3（2026-08-15）：可选 workspace 过滤——传则检索限定该工作区（面板未来按项目搜索）；
   * 不传保持全库浏览（面板是跨项目管理工具，语义保留） */
  workspace?: string
}
interface IdPayload {
  id: string
}

/** 端点分发器：独立于 ctx 的纯函数，便于单测 */
export type MemoryRpcHandler = (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>

/**
 * 配置端点运行时依赖（面板配置读写的最小面）：
 * - config：当前生效配置读取（getConfig 展示 / setConfig 合并基底；随 settings
 *   变更实时更新）；
 * - settings：持久化通道——setConfig 落盘 settings.yaml（DSH 官方用户设置 seam，
 *   重启不丢。不写 loader 配置树：其写回目标 cordis.yml 每次启动被
 *   prepareProfile 重置，2026-08-16 实测"保存成功但重启丢失"根因）；
 * - applyChange：应用新配置并等待生效（装配层实现：幂等内存重启 noSave=true）；
 * - defaultModel：DSH 宿主 agent-default-model 回退源（memory LLM 配置为空时
 *   经此获取宿主默认模型——面板 reflect 端点无会话路由时的权威回退）。
 */
export interface MemoryRpcContext {
  /** 当前生效配置读取（getConfig 展示 / setConfig 合并基底） */
  config: () => ResolvedConfig
  /** settings 持久化通道（未接线时 update 拒绝——不静默降级） */
  settings: { update(patch: Record<string, unknown>): Promise<void> }
  /** 应用新配置并等待生效（幂等内存重启） */
  applyChange(next: ResolvedConfig): Promise<void>
  /** DSH 宿主 agent-default-model 当前选择（provider + model）；宿主未挂载时返回 undefined */
  defaultModel: () => { provider: string; model: string } | undefined
}

/** 反思触发形状（面板 RPC 手动触发；route 缺省回退反思器缓存——面板无会话） */
export interface ReflectTrigger {
  runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }): Promise<ReflectionSummary | undefined>
  /** 最近一次批次失败原因（Q-fix 2026-08-22：undefined 时区分"无路由"与"执行失败"——失败可观测；getter 属性形态） */
  lastError?: string | undefined
}

/** 构造 RPC 分发器（O1：runtime 健康指标可选注入——status 端点覆盖 store 占位；reflector 可选——reflect 端点） */
export function createMemoryRpcHandler(
  store: MemoryStore,
  rpc: MemoryRpcContext,
  runtime?: RuntimeHealth,
  reflector?: ReflectTrigger,
  logger?: { warn: (message: string) => void },
): MemoryRpcHandler {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'list') return ok(await handleList(store, payload))
      if (endpoint === 'search') return ok(await handleSearch(store, payload))
      if (endpoint === 'get') return ok(handleGet(store, payload))
      if (endpoint === 'archive') return ok(await handleArchive(store, payload))
      if (endpoint === 'reflect') {
        const config = rpc.config()
        const llm = config.llm
        // memory 配置的 llm.provider/model 优先；为空时回退 DSH 宿主 agent-default-model
        // 防御：config.llm 运行时可能为 undefined（旧配置格式/schema 未填充），
        // 可选链 + 空串兜底确保 route 不因 undefined 属性抛异常
        const provider = llm?.provider ?? ''
        const model = llm?.model ?? ''
        const route = provider !== '' && model !== ''
          ? { provider, model }
          : rpc.defaultModel()
        return ok(await handleReflect(reflector, route))
      }
      if (endpoint === 'status') {
        const stats = store.stats()
        return ok({
          ...stats,
          writeFailures: runtime?.writeFailures ?? stats.writeFailures,
          embeddingState: runtime?.embeddingState ?? stats.embeddingState,
          // 状态可见化（2026-08-17）：后端标签 + 远程验证失败原因——面板据此
          // 展示"ready(local) 顶班 / 远程未生效"，杜绝静默降级
          embeddingBackend: runtime?.embeddingBackend,
          embeddingInitError: runtime?.embeddingInitError,
          // Q1/A：运行期跨维降级原因（"已降级为关键词，需重新保存配置"可见）
          embeddingDegradedReason: runtime?.embeddingDegradedReason,
          lastMaintenanceAt: runtime?.lastMaintenanceAt ?? stats.lastMaintenanceAt,
          // 自进化/因果观测（null = 未运行/未接线——度量"反思是否变好"的可观测起点）
          reflection: runtime?.reflection ?? null,
          lastReflectionAt: runtime?.lastReflectionAt ?? null,
          // 2b：反思跨轮累计观测量（轻量质量钩子；未运行/未接线 null）
          reflectionCumulative: runtime?.reflectionCumulative ?? null,
          causal: runtime?.causal ?? null,
          lastCausalAt: runtime?.lastCausalAt ?? null,
          // Q5=A：注入链路观测计数（面板调优数据面；未接线 null）
          injectStats: runtime?.injectStats ?? null,
          // Q3=A：扩展路径观测计数（memory_recall 显式召回；未接线 null）
          recallStats: runtime?.recallStats ?? null,
        })
      }
      if (endpoint === 'getConfig') return ok({ config: configView(rpc.config()) })
      if (endpoint === 'setConfig') return ok(await handleSetConfig(rpc, payload, logger))
      return internalError(`未知记忆端点：${endpoint}`)
    } catch (error) {
      return internalError(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * reflect 端点：面板手动触发一轮反思（force 无视周期门控）。
 * 无会话路由 → 反思器回退缓存的上次路由；未接线或仍无路由 → ran:false（诚实返回）。
 */
async function handleReflect(
  reflector: ReflectTrigger | undefined,
  route: { provider: string; model: string } | undefined,
): Promise<{ ran: boolean; reason?: string; reviewed?: number; decisions?: number; merged?: number; archived?: number; skipped?: number }> {
  if (reflector === undefined) return { ran: false, reason: 'reflector_not_connected' }
  const summary = await reflector.runOnce(route, { force: true })
  if (summary === undefined) {
    // Q-fix（2026-08-22）：区分"无路由"与"批次执行失败"——此前一律 no_route_or_no_candidates，
    // 面板把 LLM 执行错误误标成"请配置默认模型"，误导排障方向
    const lastError = reflector.lastError
    return { ran: false, reason: lastError !== undefined ? `反思批次失败：${lastError}` : 'no_model_route' }
  }
  return {
    ran: true,
    reviewed: summary.reviewed,
    decisions: summary.decisions,
    merged: summary.merged,
    archived: summary.archived,
    skipped: summary.skipped,
  }
}

/** 配置视图：当前生效字段 + apiKey 解析状态 + LLM 路由（面板展示用；不含运行时派生态） */
function configView(config: ResolvedConfig): Record<string, unknown> {
  return {
    embeddingApiBaseUrl: config.embeddingApiBaseUrl,
    embeddingApiKey: config.embeddingApiKey,
    embeddingModel: config.embeddingModel,
    embeddingDimension: config.embeddingDimension,
    embeddingApiKeyResolved: resolveApiKey(config.embeddingApiKey) !== undefined,
    // 防御：config.llm 运行时可能为 undefined（旧配置格式/schema 未填充），
    // 可选链 + 空串兜底确保 LLM 字段始终返回字符串，面板输入框不显示 "undefined"
    llmProvider: config.llm?.provider ?? '',
    llmModel: config.llm?.model ?? '',
  }
}

/**
 * setConfig：合并 partial → 整体校验（含跨字段互斥）→ 持久化到 settings.yaml
 * → 内存重启插件生效 → 新配置视图。
 * 持久化失败（settings 服务缺失/磁盘错误/校验拒绝）即整体拒绝——绝不"保存成功
 * 但重启丢失"（2026-08-16 实测根因：原走 fiber.update(noSave=false) 写回
 * cordis.yml，该文件每次启动被 prepareProfile 重置）。
 * 明文密钥检测（P2）：若最终生效的 embeddingApiKey 以 sk- 开头（字面 key 直写
 * settings.yaml），则 logger.warn 提示迁移为 env:BAILIAN_API_KEY 引用——
 * 避免密钥落盘明文（执行 node scripts/migrate-apikey-to-env.mjs 一键迁移）。
 */
async function handleSetConfig(
  rpc: MemoryRpcContext,
  payload: unknown,
  logger?: { warn: (message: string) => void },
): Promise<{ config: Record<string, unknown> }> {
  const partial = parseSetConfigPayload(payload)
  // Config(...) 整体校验：未知键保留但不影响（键已在上一步白名单过滤）；
  // 类型/边界/跨字段（transform）错误在此抛 ValidationError → internal。
  const next = Config({ ...rpc.config(), ...partial }) as ResolvedConfig
  // 明文密钥告警：最终生效 key 以 sk- 开头 → 提示迁移至 env 引用（P2 密钥 env 化）
  if (typeof next.embeddingApiKey === 'string' && next.embeddingApiKey.startsWith('sk-')) {
    logger?.warn(
      '[dsh-memory] 检测到明文 apiKey（sk- 开头）已保存，建议迁移为 env:BAILIAN_API_KEY 引用（执行 node scripts/migrate-apikey-to-env.mjs 一键迁移并脱敏备份）',
    )
  }
  // ① 持久化：settings 命名空间 → ~/.dsh/settings.yaml（DSH 官方用户设置 seam）
  await rpc.settings.update(partial)
  // ② 生效：装配层实时热换嵌入后端（settings.ts applyChange → initEmbedding）。
  // Q6⑫ 中间态显式化：热换失败 ≠ 保存失败——配置已落盘（重启后自动生效），
  // 错误信息必须明示这一"延迟生效"语义，面板不致误判为保存失败。
  try {
    await rpc.applyChange(next)
  } catch (error) {
    throw new Error(
      `配置已保存（settings.yaml，重启后自动生效）但实时生效失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { config: configView(next) }
}

/**
 * 注册到 ctx.connection.rpc。
 * R2-3（B3）：connection 已声明为硬 inject（index.ts）——Cordis 语义"缺失则不加载"，
 * 运行期必有该服务，删除 optional 守卫（防御性死代码）。
 * ctx.get 返回 unknown，类型强转保留（Cordis 未在 Context 类型声明 connection）。
 * @param rpc - 配置端点运行时依赖（index.ts 从 settings seam 构建）
 */
export function registerMemoryRpc(
  ctx: Context,
  store: MemoryStore,
  rpc: MemoryRpcContext,
  runtime?: RuntimeHealth,
  reflector?: ReflectTrigger,
  logger?: { warn: (message: string) => void },
): void {
  const connection = ctx.get('connection') as {
    rpc: { handle(channel: string, handler: MemoryRpcHandler, options: { authority: string }): () => Promise<void> }
  }
  const dispose = connection.rpc.handle('/memory', createMemoryRpcHandler(store, rpc, runtime, reflector, logger), { authority: 'loopback' })
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

/** search：关键词/分类/标签/状态检索（R3：可选 workspace 过滤） */
async function handleSearch(store: MemoryStore, payload: unknown): Promise<{ entries: unknown[]; total: number }> {
  const parsed = parseSearchPayload(payload)
  const entries = store.search({
    query: parsed.query ?? '',
    kind: parsed.kind,
    tag: parsed.tag,
    status: parsed.status,
    limit: parsed.limit,
    workspace: parsed.workspace,
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
    workspace: optionalString(record.workspace),
  }
}

function parseIdPayload(payload: unknown): IdPayload {
  const record = requireRecord(payload)
  const id = record.id
  if (typeof id !== 'string' || id.trim() === '') throw new Error('id 必须为非空字符串')
  return { id }
}

/** Config schema 的 object 字段字典（z.object 直接暴露 dict；逐键白名单用） */
const CONFIG_DICT = (Config as unknown as { dict: Record<string, { (value: unknown): unknown }> }).dict

/**
 * setConfig 载荷校验（严格）：
 * - 必须是对象且非空；
 * - 每个键必须在 Config schema 字典内（未知键拒绝——防拼写错误静默丢失）；
 * - 单字段经 schema 校验（类型/边界），跨字段互斥由 handleSetConfig 的整体
 *   Config(...) 校验兜底（transform）。
 */
function parseSetConfigPayload(payload: unknown): Record<string, unknown> {
  const record = requireRecord(payload)
  const partial: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const field = CONFIG_DICT[key]
    if (field === undefined) throw new Error(`未知配置键：${key}`)
    field(value) // 单字段校验（类型/数值边界）；抛 ValidationError → internal
    partial[key] = value
  }
  if (Object.keys(partial).length === 0) throw new Error('配置载荷不能为空')
  return partial
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
