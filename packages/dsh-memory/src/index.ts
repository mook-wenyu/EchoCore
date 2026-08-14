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

import { Config, type Config as ConfigType } from './config.js'
import { MemoryExtractor, type ExtractorConfig } from './extractor.js'
import { MemoryInjector, type InjectorConfig } from './injector.js'
import { MEMORY_TABLE, memoryDomainSpec } from './memory-domain.js'
import { MemoryStore } from './store.js'

export const name = 'memory'
export const inject = ['storageDomain', 'llm']

export function apply(ctx: Context, config: ConfigType): void {
  const logger = ctx.logger('memory')
  void mountMemory(ctx, config, logger)
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
  const extractorConfig: ExtractorConfig = {
    enableExtractor: config.enableExtractor ?? true,
    minExtractChars: config.minExtractChars ?? 2000,
    extractMaxTokens: config.extractMaxTokens ?? 2048,
  }
  new MemoryExtractor({ store, llm: ctx.llm, logger, config: extractorConfig }).install(ctx)

  // 注入器：pre-step 自动注入相关记忆（带预算、去重与溯源标记）
  const injectorConfig: InjectorConfig = {
    enableAutoInject: config.enableAutoInject ?? true,
    topK: config.topK ?? 8,
    minScore: config.minScore ?? 0.15,
    injectBudgetChars: config.injectBudgetChars ?? 4096,
  }
  new MemoryInjector({ store, logger, config: injectorConfig }).install(ctx)

  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }
