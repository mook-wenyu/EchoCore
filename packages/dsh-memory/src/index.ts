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
import { EmbeddingIndex } from './embed-index.js'
import { EmbeddingService, EmbeddingUnavailableError, resolveApiKey, type EmbeddingHolder } from './embedding.js'
import { MemoryExtractor } from './extractor.js'
import { registerMemoryRpc, type MemoryRpcContext } from './host-rpc.js'
import { MemoryInjector } from './injector.js'
import { MemoryMaintenance } from './maintenance.js'
import { MEMORY_TABLE, memoryEntrySchema } from './memory-domain.js'
import { registerSnapshot } from './snapshot.js'
import { migrateMemoryJson, SqliteKvTable } from './sqlite-kv.js'
import { MemoryStableSnapshot } from './stable-snapshot.js'
import { MemoryStore } from './store.js'
import { installSettingsSeam, type SettingsSeam } from './settings.js'
import { registerMemoryTools } from './tools.js'
import { jiebaWords } from './scoring.js'
import type { MemoryEntry } from './types.js'

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
function rpcContextFrom(seam: SettingsSeam | undefined, fallback: ResolvedConfig): MemoryRpcContext {
  if (seam === undefined) {
    return {
      config: () => fallback,
      settings: {
        update: () => Promise.reject(new Error('settings seam 未接线：配置无法持久化（测试直连装配）')),
      },
      applyChange: () => Promise.resolve(),
    }
  }
  return { config: seam.effective, settings: seam.channel, applyChange: seam.applyChange }
}

/** 嵌入索引文件路径（按维度隔离：本地 384 / 远程配置值——不同维度混用会使余弦失真）。
 * 存储路径经 dsh-home-paths 解析（DSH_HOME 优先、~/.dsh 回退——与 settings.yaml
 * 同源；多实例/CI 隔离，2026-08-16 用户拍板）。 */
function defaultEmbeddingsFile(dimension: number): string {
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

/** 嵌入初始化并发纪元（epoch 守卫：并发初始化只保留最后一次发起的会话） */
let embeddingEpoch = 0
const EMBEDDING_MODEL_DIR = defaultEmbeddingModelDir()

/**
 * 嵌入后端初始化/热换（装配初始 init 与面板保存热换共用一条路径）：
 * 远程配置齐 → 远程优先验证；失败回退本地模型检测；都无 → disabled（正常态）。
 * ready 时按后端维度文件构建 EmbeddingIndex 并加载（维度隔离，不同维度不得混用）。
 * - epoch 守卫：并发初始化只保留最后一次调用发起的会话（陈旧结果丢弃——防
 *   慢速旧会话覆盖新配置的后端）；
 * - 热换前 flush 旧索引（10s 去抖持久化的待写向量落盘，不丢）；
 * - 初始化失败（EmbeddingUnavailableError）记录并**保留旧后端**（热换失败不
 *   破坏当前可用嵌入；首启时 holder 恒空 → 关键词模式）。
 */
async function initEmbedding(
  config: ResolvedConfig,
  holder: EmbeddingHolder,
  store: MemoryStore,
  logger: ReturnType<Context['logger']>,
): Promise<void> {
  const epoch = ++embeddingEpoch
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
  if (epoch !== embeddingEpoch) return
  // 旧索引待写向量落盘后再替换（10s 去抖——面板保存热换不丢向量）
  if (holder.index !== undefined) {
    await holder.index.flush().catch((error: unknown) => {
      logger.warn(`[dsh-memory] 嵌入索引落盘失败（旧索引丢弃）：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  if (epoch !== embeddingEpoch) return
  if (service.state === 'ready') {
    const index = new EmbeddingIndex({
      file: defaultEmbeddingsFile(service.dimension),
      service,
      listAll: () => store.listRecent(Number.MAX_SAFE_INTEGER),
      logWarn: (message, error) => logger.warn(message, error),
    })
    await index.load()
    if (epoch !== embeddingEpoch) return
    holder.service = service
    holder.index = index
    // 全量补齐缺失嵌入（后台；~1.2s/1260 条，不阻塞生效完成）
    void index.ensureAll()
    logger.info(`[dsh-memory] 语义嵌入已就绪（后端：${service.backendLabel}，维度：${service.dimension}）`)
  } else {
    if (epoch !== embeddingEpoch) return
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
  // 首启迁移：memory.json 存在且 SQLite 为空 → 逐条校验导入 → 原文件改名为
  // memory.json.bak 保留（不删除——迁移可追溯；幂等：SQLite 非空即跳过）。
  const db = new DatabaseSync(overrides.dbFile ?? defaultMemoryDbFile())
  // 句柄生命周期归本插件所有：卸载时关闭数据库（幂等）
  ctx.effect(() => () => {
    if (db.isOpen) db.close()
  })
  const table = new SqliteKvTable<MemoryEntry>(db, MEMORY_TABLE, (entry) => jiebaWords(entry.content).join(' '))

  // 嵌入后端持有者 + 实时生效器接线（面板保存热换嵌入后端，不重启插件——
  // 重启与 apply 秒级异步段竞态，2026-08-16 实测 fatal load failure，见上方
  // initEmbedding 注释）。store 经 storeRef 延迟引用：applier 在迁移前挂接，
  // 若 settings 变更恰在迁移窗口内触发，则跳过（后续初始 init 读 seam.effective()
  // 已含合并配置——同一生效门，不丢变更）。
  const holder: EmbeddingHolder = { service: undefined, index: undefined }
  let storeRef: MemoryStore | undefined
  overrides.seam?.setApplier((next) => {
    const s = storeRef
    if (s === undefined) return Promise.resolve()
    return initEmbedding(next, holder, s, logger)
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
    } else if (migrated > 0 || skipped > 0) {
      logger.info(`[dsh-memory] 记忆库已迁移至 SQLite：${migrated} 条导入，${skipped} 条跳过（原 memory.json 已改名 .bak 保留）`)
      // 原文件改名保留（迁移完成后旧文件不再作为数据源——防重复迁移）
      await rename(legacyFile, `${legacyFile}.bak`).catch(() => {
        logger.warn('[dsh-memory] memory.json 改名 .bak 失败（迁移已完成，旧文件保留原位置）')
      })
    }
  }

  // R4-1：畸形 source（手工篡改 memory.json）被检索过滤时告警一次，可观测性由装配层提供
  // P4 hooks：闭包读 holder.index（调用时求值——热换后新索引即生效，无需重启）
  const store = (storeRef = new MemoryStore(
    table,
    undefined,
    (id) => {
      logger.warn(`[dsh-memory] 发现 source 结构畸形的记忆条目（已从检索/浏览过滤，可用 memory_audit ${id} 查看）：${id}`)
    },
    {
      // 新建记忆增量嵌入（fire-and-forget，嵌入失败仅记录，检索保持关键词）
      onCreate: (entry) => holder.index?.indexEntry(entry),
      onArchive: (id) => holder.index?.remove(id),
      // P2-1：被覆盖条目联动移除向量（检索已隐藏，向量不再有语义召回价值）
      onSupersede: (id) => holder.index?.remove(id),
    },
  ))

  // 语义嵌入初始初始化（远程优先 → 本地回退 → disabled 正常态）。装配用
  // seam 的**当前**生效配置（settings 段若已在注册期生效，此处即合并值）——
  // 与热换共用 initEmbedding 单一路径（epoch 守卫防并发旧会话覆盖）。
  await initEmbedding(overrides.seam?.effective() ?? config, holder, store, logger)

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

  // 后台整理任务（O8-M）：定时合并重复、过期降级、标签整理（间隔已常量化，恒启用）
  const maintenance = new MemoryMaintenance({ store, logger, now: () => Date.now() })
  maintenance.install(ctx)

  // O1：运行健康指标组装（写链失败/嵌入状态/上次维护——tools status 与 RPC status 共用）
  const runtime = {
    writeFailures: table.writeFailures,
    // 动态读 holder（热换后状态即时刷新；getter 惰性求值）
    get embeddingState() {
      return holder.service?.state ?? 'disabled'
    },
    lastMaintenanceAt: maintenance.lastRunAt,
  }

  // 模型工具：recall / search / note / forget / audit / status
  // （G3：snapshot 传入供工具回路去重——快照已注入的记忆不再由工具重复输出）
  registerMemoryTools(ctx, { store, snapshot: snapshotService, embedding: holder, logger, runtime })

  // 会话快照：压缩摘要登记 + 会话结束快照（跨会话检索的连续性基底）
  registerSnapshot(ctx, { store, logger })

  // 面板 RPC：connection 通道（/memory），客户端 settings.section 面板的数据面；
  // 配置端点由 settings seam 供数（getConfig 读生效配置 / setConfig 持久化到
  // settings.yaml 并经实时生效器热换嵌入后端——根因修复见 settings.ts 文件头）
  registerMemoryRpc(ctx, store, rpcContextFrom(overrides.seam, config), runtime)

  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }




