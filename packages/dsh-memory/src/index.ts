/**
 * @module @echocore/dsh-memory
 *
 * 插件组合根：装配记忆领域、存储与各功能模块，并挂接生命周期。
 * 本文件为 Phase 1 最小装配（领域 + 存储）；提取/注入/工具/面板
 * 在后续阶段按模块追加，保持组合根线性可读。
 *
 * 平面规则：本插件不发布服务，组合行可松散挂载（见实现计划 §2.3）。
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, type Config as ConfigType } from './config.js'
import { MEMORY_TABLE, memoryDomainSpec } from './memory-domain.js'
import { MemoryStore } from './store.js'

export const name = 'memory'
export const inject = ['storageDomain']

export function apply(ctx: Context, config: ConfigType): void {
  const logger = ctx.logger('memory')
  void mountMemory(ctx, config, logger)
}

/** 异步装配：打开领域、构造存储，并把领域关闭注册到插件生命周期 */
async function mountMemory(ctx: Context, _config: ConfigType, logger: ReturnType<Context['logger']>): Promise<void> {
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  // 句柄生命周期归本插件所有：卸载时释放领域（幂等；设施卸载兜底关闭）
  ctx.effect(() => () => {
    void domain.close()
  })

  const store = new MemoryStore(domain.table(MEMORY_TABLE))
  // 后续阶段在此装配：extractor / injector / tools / snapshot / client RPC
  logger.info(`记忆领域已打开（${store.stats().total} 条既有记忆）`)
}

export { Config }
