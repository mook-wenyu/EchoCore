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

import type { Context } from '@deepseek-ai/cordis'

import { Config, DEFAULTS, type Config as ConfigType, type ResolvedConfig } from './config.js'
import { MemoryExtractor, type ExtractorConfig } from './extractor.js'
import { registerMemoryRpc } from './host-rpc.js'
import { MemoryInjector, type InjectorConfig } from './injector.js'
import { MemoryMaintenance, type MaintenanceConfig } from './maintenance.js'
import { MEMORY_TABLE, memoryDomainSpec } from './memory-domain.js'
import { registerSnapshot } from './snapshot.js'
import { MemoryStableSnapshot } from './stable-snapshot.js'
import { MemoryStore } from './store.js'
import { registerMemoryTools } from './tools.js'

export const name = 'memory'
// 直接访问的服务必须全部声明注入（Cordis 守卫：未声明即拒绝）：
// - storageDomain：记忆领域持久化
// - llm：提取/摘要调用（透传给提取器）
// - tools：注册六个模型工具（registerMemoryTools 内 ctx.tools.register）
// - connection：面板 RPC 通道（registerMemoryRpc 内 ctx.connection.rpc.handle）
// - systemPrompt：稳定快照段注册（MemoryStableSnapshot 内 ctx.systemPrompt.context）
export const inject = ['storageDomain', 'llm', 'tools', 'connection', 'systemPrompt']

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

/** 装配各模块：打开领域 → 构造存储与提取器 → 挂接生命周期 */
async function mountMemory(ctx: Context, config: ResolvedConfig, logger: ReturnType<Context['logger']>): Promise<void> {
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  // 句柄生命周期归本插件所有：卸载时释放领域（幂等；设施卸载兜底关闭）
  ctx.effect(() => () => {
    void domain.close()
  })

  // R4-1：畸形 source（手工篡改 memory.json）被检索过滤时告警一次，可观测性由装配层提供
  const store = new MemoryStore(domain.table(MEMORY_TABLE), undefined, (id) => {
    logger.warn(`[dsh-memory] 发现 source 结构畸形的记忆条目（已从检索/浏览过滤，可用 memory_audit ${id} 查看）：${id}`)
  })

  // 提取器：双通道（压缩遮蔽 + 轮次增量），纯观察不阻塞主循环
  // R2-4（B4）：schemastery 加载即填充默认值，?? 是死分支——直接读 config 字段
  const extractorConfig: ExtractorConfig = {
    enableExtractor: config.enableExtractor,
    minExtractChars: config.minExtractChars,
    maxExtractChars: config.maxExtractChars,
    extractMaxTokens: config.extractMaxTokens,
  }
  new MemoryExtractor({ store, llm: ctx.llm, logger, config: extractorConfig }).install(ctx)

  // 注入器：pre-step 自动注入相关记忆（带预算、去重与溯源标记）
  const injectorConfig: InjectorConfig = {
    enableAutoInject: config.enableAutoInject,
    topK: config.topK,
    minScore: config.minScore,
    injectBudgetChars: config.injectBudgetChars,
  }
  const snapshotService = new MemoryStableSnapshot({
    store,
    config: {
      enableSnapshot: config.enableSnapshot,
      snapshotTtlMs: config.snapshotTtlMs,
      snapshotBudgetChars: config.snapshotBudgetChars,
      snapshotTopK: config.snapshotTopK,
    },
    now: () => Date.now(),
  })
  snapshotService.install(ctx)
  new MemoryInjector({ store, snapshot: snapshotService, logger, config: injectorConfig }).install(ctx)

  // 模型工具：recall / search / note / forget / audit / status
  registerMemoryTools(ctx, { store })

  // 会话快照：压缩摘要登记 + 会话结束快照（跨会话检索的连续性基底）
  registerSnapshot(ctx, { store, logger })

  // 面板 RPC：connection 通道（/memory），客户端 settings.section 面板的数据面
  registerMemoryRpc(ctx, store)

  // 后台整理任务（O8-M）：定时合并重复、过期降级、标签整理；开关与间隔经配置
  const maintenanceConfig: MaintenanceConfig = {
    enableMaintenance: config.enableMaintenance,
    maintenanceIntervalHours: config.maintenanceIntervalHours,
  }
  new MemoryMaintenance({ store, logger, config: maintenanceConfig, now: () => Date.now() }).install(ctx)

  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }
