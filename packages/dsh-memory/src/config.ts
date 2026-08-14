/**
 * @module @echocore/dsh-memory/config
 *
 * 插件配置（schemastery，与 DSH 生态一致）。
 * 组合行 `config:` 中的未知键会被 loader 拒绝；默认值见下。
 * 类型与 schema 分离：interface 供 apply 使用，`Config` 常量供 loader 校验。
 */

import z from '@deepseek-ai/schemastery'

/** 插件配置（全部可省略，默认值见 Config schema） */
export interface Config {
  /** 自动注入预算上限（字符；DSH 固定启发式 ≈ 每 4 字符 1 token，4096 ≈ 1K token） */
  injectBudgetChars?: number
  /** 自动注入 Top-K 条数 */
  topK?: number
  /** 注入最低综合分（0..1，低于此分不注入，避免噪声） */
  minScore?: number
  /** 增量提取触发阈值（字符；本回合新增文本累计超过此值才调 LLM 提取） */
  minExtractChars?: number
  /** 提取调用输出 token 上限 */
  extractMaxTokens?: number
  /** 压缩目标阈值（token）：到达后应无感自动压缩（计划 D13，默认 400K） */
  compactThresholdTokens?: number
  /** 自动注入总开关 */
  enableAutoInject?: boolean
  /** 提取器总开关 */
  enableExtractor?: boolean
}

/** 插件配置 schema（loader 校验与默认值填充） */
export const Config: z<Config> = z.object({
  injectBudgetChars: z.number().default(4096),
  topK: z.number().default(8),
  minScore: z.number().default(0.15),
  minExtractChars: z.number().default(2000),
  extractMaxTokens: z.number().default(2048),
  compactThresholdTokens: z.number().default(400000),
  enableAutoInject: z.boolean().default(true),
  enableExtractor: z.boolean().default(true),
})
