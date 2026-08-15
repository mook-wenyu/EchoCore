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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import type { Context } from '@deepseek-ai/cordis'

import { Config, DEFAULTS, type Config as ConfigType, type ResolvedConfig } from './config.js'
import { EmbeddingIndex } from './embed-index.js'
import { EmbeddingService, EmbeddingUnavailableError, resolveApiKey } from './embedding.js'
import { MemoryExtractor } from './extractor.js'
import { registerMemoryRpc } from './host-rpc.js'
import { MemoryInjector } from './injector.js'
import { MemoryMaintenance } from './maintenance.js'
import { MEMORY_TABLE, memoryEntrySchema } from './memory-domain.js'
import { registerSnapshot } from './snapshot.js'
import { migrateMemoryJson, SqliteKvTable } from './sqlite-kv.js'
import { MemoryStableSnapshot } from './stable-snapshot.js'
import { MemoryStore } from './store.js'
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
  // R2-4（B4）：显式配置解析边界——schemastery 运行时已填默认值，此处仅做
  // 类型收窄（Config 可选 → ResolvedConfig 必填），装配代码直接读字段。
  const resolved: ResolvedConfig = { ...DEFAULTS, ...config }
  return mountMemory(ctx, resolved, logger)
}

/** 嵌入索引文件路径（按维度隔离：本地 384 / 远程配置值——不同维度混用会使余弦失真） */
function defaultEmbeddingsFile(dimension: number): string {
  return join(homedir(), '.dsh', 'storages', `memory-embeddings-${dimension}.json`)
}

/** 嵌入模型目录默认路径（空配置时；含 onnx/model_quantized.onnx 与 tokenizer 文件） */
function defaultEmbeddingModelDir(): string {
  return join(homedir(), '.dsh', 'storages', 'embedding-model')
}

/** 记忆库 SQLite 文件路径（替代旧 memory.json；WAL O(1) 写，见 sqlite-kv.ts） */
function defaultMemoryDbFile(): string {
  return join(homedir(), '.dsh', 'storages', 'memory.sqlite')
}

/** 旧 storage-json 记忆库文件路径（首启迁移源；迁移后改名为 .bak 保留） */
function legacyMemoryJsonFile(): string {
  return join(homedir(), '.dsh', 'storages', 'memory.json')
}

/** 装配覆盖项（测试注入：隔离真实用户目录的存储文件） */
export interface MountOverrides {
  /** 记忆库 SQLite 文件路径（默认 ~/.dsh/storages/memory.sqlite） */
  dbFile?: string
  /** 旧 memory.json 路径（默认 ~/.dsh/storages/memory.json；迁移源） */
  legacyJsonFile?: string
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
  // P4 hooks：onCreate/onArchive 闭包引用后赋值的 embedIndex（let，延迟求值——
  // 嵌入启用时索引在下方初始化；未启用时恒 undefined，hook 空操作）
  const store = new MemoryStore(
    table,
    undefined,
    (id) => {
      logger.warn(`[dsh-memory] 发现 source 结构畸形的记忆条目（已从检索/浏览过滤，可用 memory_audit ${id} 查看）：${id}`)
    },
    {
      // 新建记忆增量嵌入（fire-and-forget，嵌入失败仅记录，检索保持关键词）
      onCreate: (entry) => embedIndex?.indexEntry(entry),
      onArchive: (id) => embedIndex?.remove(id),
      // P2-1：被覆盖条目联动移除向量（检索已隐藏，向量不再有语义召回价值）
      onSupersede: (id) => embedIndex?.remove(id),
    },
  )

  // 语义嵌入（默认启用：远程配置齐 → 远程优先；否则本地模型检测 → 本地；
  // 都无 → disabled 正常禁用态）。初始化失败（后端存在但加载异常）记录并
  // 保持关键词检索——嵌入是一等状态（EmbeddingService.state），非静默兜底。
  // 本地模型目录固定全局默认（用户拍板：模型是共享资产，目录不配置——
  // ~/.dsh/storages/embedding-model）。
  let embeddingService: EmbeddingService | undefined
  let embedIndex: EmbeddingIndex | undefined
  const modelDir = defaultEmbeddingModelDir()
  // 远程配置齐判定：baseUrl/model/apiKey 非空（apiKey 经 resolveApiKey 解析——
  // 字面 key 或 env:NAME 环境变量引用；解析为空视为未配置）
  const remoteConfigured =
    config.embeddingApiBaseUrl !== '' &&
    config.embeddingModel !== '' &&
    resolveApiKey(config.embeddingApiKey) !== undefined
  embeddingService = new EmbeddingService({
    modelDir,
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
    await embeddingService.init()
    if (embeddingService.state === 'ready') {
      // 索引文件按后端维度隔离（本地 384 / 远程配置值）——不同维度不得混用
      embedIndex = new EmbeddingIndex({
        file: defaultEmbeddingsFile(embeddingService.dimension),
        service: embeddingService,
        listAll: () => store.listRecent(Number.MAX_SAFE_INTEGER),
        logWarn: (message, error) => logger.warn(message, error),
      })
      await embedIndex.load()
      // 全量补齐缺失嵌入（后台；~1.2s/1260 条，不阻塞装配完成）
      void embedIndex.ensureAll()
      logger.info(`[dsh-memory] 语义嵌入已就绪（后端：${embeddingService.backendLabel}，维度：${embeddingService.dimension}）`)
    } else {
      logger.info('[dsh-memory] 语义嵌入未启用：无远程配置且无本地模型（关键词检索）')
    }
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) {
      logger.error(`[dsh-memory] ${error.message}（检索保持关键词模式）`)
    } else {
      throw error
    }
  }

  // 提取器：双通道（压缩遮蔽 + 轮次增量），纯观察不阻塞主循环
  // （参数已常量化——用户拍板配置面最小化；提取恒启用）
  new MemoryExtractor({ store, llm: ctx.llm, logger }).install(ctx)

  // 注入器：pre-step 自动注入相关记忆（带预算、去重与溯源标记；参数已常量化，恒启用）
  const snapshotService = new MemoryStableSnapshot({
    store,
    now: () => Date.now(),
  })
  snapshotService.install(ctx)
  new MemoryInjector({ store, snapshot: snapshotService, embedding: embeddingService, embedIndex, logger }).install(ctx)

  // 模型工具：recall / search / note / forget / audit / status
  // （G3：snapshot 传入供工具回路去重——快照已注入的记忆不再由工具重复输出）
  registerMemoryTools(ctx, { store, snapshot: snapshotService, embedding: embeddingService, embedIndex, logger })

  // 会话快照：压缩摘要登记 + 会话结束快照（跨会话检索的连续性基底）
  registerSnapshot(ctx, { store, logger })

  // 面板 RPC：connection 通道（/memory），客户端 settings.section 面板的数据面；
  // config 传入供 getConfig/setConfig 端点（setConfig 经 ctx.fiber.update 写回+重启）
  registerMemoryRpc(ctx, store, config)

  // 后台整理任务（O8-M）：定时合并重复、过期降级、标签整理（间隔已常量化，恒启用）
  new MemoryMaintenance({ store, logger, now: () => Date.now() }).install(ctx)

  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }
