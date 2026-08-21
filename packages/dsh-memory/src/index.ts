/**
 * @module @echocore/dsh-memory
 *
 * 插件组合根：装配记忆领域、存储与各功能模块，并挂接生命周期。
 * 各模块按阶段追加，保持组合根线性可读：
 * - Phase 1：领域 + 存储
 * - Phase 2：双通道提取器
 * - Phase 3+：注入器 / 工具 / 快照 / Client RPC（后续阶段）
 *
 * 平面规则：本插件不发布服务，组合行可松散挂载（见实现计划 §2.3）。
 */

import { rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import type { Context } from '@deepseek-ai/cordis'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Config, DEFAULTS, type Config as ConfigType, type ResolvedConfig } from './config.js'
import { MemoryCausalExtractor, MemoryCausalStore } from './causal.js'
import { EmbeddingIndex } from './embed-index.js'
import { EmbeddingService, EmbeddingUnavailableError, resolveApiKey, type EmbeddingHolder } from './embedding.js'
import { MemoryExtractor } from './extractor.js'
import { registerMemoryRpc, type MemoryRpcContext } from './host-rpc.js'
import { MemoryInjector } from './injector.js'
import { MemoryMaintenance } from './maintenance.js'
import { MEMORY_TABLE, memoryEntrySchema } from './memory-domain.js'
import { MemoryReflector } from './reflect.js'
import { registerSnapshot } from './snapshot.js'
import { migrateMemoryJson, SqliteKvTable } from './sqlite-kv.js'
import { MemoryStableSnapshot } from './stable-snapshot.js'
import { MemoryStore } from './store.js'
import { installSettingsSeam, type SettingsSeam } from './settings.js'
import { registerMemoryTools } from './tools.js'
import { jiebaWords } from './scoring.js'
import { LlmFactory, memoryRuntime } from './runtime.js'
import type { MemoryCausalEdge, MemoryEntry } from './types.js'

export const name = 'memory'
// 直接访问的服务必须全部声明注入（Cordis 守卫：未声明即拒绝）：
// - llm：提取/摘要调用（透传给提取器）
// - tools：注册六个模型工具（registerMemoryTools 内 ctx.tools.register）
// - connection：面板 RPC 通道（registerMemoryRpc 内 ctx.connection.rpc.handle）
// - systemPrompt：稳定快照段注册（MemoryStableSnapshot 内 ctx.systemPrompt.context）
// 注：存储自建 SQLite（SqliteKvTable，node:sqlite）——不依赖宿主 storageDomain
// （2026-08-15 结构性改造：整文件原子写 → WAL O(1) 写，见 sqlite-kv.ts）。
export const inject = ['llm', 'tools', 'connection', 'systemPrompt']

export function apply(ctx: Context, config: ConfigType): Promise<void> {
  const logger = ctx.logger('memory')
  // R2-1（B1）：装配失败必须上抛——apply 返回 mountMemory 的 promise，
  // Cordis fiber 在启动错误时拒绝（registry.d.ts：rejecting on startup errors），
  // 插件加载失败对宿主可见。禁止 catch 后保持"已激活但功能全缺"的半死状态。
  // 配置持久化 seam（settings.yaml）：根因修复见 settings.ts 文件头——原
  // fiber.update(noSave=false) 写回 cordis.yml，该文件每次启动被 prepareProfile
  // 重置，面板配置"保存成功但重启丢失"（2026-08-16 实测）。
  const seam = installSettingsSeam(ctx, config)
  // R2-4（B4）：显式配置解析边界——entry 配置经 DEFAULTS 填充（settings.ts
  // entryConfig）；seam.effective() 在 settings 未挂载时即 entry 配置。装配
  // 代码直接读必填字段（类型收窄，非运行时兜底）。
  return mountMemory(ctx, seam.effective(), logger, { seam })
}

/**
 * 由 settings seam 构建面板配置 RPC 上下文。
 * 无 seam（测试直连 mountMemory）：配置视图用装配传入值；持久化/重启拒绝——
 * 测试面不触碰真实配置源（index.test 只验证装配，配置端点契约见 host-rpc.test）。
 */
function rpcContextFrom(seam: SettingsSeam | undefined, fallback: ResolvedConfig, ctx: Context): MemoryRpcContext {
  // DSH 宿主 agent-default-model 回退源：memory LLM 配置为空时经此获取宿主默认模型。
  // ctx.agentDefaultModel 为 Cordis 服务注入（dsh-agent-default-model 插件提供），
  // 宿主未挂载时 ctx.get 返回 undefined——回退函数统一返回 undefined（诚实返回）。
  const getDefaultModel = (): { provider: string; model: string } | undefined => {
    // 方案1：尝试从 DSH settings 服务读取 agent-default-model 命名空间
    try {
      const svc = ctx.get('settings') as { get?: (ns: string) => { provider?: string; model?: string } | undefined } | undefined
      if (svc !== undefined && typeof svc.get === 'function') {
        const agentDefault = svc.get('agent-default-model')
        if (agentDefault?.provider && agentDefault?.model) {
          return { provider: agentDefault.provider, model: agentDefault.model }
        }
      }
    } catch {}
    // 方案2：直接读取 settings.yaml 文件（降级兜底）
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const path = require('node:path') as typeof import('node:path')
      const os = require('node:os') as typeof import('node:os')
      const settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml')
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8')
        // 简单解析 YAML：找 agent-default-model 段的 provider/model
        const lines = content.split('\n')
        let inAgentDefault = false
        let provider = ''
        let model = ''
        for (const line of lines) {
          if (line.trim().startsWith('agent-default-model:')) {
            inAgentDefault = true
            continue
          }
          if (inAgentDefault) {
            if (line.startsWith('  ') || line.startsWith('\t')) {
              const trimmed = line.trim()
              if (trimmed.startsWith('provider:')) provider = trimmed.split(':')[1]?.trim().replace(/['"]/g, '') ?? ''
              if (trimmed.startsWith('model:')) model = trimmed.split(':')[1]?.trim().replace(/['"]/g, '') ?? ''
            } else {
              break
            }
          }
        }
        if (provider && model) return { provider, model }
      }
    } catch {}
    return undefined
  }
  if (seam === undefined) {
    return {
      config: () => fallback,
      settings: {
        update: () => Promise.reject(new Error('settings seam 未接线：配置无法持久化（测试直连装配）')),
      },
      applyChange: () => Promise.resolve(),
      defaultModel: getDefaultModel,
    }
  }
  return { config: seam.effective, settings: seam.channel, applyChange: seam.applyChange, defaultModel: getDefaultModel }
}

/** 旧 JSON 嵌入索引文件路径（vec0 迁移源：memory-embeddings-<dim>.json；迁移后改名 .bak） */
function legacyEmbeddingsFile(dimension: number): string {
  return dshHomePath('storages', `memory-embeddings-${dimension}.json`)
}

/** 嵌入模型目录默认路径（空配置时；含 onnx/model_quantized.onnx 与 tokenizer 文件） */
function defaultEmbeddingModelDir(): string {
  return dshHomePath('storages', 'embedding-model')
}

// ── 嵌入后端实时热换（配置保存后原位生效，不重启插件） ──────────────────────
// 2026-08-16 二次实测根因：重启式生效与 apply 的秒级异步段（加载本地 ONNX
// 模型）竞态——陈旧续体要么撞 inactive 窗口崩溃，要么二次注册 memory:snapshot/
// memory_recall 触发 NamedEntries 严格重复检测（fatal load failure）。终版方案
// （用户拍板）：settings 变更 → 重建 EmbeddingService/EmbeddingIndex 写入
// holder；store 钩子/注入器/工具/状态展示在**调用时**读 holder，热换零竞态。
// 模块级可变全局（embeddingEpoch/holder/storeRef）已收敛至 MemoryRuntime 单例
// （memoryRuntime.holder/epoch/storeRef），消除模块级可变状态。

const EMBEDDING_MODEL_DIR = defaultEmbeddingModelDir()

/**
 * 嵌入后端初始化/热换（装配初始 init 与面板保存热换共用一条路径）：
 * 远程配置齐 → 远程优先验证；失败回退本地模型检测；都无 → disabled（正常态）。
 * ready 时在 memory.sqlite 上构建 vec0 索引（2026-08-17 用户拍板
 * @photostructure/sqlite-vec；维度隔离按表 vec_memory_<dim>）。
 * - epoch 守卫：并发初始化只保留最后一次调用发起的会话（陈旧结果丢弃——防
 *   慢速旧会话覆盖新配置的后端）；
 * - 旧 JSON 索引一次性迁移入表（表非空跳过，幂等）；
 * - 初始化失败（EmbeddingUnavailableError）记录并**保留旧后端**（热换失败不
 *   破坏当前可用嵌入；首启时 holder 恒空 → 关键词模式）。
 */
async function initEmbedding(
  config: ResolvedConfig,
  db: DatabaseSync,
  holder: EmbeddingHolder,
  store: MemoryStore,
  logger: ReturnType<Context['logger']>,
): Promise<void> {
  const epoch = ++memoryRuntime.epoch
  // 远程配置齐判定：baseUrl/model/apiKey 非空（apiKey 经 resolveApiKey 解析——
  // 字面 key 或 env:NAME 环境变量引用；解析为空视为未配置）
  const remoteConfigured =
    config.embeddingApiBaseUrl !== '' &&
    config.embeddingModel !== '' &&
    resolveApiKey(config.embeddingApiKey) !== undefined
  const service = new EmbeddingService({
    modelDir: EMBEDDING_MODEL_DIR,
    remote: remoteConfigured
      ? {
          baseUrl: config.embeddingApiBaseUrl,
          model: config.embeddingModel,
          dimension: config.embeddingDimension,
          apiKey: config.embeddingApiKey,
        }
      : undefined,
  })
  try {
    await service.init()
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) {
      logger.error(`[dsh-memory] ${error.message}（检索保持关键词模式）`)
      return
    }
    throw error
  }
  if (epoch !== memoryRuntime.epoch) return
  if (service.state === 'ready') {
    // 向量索引 = vec0 虚拟表（与 memory.sqlite 同文件；构造即载入 sqlite-vec
    // 扩展并建表）。旧 JSON 索引（memory-embeddings-<dim>.json）一次性迁移入
    // 表（表非空则跳过——幂等），迁移后原文件改名 .bak 保留。
    const index = new EmbeddingIndex({
      db,
      service,
      listAll: () => store.listRecent(Number.MAX_SAFE_INTEGER),
      logWarn: (message, error) => logger.warn(message, error),
    })
    // Q2 拍板：清理非当前维度的旧 vec0 表（维度切换后 ensureAll 已按当前维度
    // 重嵌缺失条目，旧表无引用价值——防 vec_memory_<dim> 随维度切换无界堆积）
    index.dropOtherDimensionTables()
    const legacyFile = legacyEmbeddingsFile(service.dimension)
    const migrated = await index.loadLegacy(legacyFile)
    if (migrated > 0) {
      logger.info(`[dsh-memory] 旧嵌入索引已迁移至 vec0 表（${migrated} 条）`)
      await rename(legacyFile, `${legacyFile}.bak`).catch(() => {
        logger.warn('[dsh-memory] 旧嵌入索引改名 .bak 失败（保留原位置）')
      })
    }
    if (epoch !== memoryRuntime.epoch) return
    holder.service = service
    holder.index = index
    // 全量补齐缺失嵌入（后台；仅缺失条目——既有向量已迁移/复用于表内）
    void index.ensureAll()
    logger.info(`[dsh-memory] 语义嵌入已就绪（后端：${service.backendLabel}，维度：${service.dimension}，索引 ${index.table}）`)
  } else {
    if (epoch !== memoryRuntime.epoch) return
    holder.service = service
    holder.index = undefined
    logger.info('[dsh-memory] 语义嵌入未启用：无远程配置且无本地模型（关键词检索）')
  }
}

/** 记忆库 SQLite 文件路径（替代旧 memory.json；WAL O(1) 写，见 sqlite-kv.ts） */
function defaultMemoryDbFile(): string {
  return dshHomePath('storages', 'memory.sqlite')
}

/** 旧 storage-json 记忆库文件路径（首启迁移源；迁移后改名为 .bak 保留） */
function legacyMemoryJsonFile(): string {
  return dshHomePath('storages', 'memory.json')
}

/** 装配覆盖项（测试注入：隔离真实用户目录的存储文件） */
export interface MountOverrides {
  /** 记忆库 SQLite 文件路径（默认 ~/.dsh/storages/memory.sqlite） */
  dbFile?: string
  /** 旧 memory.json 路径（默认 ~/.dsh/storages/memory.json；迁移源） */
  legacyJsonFile?: string
  /** 配置持久化 seam（apply 注入；测试直连装配可不传——配置端点见 rpcContextFrom） */
  seam?: SettingsSeam
  /** 1b（2026-08-17 用户拍板）：装配侧 test seam——组合根不返回 store，测试经此
   * 拿句柄驱动真实写路径（如"create→索引联动失败不崩"集成测试）。运行期不传
   * 则无作用；仅测试注入，不改变装配语义。 */
  exposeStore?: (store: MemoryStore) => void
}

/** 装配各模块：打开 SQLite 存储（含首启迁移）→ 构造存储与提取器 → 挂接生命周期 */
export async function mountMemory(
  ctx: Context,
  config: ResolvedConfig,
  logger: ReturnType<Context['logger']>,
  overrides: MountOverrides = {},
): Promise<void> {
  // 结构性存储改造（用户拍板）：自建 SQLite（node:sqlite，WAL 追加写 O(1)），
  // 替代宿主 storage-domain + storage-json 的整文件原子写（O(n) 写放大）。
  // allowExtension：加载 sqlite-vec 扩展（vec0 向量表；2026-08-17 用户拍板
  // @photostructure/sqlite-vec——同一连接向量检索 O(1) 与条目存储共存）。
  // 首启迁移：memory.json 存在且 SQLite 为空 → 逐条校验导入 → 原文件改名为
  // memory.json.bak 保留（不删除——迁移可追溯；幂等：SQLite 非空即跳过）。
  const db = new DatabaseSync(overrides.dbFile ?? defaultMemoryDbFile(), { allowExtension: true })
  // 句柄生命周期归本插件所有：卸载时关闭数据库（幂等）
  ctx.effect(() => () => {
    if (db.isOpen) db.close()
  })
  const table = new SqliteKvTable<MemoryEntry>(db, MEMORY_TABLE, (entry) => jiebaWords(entry.content).join(' '))
  // 因果链独立边表（拍板：独立边表——不污染 MemoryEntry JSON；与 entries 同库共连接，
  // SqliteKvTable 泛型自动 CREATE TABLE IF NOT EXISTS，无迁移成本）
  const edgeTable = new SqliteKvTable<MemoryCausalEdge>(db, 'memory_causal_edges')
  const causalStore = new MemoryCausalStore(edgeTable, () => Date.now())
  // meta 表（P1 游标持久化，2026-08-20）：维护游标 lastCursor + 反思水位线 reflectCursor
  // 共用一表不同键。此前 maintenance 未接 metaTable（装配缺陷）——生产游标分片静默
  // 退化为进程内态、重启归零；本次一并补线。
  const metaTable = new SqliteKvTable<string>(db, 'meta')

  // 嵌入后端持有者 + 实时生效器接线（面板保存热换嵌入后端，不重启插件——
  // 重启与 apply 秒级异步段竞态，2026-08-16 实测 fatal load failure，见上方
  // initEmbedding 注释）。store 经 storeRef 延迟引用：applier 在迁移前挂接，
  // 若 settings 变更恰在迁移窗口内触发，则跳过（后续初始 init 读 seam.effective()
  // 已含合并配置——同一生效门，不丢变更）。
  // 显式化单例：holder/epoch/storeRef 已收敛至 memoryRuntime（消除模块级可变全局）
  const holder: EmbeddingHolder = memoryRuntime.holder
  overrides.seam?.setApplier((next) => {
    const s = memoryRuntime.storeRef
    if (s === undefined) return Promise.resolve()
    return initEmbedding(next, db, holder, s, logger)
  })

  if (table.size === 0) {
    const legacyFile = overrides.legacyJsonFile ?? legacyMemoryJsonFile()
    const { migrated, skipped, corrupt } = await migrateMemoryJson(legacyFile, table, (raw) =>
      memoryEntrySchema.safeParse(raw).success,
    )
    if (corrupt) {
      // D2：旧文件 JSON 损坏——记录告警并改名 .bak 保留，插件以空库启动
      // （与 embed-index 损坏降级语义对齐；坏文件可人工恢复）
      logger.warn(`[dsh-memory] 旧记忆库 ${legacyFile} 已损坏（JSON 解析失败）——以空库启动，坏文件改名 .bak 保留`)
      await rename(legacyFile, `${legacyFile}.bak`).catch(() => {
        logger.warn('[dsh-memory] 损坏文件改名 .bak 失败（保留原位置）')
      })
    } else if (migrated > 0) {
      logger.info(`[dsh-memory] 记忆库已迁移至 SQLite：${migrated} 条导入，${skipped} 条跳过（原 memory.json 已改名 .bak 保留）`)
      // 原文件改名保留（迁移完成后旧文件不再作为数据源——防重复迁移）
      await rename(legacyFile, `${legacyFile}.bak`).catch(() => {
        logger.warn('[dsh-memory] memory.json 改名 .bak 失败（迁移已完成，旧文件保留原位置）')
      })
    } else if (skipped > 0) {
      // Q6①：全坏/全跳过（migrated=0 且 skipped>0）——**不** rename .bak：
      // 否则旧记录只在 .bak 中、SQLite 仍空、无重试路径（数据静默不可达）。
      // 保留原文件原位 + 明显告警：下次启动（SQLite 仍空）会重新尝试迁移，
      // 坏数据可人工修复/导回后重试迁移。
      logger.warn(
        `[dsh-memory] 旧记忆库 ${legacyFile} 全部 ${skipped} 条记录校验失败（未导入任何条目）——` +
          `保留原文件以便人工修复后重新迁移（SQLite 现为空库）`,
      )
    }
  }

  // R4-1：畸形 source（手工篡改 memory.json）被检索过滤时告警一次，可观测性由装配层提供
  // P4 hooks：闭包读 holder.index（调用时求值——热换后新索引即生效，无需重启）
  const store = (memoryRuntime.storeRef = new MemoryStore(
    table,
    undefined,
    (id) => {
      logger.warn(`[dsh-memory] 发现 source 结构畸形的记忆条目（已从检索/浏览过滤，可用 memory_audit ${id} 查看）：${id}`)
    },
    {
      // 新建记忆增量嵌入（fire-and-forget 附属效果）——嵌入失败**只记录**，不得
      // 让主链路（store.create）出现未处理 rejection（DSH 对未处理拒绝 exit(1)
      // 杀进程）；与 onArchive/onSupersede 的收容形态一致。非静默兜底：显式
      // logWarn 让运行期嵌入故障可观测（面板/日志可见），检索保持关键词。
      onCreate: (entry) => {
        void holder.index?.indexEntry(entry).catch((error: unknown) =>
          logger.warn(`[dsh-memory] 新建记忆嵌入索引失败（${entry.id}）：`, error),
        )
      },
      onArchive: (id) => {
        holder.index?.remove(id)
        // 归档条目不再参与因果图（孤儿清理；fire-and-forget 收容失败）
        void causalStore.removeEdgesFor(id).catch((error: unknown) => logger.warn(`[dsh-memory] 归档关联因果边清理失败（${id}）：`, error))
      },
      // P2-1：被覆盖条目联动移除向量（检索已隐藏，向量不再有语义召回价值）；
      // 其因果边指向受隐藏条目已无审计价值——一并清理（与向量同生命周期）
      onSupersede: (id) => {
        holder.index?.remove(id)
        void causalStore.removeEdgesFor(id).catch((error: unknown) => logger.warn(`[dsh-memory] 覆盖关联因果边清理失败（${id}）：`, error))
      },
    },
  ))
  // 1b：test seam（装配完成后把 store 句柄交给调用方；运行期不传则无作用）
  overrides.exposeStore?.(store)

  // 语义嵌入初始初始化（远程优先 → 本地回退 → disabled 正常态）。装配用
  // seam 的**当前**生效配置（settings 段若已在注册期生效，此处即合并值）——
  // 与热换共用 initEmbedding 单一路径（epoch 守卫防并发旧会话覆盖）。
  await initEmbedding(overrides.seam?.effective() ?? config, db, holder, store, logger)

  // 提取器：双通道（压缩遮蔽 + 轮次增量），纯观察不阻塞主循环
  // （参数已常量化——用户拍板配置面最小化；提取恒启用）
  new MemoryExtractor({ store, llm: ctx.llm, logger }).install(ctx)

  // 注入器：pre-step 自动注入相关记忆（带预算、去重与溯源标记；参数已常量化，恒启用）
  const snapshotService = new MemoryStableSnapshot({
    store,
    now: () => Date.now(),
  })
  snapshotService.install(ctx)
  // embedding 传 holder（调用时读 service/index——面板保存热换后即生效，无需重启）
  new MemoryInjector({ store, snapshot: snapshotService, embedding: holder, logger }).install(ctx)

  // LLM 子任务（自进化/因果链）：复用 ctx.llm（与提取器同通道）。维护周期每批
  // 规则任务后按各自周期门控自动执行；工具/RPC 可 force 手动触发。
  const reflector = new MemoryReflector({
    store,
    llm: ctx.llm,
    logger,
    now: () => Date.now(),
    // C34：语义门取向量（holder.index 调用时求值——热换后新索引即生效）
    // 使用 getter 延迟读取：构造时 holder.index 可能为 undefined（异步初始化未完成），
    // 热换后 getter 每次读取最新值（与 store hooks/injector 同模式）
    embedding: holder.index,
    getEmbeddingIndex: () => holder.index,
    // P1 水位线（2026-08-20 拍板）：自动路径只审新增焦点，跨重启持久于 meta:reflectCursor
    metaTable,
  })
  const causalExtractor = new MemoryCausalExtractor({ store, causal: causalStore, llm: ctx.llm, logger, now: () => Date.now() })
  // 后台整理任务（O8-M）：定时合并重复、过期降级、标签整理（间隔已常量化，恒启用）；
  // C33：每周期顺带向量增量补齐（分片限速；holder.index 调用时求值——热换后新索引即生效）
  const maintenance = new MemoryMaintenance({
    store,
    logger: { warn: (...args) => logger.warn(...args), info: (...args) => logger.info(...args) },
    now: () => Date.now(),
    reflector,
    causal: causalExtractor,
    backfill: (budget) => holder.index?.backfill(budget) ?? Promise.resolve(0),
    // 补线（装配缺陷修复）：维护游标 lastCursor 此前未持久化（重启归零、44 周期
    // 全库轮询实际从未跨重启续跑）；现接入 meta 表恢复设计语义。
    metaTable,
  })
  maintenance.install(ctx)

  // O1：运行健康指标组装（写链失败/嵌入状态/上次维护/反思因果——tools status 与 RPC status 共用）
  const runtime = {
    writeFailures: table.writeFailures,
    // 动态读 holder（热换后状态即时刷新；getter 惰性求值）
    get embeddingState() {
      return holder.service?.state ?? 'disabled'
    },
    // 当前后端标签（状态可见化：面板区分 ready(remote) 与 ready(local) 顶班）
    get embeddingBackend() {
      return holder.service?.backendLabel
    },
    // 最近一次远程验证失败原因（远程未生效时展示，杜绝静默回退——2026-08-17 实测根因）
    get embeddingInitError() {
      return holder.service?.lastInitError
    },
    // Q1/A：运行期跨维降级原因（语义已降级为关键词时展示——状态可见化，非静默）
    get embeddingDegradedReason() {
      return holder.service?.degradedReason
    },
    lastMaintenanceAt: maintenance.lastRunAt,
    // 自进化/因果观测（动态 getter：维护周期/手动触发后即时刷新，供 memory_status/面板）
    get reflection() {
      return reflector.lastSummary
    },
    get lastReflectionAt() {
      return reflector.lastRunAt
    },
    // 2b：反思跨轮累计观测量（轻量质量钩子——"反思是否在收敛"可观测）
    get reflectionCumulative() {
      return reflector.cumulativeSummary
    },
    // 连续空轮计数与 hitRate+emptyRounds+reviewed 三元组（memory_status 透出）
    get causal() {
      return causalExtractor.lastSummary
    },
    get lastCausalAt() {
      return causalExtractor.lastRunAt
    },
    get causalCumulative() {
      return (causalExtractor as { cumulativeSummary?: unknown }).cumulativeSummary ?? null
    },
    // LLM 单一信任源可观测（memory_status 暴露 llm.model/configHash，中文注释）
    get llm() {
      const snap = LlmFactory.getInstance().getSnapshot()
      return { model: snap.model, configHash: snap.configHash, provider: snap.provider, api_base: snap.api_base, temperature: snap.temperature }
    },
    get configHash() {
      return LlmFactory.getInstance().getSnapshot().configHash
    },
  }

  // 模型工具：recall / search / note / forget / audit / status / reflect
  // （G3：snapshot 传入供工具回路去重——快照已注入的记忆不再由工具重复输出）
  registerMemoryTools(ctx, {
    store,
    snapshot: snapshotService,
    embedding: holder,
    logger,
    runtime,
    causal: causalStore,
    reflector,
    causalExtractor,
  })

  // 会话快照：压缩摘要登记 + 会话结束快照（跨会话检索的连续性基底）
  registerSnapshot(ctx, { store, logger })

  // 面板 RPC：connection 通道（/memory），客户端 settings.section 面板的数据面；
  // 配置端点由 settings seam 供数（getConfig 读生效配置 / setConfig 持久化到
  // settings.yaml 并经实时生效器热换嵌入后端——根因修复见 settings.ts 文件头）；
  // reflect 端点 = 面板手动触发反思（route 缺省回退反思器缓存——面板无会话）
  // P2：明文密钥检测（sk- 开头）经 logger.warn 提示迁移 env:BAILIAN_API_KEY
  registerMemoryRpc(ctx, store, rpcContextFrom(overrides.seam, config, ctx), runtime, reflector, logger)

  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }




