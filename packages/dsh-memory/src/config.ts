/**
 * @module @echocore/dsh-memory/config
 *
 * 插件配置（schemastery，与 DSH 生态一致）。
 * 组合行 `config:` 中的未知键会被 loader 拒绝；默认值见下。
 * 类型与 schema 分离：interface 供 apply 使用，`Config` 常量供 loader 校验。
 *
 * 注：400K 压缩阈值不属于本插件配置——全局压缩由宿主 compaction-basic
 * 承载（cordis.patch.yml 解禁 + modelPolicies 0.4），见部署文档。
 */

import z from '@deepseek-ai/schemastery'

/** 插件配置（全部可省略，默认值见 Config schema） */
export interface Config {
  /**
   * 自动注入预算上限（字符；DSH 固定启发式 ≈ 每 4 字符 1 token）。
   * 默认 16384 ≈ 4K token——与 magic-context 全局记忆注入预算
   * （memory.injection_budget_tokens: 4000）对齐；占 400K 压缩预算 1%。
   */
  injectBudgetChars?: number
  /** 自动注入 Top-K 条数 */
  topK?: number
  /** 注入最低综合分（0..1，低于此分不注入，避免噪声） */
  minScore?: number
  /** 增量提取触发阈值（字符；本回合新增文本累计超过此值才调 LLM 提取） */
  minExtractChars?: number
  /** 提取调用输出 token 上限 */
  extractMaxTokens?: number
  /** 自动注入总开关 */
  enableAutoInject?: boolean
  /** 提取器总开关 */
  enableExtractor?: boolean
}

/** 插件配置 schema（loader 校验与默认值填充） */
export const Config: z<Config> = z.object({
  injectBudgetChars: z.number().default(16384),
  topK: z.number().default(8),
  minScore: z.number().default(0.15),
  minExtractChars: z.number().default(2000),
  extractMaxTokens: z.number().default(2048),
  enableAutoInject: z.boolean().default(true),
  enableExtractor: z.boolean().default(true),
})
