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

import { Config, DEFAULTS, type Config as ConfigType } from './config.js'
import { MemoryExtractor, type ExtractorConfig } from './extractor.js'
import { registerMemoryRpc } from './host-rpc.js'
import { MemoryInjector, type InjectorConfig } from './injector.js'
import { MemoryMaintenance, type MaintenanceConfig } from './maintenance.js'
import { MEMORY_TABLE, memoryDomainSpec } from './memory-domain.js'
import { registerSnapshot } from './snapshot.js'
import { MemoryStore } from './store.js'
import { registerMemoryTools } from './tools.js'

export const name = 'memory'
// 直接访问的服务必须全部声明注入（Cordis 守卫：未声明即拒绝）：
// - storageDomain：记忆领域持久化
// - llm：提取/摘要调用（透传给提取器）
// - tools：注册六个模型工具（registerMemoryTools 内 ctx.tools.register）
// - connection：面板 RPC 通道（registerMemoryRpc 内 ctx.connection.rpc.handle）
export const inject = ['storageDomain', 'llm', 'tools', 'connection']

export function apply(ctx: Context, config: ConfigType): void {
  const logger = ctx.logger('memory')
  // O2-2：装配失败不再静默——resolved 拒绝必须上抛给宿主可见，方便定位领域打开/存储初始化问题
  void mountMemory(ctx, config, logger).catch((error: unknown) => {
    logger.error('[dsh-memory] 装配失败：', error)
  })
}

/** 装配各模块：解析配置默认值 → 打开领域 → 构造存储与提取器 → 挂接生命周期 */
async function mountMemory(ctx: Context, config: ConfigType, logger: ReturnType<Context['logger']>): Promise<void> {
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  // 句柄生命周期归本插件所有：卸载时释放领域（幂等；设施卸载兜底关闭）
  ctx.effect(() => () => {
    void domain.close()
  })

  const store = new MemoryStore(domain.table(MEMORY_TABLE))

  // 提取器：双通道（压缩遮蔽 + 轮次增量），纯观察不阻塞主循环
  // 默认值引用 DEFAULTS 单源（schemastery 加载即填充，?? 是死分支，仅作可读性保障）
  const extractorConfig: ExtractorConfig = {
    enableExtractor: config.enableExtractor ?? DEFAULTS.enableExtractor,
    minExtractChars: config.minExtractChars ?? DEFAULTS.minExtractChars,
    maxExtractChars: config.maxExtractChars ?? DEFAULTS.maxExtractChars,
    extractMaxTokens: config.extractMaxTokens ?? DEFAULTS.extractMaxTokens,
  }
  new MemoryExtractor({ store, llm: ctx.llm, logger, config: extractorConfig }).install(ctx)

  // 注入器：pre-step 自动注入相关记忆（带预算、去重与溯源标记）
  const injectorConfig: InjectorConfig = {
    enableAutoInject: config.enableAutoInject ?? DEFAULTS.enableAutoInject,
    topK: config.topK ?? DEFAULTS.topK,
    minScore: config.minScore ?? DEFAULTS.minScore,
    injectBudgetChars: config.injectBudgetChars ?? DEFAULTS.injectBudgetChars,
  }
  new MemoryInjector({ store, logger, config: injectorConfig }).install(ctx)

  // 模型工具：recall / search / note / forget / audit / status
  registerMemoryTools(ctx, { store })

  // 会话快照：压缩摘要登记 + 会话结束快照（跨会话检索的连续性基底）
  registerSnapshot(ctx, { store, logger })

  // 面板 RPC：connection 通道（/memory），客户端 settings.section 面板的数据面
  registerMemoryRpc(ctx, store, logger)

  // 后台整理任务（O8-M）：定时合并重复、过期降级、标签整理；开关与间隔经配置
  const maintenanceConfig: MaintenanceConfig = {
    enableMaintenance: config.enableMaintenance ?? DEFAULTS.enableMaintenance,
    maintenanceIntervalHours: config.maintenanceIntervalHours ?? DEFAULTS.maintenanceIntervalHours,
  }
  new MemoryMaintenance({ store, logger, config: maintenanceConfig, now: () => Date.now() }).install(ctx)

  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }
