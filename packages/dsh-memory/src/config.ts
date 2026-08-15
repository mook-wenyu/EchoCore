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
  /** 稳定快照总开关（OPTIMIZATION_PLAN_3 P1：system 前缀缓存感知注入） */
  enableSnapshot: true,
  /** 稳定快照缓存窗口（ms；窗口内快照字节不变，保持 DeepSeek 前缀缓存命中） */
  snapshotTtlMs: 300000,
  /** 稳定快照预算上限（字符；重要性优先取数，预算内截断） */
  snapshotBudgetChars: 8192,
  /** 稳定快照 Top-K 候选上限（预算之外的保险，防止单 workspace 记忆过多时全表扫描） */
  snapshotTopK: 30,
  /** 本地嵌入模型目录（含 ONNX 模型与 tokenizer 文件；空串 → 默认 ~/.dsh/storages/embedding-model） */
  embeddingModelDir: '',
  /** 远程嵌入 API base URL（OpenAI 兼容 /embeddings 端点；空串 = 未配置远程） */
  embeddingApiBaseUrl: '',
  /** 远程嵌入 API key（与 DSH/DeepSeek key 无关——DeepSeek 官方无 embeddings API，需另配供应商） */
  embeddingApiKey: '',
  /** 远程嵌入模型名（如 BAAI/bge-m3、Qwen/Qwen3-Embedding-0.6B） */
  embeddingModel: '',
  /** 远程嵌入维度（OpenAI 兼容生态无 384 维——bge-m3 固定 1024、Qwen3-0.6B 可 512/256/64；按供应商文档配置） */
  embeddingDimension: 1024,
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
  /** 稳定快照总开关（system 前缀缓存感知注入） */
  enableSnapshot?: boolean
  /** 稳定快照缓存窗口（ms） */
  snapshotTtlMs?: number
  /** 稳定快照预算上限（字符） */
  snapshotBudgetChars?: number
  /** 稳定快照 Top-K 候选上限 */
  snapshotTopK?: number
  /** 语义嵌入（默认自动启用：远程配置齐 → 远程；否则本地模型检测 → 本地；都无 → 禁用） */
  embeddingModelDir?: string
  /** 远程嵌入 API base URL（OpenAI 兼容 /embeddings；空串 = 未配置远程） */
  embeddingApiBaseUrl?: string
  /** 远程嵌入 API key（需另配供应商，DeepSeek key 不可用于嵌入） */
  embeddingApiKey?: string
  /** 远程嵌入模型名 */
  embeddingModel?: string
  /** 远程嵌入维度（默认 1024=bge-m3；本地固定 384 不随此配置） */
  embeddingDimension?: number
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
export const Config = z.transform(
  z.object({
    /** P1-1：注入预算 ≥1（0 会让注入永远空转） */
    injectBudgetChars: z.number().min(1).default(DEFAULTS.injectBudgetChars),
    /** P1-1：Top-K ≥1（0 无注入候选） */
    topK: z.number().min(1).default(DEFAULTS.topK),
    /** P1-1：综合分 0..1（负值放行噪声、>1 全拒——越界由 schema 拒绝，不做运行时夹逼） */
    minScore: z.number().min(0).max(1).default(DEFAULTS.minScore),
    /** P1-1：提取触发阈值 ≥1 */
    minExtractChars: z.number().min(1).default(DEFAULTS.minExtractChars),
    /** P1-1：提取摘录上限 ≥1 */
    maxExtractChars: z.number().min(1).default(DEFAULTS.maxExtractChars),
    /** P1-1：提取输出上限 ≥1 */
    extractMaxTokens: z.number().min(1).default(DEFAULTS.extractMaxTokens),
    enableAutoInject: z.boolean().default(DEFAULTS.enableAutoInject),
    enableSnapshot: z.boolean().default(DEFAULTS.enableSnapshot),
    /** 快照缓存窗口下限 1s（防配置 0 导致每轮重建，破坏"稳定"语义） */
    snapshotTtlMs: z.number().min(1000).default(DEFAULTS.snapshotTtlMs),
    snapshotBudgetChars: z.number().min(1).default(DEFAULTS.snapshotBudgetChars),
    snapshotTopK: z.number().min(1).default(DEFAULTS.snapshotTopK),
    embeddingModelDir: z.string().default(DEFAULTS.embeddingModelDir),
    /** 远程嵌入 base URL（OpenAI 兼容端点） */
    embeddingApiBaseUrl: z.string().default(DEFAULTS.embeddingApiBaseUrl),
    /** 远程嵌入 API key */
    embeddingApiKey: z.string().default(DEFAULTS.embeddingApiKey),
    /** 远程嵌入模型名 */
    embeddingModel: z.string().default(DEFAULTS.embeddingModel),
    /** 远程嵌入维度（正数；本地 384 不随此配置） */
    embeddingDimension: z.number().min(1).default(DEFAULTS.embeddingDimension),
    enableExtractor: z.boolean().default(DEFAULTS.enableExtractor),
    enableMaintenance: z.boolean().default(DEFAULTS.enableMaintenance),
    /** 后台整理任务间隔（小时；R2-10/M2：最小 1，非法值由 schema 校验拒绝而非运行时夹逼） */
    maintenanceIntervalHours: z.number().min(1).default(DEFAULTS.maintenanceIntervalHours),
  }),
  (value) => {
    // P1-1 跨字段互斥：min > max 时 extractor 截尾保最新会丢头部且 lastSeq 已推进
    // ——早期消息永久丢失；此约束必须拒绝而非夹逼（夹逼会掩盖配置错误）。
    // value 类型含 null（schema 输入形态），但 validate 后 default 已填充——
    // 用 ResolvedConfig 收紧类型（运行时恒有值，与装配层一致）。
    const resolved = value as ResolvedConfig
    if (resolved.minExtractChars > resolved.maxExtractChars) {
      throw new z.ValidationError(
        `minExtractChars (${resolved.minExtractChars}) 不能大于 maxExtractChars (${resolved.maxExtractChars})`,
        {},
      )
    }
    return resolved
  },
) as unknown as z<Config>
// 类型断言理由：schemastery 的 transform 静态方法返回 Schema<TypeS, T>（输入形态含
// null），与 z<Config> 的 meta.default 结构不兼容——输出在运行时经 default 填充，
// 断言只收窄类型不改变行为（与 R2-4/B4 的显式解析同语义）。
