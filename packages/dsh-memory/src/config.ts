/**
 * @module @echocore/dsh-memory/config
 *
 * 插件配置（schemastery，与 DSH 生态一致）。
 * 组合行 `config:` 经 schemastery validate 校验并填充默认值（未知键保留——
 * 已查证 schemastery ~standard.validate 不剥离未知键，注释以事实为准）。
 *
 * 单源默认值：schema 的 `.default()` 与消费者代码（index.ts 装配）都引用
 * 本文件的 `DEFAULTS` 常量——schemastery 在插件激活前经 `~standard.validate`
 * 填充默认值（已查证 cordis resolveConfig），`DEFAULTS` 保证类型与运行时一致。
 *
 * 注：400K 压缩阈值不属于本插件配置——全局压缩由宿主 compaction-basic
 * 承载（cordis.patch.yml 解禁 + modelPolicies 0.4），见部署文档。
 */

import z from '@deepseek-ai/schemastery'

/** 默认值单源（schema 与 index.ts 装配共用，防双写漂移） */
export const DEFAULTS = {
  /** 自动注入预算上限（字符；DSH 固定启发式 ≈ 每 4 字符 1 token）。≈4K token——与 magic-context 全局记忆注入预算（injection_budget_tokens: 4000）对齐 */
  injectBudgetChars: 16384,
  /** 自动注入 Top-K 条数 */
  topK: 8,
  /** 注入最低综合分（0..1，低于此分不注入，避免噪声） */
  minScore: 0.15,
  /** 增量提取触发阈值（字符；本回合新增文本累计超过此值才调 LLM 提取） */
  minExtractChars: 2000,
  /** 增量提取摘录长度上限（字符；超限截尾保头——近期信息优先，防提取调用超窗） */
  maxExtractChars: 12000,
  /** 提取调用输出 token 上限 */
  extractMaxTokens: 2048,
  /** 自动注入总开关 */
  enableAutoInject: true,
  /** 提取器总开关 */
  enableExtractor: true,
  /** 后台记忆整理任务开关（O8-M） */
  enableMaintenance: true,
  /** 后台整理任务间隔（小时；仅在进程有活跃会话事件后计时） */
  maintenanceIntervalHours: 6,
} as const

/** 插件配置（全部可省略，默认值见 DEFAULTS 与 Config schema） */
export interface Config {
  /** 自动注入预算上限（字符，≈4K token） */
  injectBudgetChars?: number
  /** 自动注入 Top-K 条数 */
  topK?: number
  /** 注入最低综合分（0..1） */
  minScore?: number
  /** 增量提取触发阈值（字符） */
  minExtractChars?: number
  /** 增量提取摘录长度上限（字符） */
  maxExtractChars?: number
  /** 提取调用输出 token 上限 */
  extractMaxTokens?: number
  /** 自动注入总开关 */
  enableAutoInject?: boolean
  /** 提取器总开关 */
  enableExtractor?: boolean
  /** 后台记忆整理任务开关 */
  enableMaintenance?: boolean
  /** 后台整理任务间隔（小时） */
  maintenanceIntervalHours?: number
}

/**
 * 解析后的必填配置（R2-4/B4 类型收窄）：
 * 组合行 config 经 schemastery 校验时已填充默认值（运行时恒有值），
 * 但 Config 接口全可选，类型层面无法表达"已填充"——沿用 DSH 生态
 * 双类型模式（BasicCompactionConfig → ResolvedConfig）：
 * apply 入口做一次显式解析 `{ ...DEFAULTS, ...config }`，此后装配
 * 代码直接读必填字段，不再逐字段 `??`（运行时兜底是死分支，类型
 * 收窄才是它的真实作用）。
 */
export type ResolvedConfig = Required<Config>

/** 插件配置 schema（loader 校验与默认值填充；默认值全部引用 DEFAULTS 单源） */
export const Config: z<Config> = z.object({
  injectBudgetChars: z.number().default(DEFAULTS.injectBudgetChars),
  topK: z.number().default(DEFAULTS.topK),
  minScore: z.number().default(DEFAULTS.minScore),
  minExtractChars: z.number().default(DEFAULTS.minExtractChars),
  maxExtractChars: z.number().default(DEFAULTS.maxExtractChars),
  extractMaxTokens: z.number().default(DEFAULTS.extractMaxTokens),
  enableAutoInject: z.boolean().default(DEFAULTS.enableAutoInject),
  enableExtractor: z.boolean().default(DEFAULTS.enableExtractor),
  enableMaintenance: z.boolean().default(DEFAULTS.enableMaintenance),
  /** 后台整理任务间隔（小时；R2-10/M2：最小 1，非法值由 schema 校验拒绝而非运行时夹逼） */
  maintenanceIntervalHours: z.number().min(1).default(DEFAULTS.maintenanceIntervalHours),
})
