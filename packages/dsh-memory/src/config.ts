/**
 * @module @echocore/dsh-memory/config
 *
 * 插件配置（schemastery，与 DSH 生态一致）。
 * 组合行 `config:` 经 schemastery validate 校验并填充默认值（未知键保留——
 * 已查证 schemastery ~standard.validate 不剥离未知键，注释以事实为准）。
 *
 * 配置面最小化（用户拍板 2026-08-15）：只保留**远程嵌入** 4 项环境绑定配置；
 * 其余全部行为参数（注入预算/TopK/最低分/提取三参/快照三参/维护间隔/四个
 * enable 开关/本地模型目录）已删除为各模块内代码常量——依据 12-Factor
 * （仅"随部署变化"的才是配置）与 FSE'15 "Too Many Knobs"（多数参数无人设置）。
 * 本地模型目录固定 ~/.dsh/storages/embedding-model（模型是全局共享资产，
 * per-project 复制无意义——用户修正方向）。
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
  /** 远程嵌入 API base URL（OpenAI 兼容 /embeddings 端点；空串 = 未配置远程） */
  embeddingApiBaseUrl: '',
  /**
   * 远程嵌入 API key（用户拍板规则：可直接写字面 key，或写 `env:NAME` 引用环境变量；
   * 空串 = 未配置。DeepSeek 官方无 embeddings API，key 需另配供应商）
   */
  embeddingApiKey: '',
  /** 远程嵌入模型名（如 BAAI/bge-m3、Qwen/Qwen3-Embedding-0.6B） */
  embeddingModel: '',
  /** 远程嵌入维度（OpenAI 兼容生态无 384 维——bge-m3 固定 1024、Qwen3-0.6B 可 512/256/64；按供应商文档配置） */
  embeddingDimension: 1024,
} as const

/** 插件配置（全部可省略，默认值见 DEFAULTS 与 Config schema） */
export interface Config {
  /** 远程嵌入 API base URL（OpenAI 兼容 /embeddings；空串 = 未配置远程） */
  embeddingApiBaseUrl?: string
  /** 远程嵌入 API key（字面 key 或 env:NAME 环境变量引用；空串 = 未配置） */
  embeddingApiKey?: string
  /** 远程嵌入模型名 */
  embeddingModel?: string
  /** 远程嵌入维度（默认 1024=bge-m3；本地固定 384 不随此配置） */
  embeddingDimension?: number
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

/**
 * 生效配置相等判定（四字段逐一比较）。
 * settings seam 的幂等守卫：注册期初始 onChange 与面板 setConfig 显式调用共用，
 * 配置未变则跳过重启——防"重启 → 再注册 → 再重启"环与并发双重启（见 settings.ts）。
 */
export function sameConfig(a: ResolvedConfig, b: ResolvedConfig): boolean {
  return (
    a.embeddingApiBaseUrl === b.embeddingApiBaseUrl &&
    a.embeddingApiKey === b.embeddingApiKey &&
    a.embeddingModel === b.embeddingModel &&
    a.embeddingDimension === b.embeddingDimension
  )
}

/** 插件配置 schema（loader 校验与默认值填充；默认值全部引用 DEFAULTS 单源） */
export const Config = z.object({
  /** 远程嵌入 base URL（OpenAI 兼容端点） */
  embeddingApiBaseUrl: z.string().default(DEFAULTS.embeddingApiBaseUrl),
  /** 远程嵌入 API key（字面 key 或 env:NAME 引用；运行时 resolveApiKey 解析） */
  embeddingApiKey: z.string().default(DEFAULTS.embeddingApiKey),
  /** 远程嵌入模型名 */
  embeddingModel: z.string().default(DEFAULTS.embeddingModel),
  /** 远程嵌入维度（正数；本地 384 不随此配置） */
  embeddingDimension: z.number().min(1).default(DEFAULTS.embeddingDimension),
}) as unknown as z<Config>
// 类型断言理由：schemastery 的 object 返回 Schema<ObjectS, ObjectT>（输入形态含
// null），与 z<Config> 的 meta.default 结构不兼容——输出在运行时经 default 填充，
// 断言只收窄类型不改变行为（与 R2-4/B4 的显式解析同语义）。
// 宿主契约修复（2026-08-16，用户实测"保存配置报 Cannot read properties of
// undefined (reading 'meta')"）：cordis-plugin-loader 的 internal/update 写回路径
// 以裸引用调用 `Config["simplify"](config)`——schemastery 的 simplify 是原型方法
// 依赖 this，裸调用 this=undefined → `this.meta` 崩。导出时绑定 this（KISS：
// 一处修复满足宿主调用契约；宿主行为不变——正常调用与裸调用等价）。
;(Config as unknown as { simplify: (value: unknown) => unknown }).simplify = (
  Config as unknown as { simplify: (value: unknown) => unknown }
).simplify.bind(Config)
