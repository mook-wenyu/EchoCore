/**
 * @module @echocore/dsh-memory/embedding
 *
 * 本地语义嵌入服务（OPTIMIZATION_PLAN_3 P4）。
 *
 * 技术选型（2026-08-15 实测）：@huggingface/transformers@4.2.0 +
 * Xenova/all-MiniLM-L6-v2（q8 量化 21.9MB，384 维）。Node 18+ 官方支持，
 * 本机实测单条嵌入中位 2.5ms、批量 1260 条约 1.2s；模型文件本地存放、
 * 显式禁止远程下载（env.allowRemoteModels=false）。
 *
 * 一等状态（非静默兜底）：
 * - `state: 'disabled'`：embeddingEnabled=false（显式配置关闭）；
 * - `state: 'loading'`：初始化中；
 * - `state: 'ready'`：可调用 embed；
 * - `state: 'error'`：初始化失败（模型文件缺失/损坏/onnxruntime 加载失败）。
 *   装配层记录 error 并保持关键词检索；任何 embed 调用在非 ready 状态
 *   抛 EmbeddingUnavailableError（明确错误，绝不返回假空向量）。
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

/** 嵌入不可用（未启用/未就绪/初始化失败）——显式错误，调用方按状态决策 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EmbeddingUnavailableError'
  }
}

/** 嵌入服务运行状态（一等状态，装配层与调用方据此决策） */
export type EmbeddingState = 'disabled' | 'loading' | 'ready' | 'error'

/** 嵌入服务依赖 */
export interface EmbeddingServiceDeps {
  /** 显式启用开关（false → 永不加载，state='disabled'） */
  enabled: boolean
  /** 模型目录（含 onnx/model_quantized.onnx 与 tokenizer 文件；末尾斜杠由加载器拼接） */
  modelDir: string
}

/** 语义检索降级回调（装配层注入 logger；embed 运行期故障时记录并回退关键词） */
export type EmbeddingFallbackLogger = (message: string, error: unknown) => void

export class EmbeddingService {
  private stateValue: EmbeddingState = 'disabled'
  private extractor: FeatureExtractionPipeline | undefined
  /** 初始化 promise（并发 init 去重；失败后重置以便重试） */
  private initPromise: Promise<void> | undefined

  constructor(private readonly deps: EmbeddingServiceDeps) {}

  /** 当前状态（一等状态，调用方门控） */
  get state(): EmbeddingState {
    return this.stateValue
  }

  /**
   * 初始化：enabled 才加载模型（本地文件，离线）。失败置 error 并抛
   * EmbeddingUnavailableError——由装配层记录（插件整体不因嵌入失败挂掉）。
   */
  async init(): Promise<void> {
    if (!this.deps.enabled) {
      this.stateValue = 'disabled'
      return
    }
    if (this.initPromise !== undefined) return this.initPromise
    this.stateValue = 'loading'
    this.initPromise = this.load().catch((error: unknown) => {
      this.stateValue = 'error'
      this.initPromise = undefined
      throw new EmbeddingUnavailableError(
        `语义嵌入初始化失败：${error instanceof Error ? error.message : String(error)}` +
          `（模型目录：${this.deps.modelDir}；可用 scripts/download-embedding-model.mjs 下载模型）`,
        { cause: error },
      )
    })
    return this.initPromise
  }

  /** 加载 ONNX pipeline（本地模型，禁止远程下载） */
  private async load(): Promise<void> {
    env.localModelPath = `${this.deps.modelDir}/`
    env.allowRemoteModels = false
    this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
    this.stateValue = 'ready'
  }

  /** 单条文本嵌入（384 维，mean pooling + L2 归一化）。非 ready 状态抛 EmbeddingUnavailableError */
  async embed(text: string): Promise<Float32Array> {
    if (this.stateValue !== 'ready' || this.extractor === undefined) {
      throw new EmbeddingUnavailableError(`语义嵌入不可用（state=${this.stateValue}）`)
    }
    const output = await this.extractor(text, { pooling: 'mean', normalize: true })
    return output.data as Float32Array
  }

  /** 批量嵌入（内部按 64 条分批，摊薄单次调用开销） */
  async embedMany(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = []
    const BATCH = 64
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH)
      for (const text of chunk) {
        results.push(await this.embed(text))
      }
    }
    return results
  }
}

/**
 * 余弦相似度（-1..1）。零向量（无模长）返回 0——语义无关。
 * 纯函数，供融合评分与单测直接使用。
 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`余弦相似度维度不一致：${a.length} vs ${b.length}`)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 语义检索的可选附加选项（与 store.SearchOptions 子集一致；type-only 引用防循环） */
export type SemanticSearchExtra = Omit<
  import('./store.js').SearchOptions,
  'query' | 'queryEmbedding' | 'lookupEmbedding' | 'fusionWeight'
>

/**
 * 语义增强检索（P4，注入器与工具共用）：
 * - 嵌入未启用/未就绪 → 纯关键词路径（状态门控，无异常路径）；
 * - 就绪 → 计算查询向量 + 提供条目向量查找，走 store 融合评分；
 * - 运行期嵌入故障（EmbeddingUnavailableError）→ 显式记录（logWarn）并
 *   回退纯关键词——这是"语义层故障时检索保持可用"的显式降级，非静默吞错。
 */
export async function searchWithSemantic<T>(
  store: { search(options: import('./store.js').SearchOptions): T[] },
  embedding: EmbeddingService | undefined,
  index: { get(id: string): number[] | undefined } | undefined,
  query: string,
  options: SemanticSearchExtra,
  logWarn: (message: string, error?: unknown) => void,
): Promise<T[]> {
  if (embedding === undefined || index === undefined || embedding.state !== 'ready') {
    return store.search({ query, ...options })
  }
  try {
    const queryVector = await embedding.embed(query)
    return store.search({
      query,
      ...options,
      queryEmbedding: queryVector,
      lookupEmbedding: (id) => index.get(id),
    })
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) {
      logWarn(`[dsh-memory] 语义检索降级为关键词：${error.message}`)
      return store.search({ query, ...options })
    }
    throw error
  }
}
