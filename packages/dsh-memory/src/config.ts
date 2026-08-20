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

/** LLM 单一信任源默认值（唯一可信源，子模块禁止硬编码 openai/gpt-4） */
export interface LlmConfig {
  /** 提供方标识（如 deepseek、openai 兼容网关；空串 = 未配置） */
  provider: string
  /** 模型名（如 deepseek-chat；空串 = 未配置） */
  model: string
  /** API 基地址（如 https://api.deepseek.com；空串 = 未配置） */
  api_base: string
  /** 采样温度 0~2（默认 0.7） */
  temperature: number
}
/** LLM 默认值单源（子模块禁止硬编码 openai/gpt-4，统一引用此单源） */
export const LLM_DEFAULTS: LlmConfig = {
  provider: '',
  model: '',
  api_base: '',
  temperature: 0.7,
} as const

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
  /** LLM 单一信任源（根 llm 为唯一可信源） */
  llm: LLM_DEFAULTS,
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
  /** LLM 单一信任源（根 llm 为唯一可信源，子模块禁止硬编码） */
  llm?: Partial<LlmConfig>
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
export type ResolvedConfig = Required<Config> & { llm: LlmConfig }

/**
 * 生效配置相等判定（四字段逐一比较 + llm 四子字段）。
 * settings seam 的幂等守卫：注册期初始 onChange 与面板 setConfig 显式调用共用，
 * 配置未变则跳过重启——防"重启 → 再注册 → 再重启"环与并发双重启（见 settings.ts）。
 */
export function sameConfig(a: ResolvedConfig, b: ResolvedConfig): boolean {
  return (
    a.embeddingApiBaseUrl === b.embeddingApiBaseUrl &&
    a.embeddingApiKey === b.embeddingApiKey &&
    a.embeddingModel === b.embeddingModel &&
    a.embeddingDimension === b.embeddingDimension &&
    a.llm.provider === b.llm.provider &&
    a.llm.model === b.llm.model &&
    a.llm.api_base === b.llm.api_base &&
    a.llm.temperature === b.llm.temperature
  )
}

/**
 * 配置哈希（FNV-1a 32 位，确定性，中文注释）
 * 用于 memory_status 可观测（llm 配置变更可追踪）
 */
function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
/** 计算配置哈希（基于 llm 四字段 JSON 规范化） */
export function configHashOf(config: ResolvedConfig): string {
  const payload = JSON.stringify({
    provider: config.llm.provider,
    model: config.llm.model,
    api_base: config.llm.api_base,
    temperature: config.llm.temperature,
  })
  return fnv1aHash(payload)
}

/**
 * 配置管理器：单一信任源合并（显式 > env: > 默认）
 * 中文注释：显式配置最高优先级；显式值为 env:NAME 时解析环境变量；
 * 显式缺省时回退 env LLM_*；再回退默认。
 */
export class ConfigManager {
  /**
   * 合并配置（显式 > env: > 默认）
   * @param explicit 显式配置（用户/面板传入，可能含 env: 占位）
   * @param env 环境变量表（默认 process.env）
   */
  static mergeConfig(
    explicit: Partial<Config> = {},
    env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  ): ResolvedConfig {
    // 辅助：解析 env: 占位或直接值
    const resolveStr = (val: unknown, envKey: string, def: string): string => {
      if (val !== undefined) {
        if (typeof val === 'string') {
          const trimmed = val.trim()
          if (trimmed.startsWith('env:')) {
            const name = trimmed.slice(4).trim()
            const envVal = name ? env[name] : undefined
            if (envVal !== undefined && envVal !== '') return envVal
            return def
          }
          return trimmed
        }
        return String(val)
      }
      const envVal = env[envKey]
      if (envVal !== undefined && envVal !== '') return envVal
      return def
    }
    const resolveNum = (val: unknown, envKey: string, def: number): number => {
      if (val !== undefined) {
        if (typeof val === 'string' && val.trim().startsWith('env:')) {
          const name = val.trim().slice(4).trim()
          const envVal = name ? env[name] : undefined
          if (envVal !== undefined && envVal !== '') {
            const n = Number(envVal)
            return Number.isFinite(n) ? n : def
          }
          return def
        }
        const n = Number(val)
        return Number.isFinite(n) ? n : def
      }
      const envVal = env[envKey]
      if (envVal !== undefined && envVal !== '') {
        const n = Number(envVal)
        return Number.isFinite(n) ? n : def
      }
      return def
    }
    const expLlm = explicit.llm ?? {}
    const llm: LlmConfig = {
      provider: resolveStr(expLlm.provider, 'LLM_PROVIDER', LLM_DEFAULTS.provider),
      model: resolveStr(expLlm.model, 'LLM_MODEL', LLM_DEFAULTS.model),
      api_base: resolveStr(expLlm.api_base, 'LLM_API_BASE', LLM_DEFAULTS.api_base),
      temperature: resolveNum(expLlm.temperature, 'LLM_TEMPERATURE', LLM_DEFAULTS.temperature),
    }
    // 嵌入配置保持原有显式>默认（兼容 env: 前缀）
    const embeddingApiBaseUrl = resolveStr(explicit.embeddingApiBaseUrl, 'EMBEDDING_API_BASE_URL', DEFAULTS.embeddingApiBaseUrl)
    const embeddingApiKeyRaw = explicit.embeddingApiKey
    let embeddingApiKey: string
    if (embeddingApiKeyRaw !== undefined) {
      if (typeof embeddingApiKeyRaw === 'string' && embeddingApiKeyRaw.trim().startsWith('env:')) {
        const name = embeddingApiKeyRaw.trim().slice(4).trim()
        embeddingApiKey = name && env[name] ? env[name]! : DEFAULTS.embeddingApiKey
      } else {
        embeddingApiKey = String(embeddingApiKeyRaw)
      }
    } else {
      embeddingApiKey = DEFAULTS.embeddingApiKey
    }
    const embeddingModel = resolveStr(explicit.embeddingModel, 'EMBEDDING_MODEL', DEFAULTS.embeddingModel)
    const embeddingDimension = resolveNum(explicit.embeddingDimension, 'EMBEDDING_DIMENSION', DEFAULTS.embeddingDimension)
    return {
      embeddingApiBaseUrl,
      embeddingApiKey,
      embeddingModel,
      embeddingDimension,
      llm,
    } as ResolvedConfig
  }
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
  /** LLM 单一信任源（根 llm 为唯一可信源） */
  llm: z
    .object({
      provider: z.string().default(LLM_DEFAULTS.provider),
      model: z.string().default(LLM_DEFAULTS.model),
      api_base: z.string().default(LLM_DEFAULTS.api_base),
      temperature: z.number().min(0).max(2).default(LLM_DEFAULTS.temperature),
    })
    .default(LLM_DEFAULTS),
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
