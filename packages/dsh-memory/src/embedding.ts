/**
 * @module @echocore/dsh-memory/embedding
 *
 * 语义嵌入服务（远程优先，自动回退本地）。
 *
 * 技术选型（2026-08-15 实测 + 网络查证）：
 * - 本地：@huggingface/transformers@4.2.0 + Xenova/all-MiniLM-L6-v2
 *   （q8 量化 21.9MB，384 维）。Node 18+ 官方支持，本机实测单条嵌入中位
 *   2.5ms、批量 1260 条约 1.2s；模型文件本地存放、显式禁止远程下载
 *   （env.allowRemoteModels=false）。
 * - 远程：OpenAI 兼容 /embeddings 端点（查证结论：DeepSeek 官方无 embeddings
 *   API，需另配供应商——硅基流动/阿里云百炼/智谱等国内直连；远程生态无
 *   384 维模型，bge-m3 固定 1024、Qwen3-0.6B 可 512/256/64，维度由配置
 *   `embeddingDimension` 声明，索引按实际维度隔离）。
 *
 * 后端选择（用户拍板：远程优先，自动回退本地，都无则关闭）：
 * 1. 远程配置齐全（baseUrl+apiKey+model 非空）→ 先验证远程（一次短文本嵌入）；
 * 2. 远程验证失败 → 回退本地（模型文件存在性检测）；
 * 3. 本地模型不存在 → disabled（正常禁用态，非错误）；
 * 4. 本地模型存在但加载失败（文件损坏等）→ error（异常，区别于无模型）。
 * 运行期当前后端 embed 失败 → 有下一优先级后端则切换并重试一次，否则抛
 * EmbeddingUnavailableError（调用方显式降级关键词）。
 *
 * 一等状态（非静默兜底）：
 * - `state: 'disabled'`：无可用后端（无远程配置且无本地模型，或远程失败且
 *   无本地模型）——正常禁用态，嵌入不参与检索；
 * - `state: 'loading'`：初始化中；
 * - `state: 'ready'`：可调用 embed（当前后端 remote 或 local）；
 * - `state: 'error'`：初始化异常（后端存在但加载失败）。
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

/** 本地嵌入模型相对路径（transformers.js 按模型 id 拼子目录） */
const LOCAL_MODEL_REL = 'Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx'

/** 本地嵌入维度（all-MiniLM-L6-v2 固定 384；远程维度由配置声明） */
export const LOCAL_EMBEDDING_DIMENSION = 384

/** 嵌入不可用（未启用/未就绪/初始化失败）——显式错误，调用方按状态决策 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EmbeddingUnavailableError'
  }
}

/** 嵌入服务运行状态（一等状态，装配层与调用方据此决策） */
export type EmbeddingState = 'disabled' | 'loading' | 'ready' | 'error'

/** 远程嵌入 API key 环境变量名（用户拍板：apiKey 不落盘配置，从环境变量读取） */
export const EMBEDDING_API_KEY_ENV = 'EMBEDDING_API_KEY'

/** 远程嵌入配置（OpenAI 兼容 /embeddings 端点；apiKey 不在此——环境变量提供） */
export interface RemoteEmbeddingConfig {
  /** 端点 base URL（如 https://api.siliconflow.cn/v1；尾部斜杠自动剥除） */
  baseUrl: string
  /** 模型名（如 BAAI/bge-m3、Qwen/Qwen3-Embedding-0.6B） */
  model: string
  /** 期望输出维度（供应商文档声明；返回维度 ≠ 此值时报错防混维） */
  dimension: number
}

/** 本地嵌入后端接口（pipeline 的窄形态，便于测试注入） */
export interface LocalEmbeddingBackend {
  embed(text: string): Promise<Float32Array>
}

/** 嵌入服务依赖（远程与本地检测均可注入，便于单测） */
export interface EmbeddingServiceDeps {
  /** 本地模型目录（模型文件存在性检测：<dir>/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx） */
  modelDir: string
  /** 远程配置（baseUrl/apiKey/model 全非空才算配置齐；缺省 = 仅本地路径） */
  remote?: RemoteEmbeddingConfig
  /** 本地模型文件存在性检测（默认 fs 检测；测试注入） */
  hasLocalModel?: () => Promise<boolean>
  /** 本地后端加载（默认 ONNX pipeline；测试注入假实现） */
  loadLocalBackend?: () => Promise<LocalEmbeddingBackend>
  /** 远程嵌入调用（默认 fetch OpenAI 兼容端点；测试注入） */
  fetchRemoteEmbeddings?: (input: string[], config: RemoteEmbeddingConfig) => Promise<Float32Array[]>
}

/** 默认本地模型存在性检测：检查 ONNX 模型文件（q8 量化文件为关键件） */
export function defaultHasLocalModel(modelDir: string): () => Promise<boolean> {
  return async () => {
    const { access } = await import('node:fs/promises')
    const { join } = await import('node:path')
    try {
      await access(join(modelDir, LOCAL_MODEL_REL))
      return true
    } catch {
      return false
    }
  }
}

/** 默认本地后端加载：ONNX pipeline（本地文件，禁止远程下载） */
export function defaultLoadLocalBackend(modelDir: string): () => Promise<LocalEmbeddingBackend> {
  return async () => {
    env.localModelPath = `${modelDir}/`
    env.allowRemoteModels = false
    const extractor = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
    })) as FeatureExtractionPipeline
    return {
      async embed(text: string): Promise<Float32Array> {
        const output = await extractor(text, { pooling: 'mean', normalize: true })
        return output.data as Float32Array
      },
    }
  }
}

/** 默认远程嵌入调用：OpenAI 兼容 POST {baseUrl}/embeddings（返回维度强校验） */
export function defaultFetchRemoteEmbeddings(
  input: string[],
  config: RemoteEmbeddingConfig,
): Promise<Float32Array[]> {
  return remoteEmbedFetch(input, config)
}

/** OpenAI 兼容 /embeddings 请求实现（纯函数形态，便于直接单测；apiKey 从环境变量读取） */
export async function remoteEmbedFetch(input: string[], config: RemoteEmbeddingConfig): Promise<Float32Array[]> {
  const apiKey = process.env[EMBEDDING_API_KEY_ENV]
  if (apiKey === undefined || apiKey === '') {
    throw new EmbeddingUnavailableError(`远程嵌入不可用：环境变量 ${EMBEDDING_API_KEY_ENV} 未设置`)
  }
  const base = config.baseUrl.replace(/\/+$/, '')
  const response = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: config.model, input, encoding_format: 'float' }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new EmbeddingUnavailableError(`远程嵌入 API 失败：HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`)
  }
  const payload = (await response.json()) as { data: Array<{ embedding: number[] }> }
  return payload.data.map((item) => {
    // 维度强校验：返回维度 ≠ 配置维度 → 显式报错（同一索引混维会使余弦失真）
    if (item.embedding.length !== config.dimension) {
      throw new EmbeddingUnavailableError(
        `远程嵌入返回维度 ${item.embedding.length} ≠ 配置维度 ${config.dimension}` +
          `（请核对 embeddingDimension 并删除旧嵌入索引重建）`,
      )
    }
    return Float32Array.from(item.embedding)
  })
}

/** 语义检索降级回调（装配层注入 logger；embed 运行期故障时记录并回退关键词） */
export type EmbeddingFallbackLogger = (message: string, error: unknown) => void

export class EmbeddingService {
  private stateValue: EmbeddingState = 'disabled'
  /** 当前后端（remote 优先；运行期失败切换 local） */
  private backend: 'remote' | 'local' | undefined
  private localBackend: LocalEmbeddingBackend | undefined
  /** 当前后端输出维度（remote = 配置值；local = 384；索引按此隔离） */
  private dimensionValue: number = LOCAL_EMBEDDING_DIMENSION
  /** 初始化 promise（并发 init 去重；失败后重置以便重试） */
  private initPromise: Promise<void> | undefined

  private readonly hasLocalModel: () => Promise<boolean>
  private readonly loadLocalBackend: () => Promise<LocalEmbeddingBackend>
  private readonly fetchRemoteEmbeddings: (input: string[], config: RemoteEmbeddingConfig) => Promise<Float32Array[]>

  constructor(private readonly deps: EmbeddingServiceDeps) {
    this.hasLocalModel = deps.hasLocalModel ?? defaultHasLocalModel(deps.modelDir)
    this.loadLocalBackend = deps.loadLocalBackend ?? defaultLoadLocalBackend(deps.modelDir)
    this.fetchRemoteEmbeddings = deps.fetchRemoteEmbeddings ?? ((input, config) => defaultFetchRemoteEmbeddings(input, config))
  }

  /** 当前状态（一等状态，调用方门控） */
  get state(): EmbeddingState {
    return this.stateValue
  }

  /** 当前后端输出维度（local=384；remote=配置值；disabled 时为 384 占位——索引不构建） */
  get dimension(): number {
    return this.dimensionValue
  }

  /** 当前后端标签（日志/状态展示；未就绪时按配置推导） */
  get backendLabel(): string {
    if (this.backend === 'remote') return 'remote'
    if (this.backend === 'local') return 'local'
    return this.deps.remote !== undefined ? 'remote(验证失败)' : 'local'
  }

  /**
   * 初始化：远程优先 → 失败回退本地 → 都无则 disabled（正常态）。
   * 本地模型存在但加载失败 → error 并抛 EmbeddingUnavailableError（异常语义）。
   * 远程验证失败/本地无模型不抛错——"关闭"是用户显式拍板的正常态，仅记录原因。
   */
  async init(): Promise<void> {
    if (this.initPromise !== undefined) return this.initPromise
    this.stateValue = 'loading'
    this.initPromise = this.bootstrap().catch((error: unknown) => {
      this.stateValue = 'error'
      this.initPromise = undefined
      throw new EmbeddingUnavailableError(
        `语义嵌入初始化失败：${error instanceof Error ? error.message : String(error)}` +
          `（模型目录：${this.deps.modelDir}；可用 scripts/download-embedding-model.mjs 下载本地模型）`,
        { cause: error },
      )
    })
    return this.initPromise
  }

  /** 后端引导：按「远程 → 本地」优先级尝试，第一个成功即 ready */
  private async bootstrap(): Promise<void> {
    const remote = this.deps.remote
    if (remote !== undefined) {
      try {
        // 远程优先：一次短文本验证（配置/网络/鉴权/维度全链路）
        await this.fetchRemoteEmbeddings(['验证'], remote)
        this.backend = 'remote'
        this.dimensionValue = remote.dimension
        this.stateValue = 'ready'
        return
      } catch {
        // 远程验证失败 → 回退本地（若本地模型存在）
      }
    }
    if (await this.hasLocalModel()) {
      this.localBackend = await this.loadLocalBackend() // 失败上抛 → init 转 error
      this.backend = 'local'
      this.dimensionValue = LOCAL_EMBEDDING_DIMENSION
      this.stateValue = 'ready'
      return
    }
    // 无远程可用且无本地模型：正常禁用态（不抛错）
    this.stateValue = 'disabled'
  }

  /** 单条文本嵌入（当前后端维度）。非 ready 状态抛 EmbeddingUnavailableError */
  async embed(text: string): Promise<Float32Array> {
    if (this.stateValue !== 'ready') {
      throw new EmbeddingUnavailableError(`语义嵌入不可用（state=${this.stateValue}）`)
    }
    return this.embedWithFallback([text]).then((vectors) => vectors[0]!)
  }

  /** 批量嵌入（内部按 64 条分批，摊薄单次调用开销） */
  async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (this.stateValue !== 'ready') {
      throw new EmbeddingUnavailableError(`语义嵌入不可用（state=${this.stateValue}）`)
    }
    const results: Float32Array[] = []
    const BATCH = 64
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH)
      results.push(...(await this.embedWithFallback(chunk)))
    }
    return results
  }

  /**
   * 带运行期回退的嵌入：当前后端失败 → 有下一优先级后端则切换并重试一次
   * （用户拍板"自动回退"的运行期形态）；无后备则抛错（调用方显式降级关键词）。
   */
  private async embedWithFallback(texts: string[]): Promise<Float32Array[]> {
    try {
      if (this.backend === 'remote' && this.deps.remote !== undefined) {
        return await this.fetchRemoteEmbeddings(texts, this.deps.remote)
      }
      if (this.backend === 'local' && this.localBackend !== undefined) {
        const vectors: Float32Array[] = []
        for (const text of texts) vectors.push(await this.localBackend.embed(text))
        return vectors
      }
      throw new EmbeddingUnavailableError(`语义嵌入不可用（state=${this.stateValue}）`)
    } catch (error) {
      // 运行期故障回退：remote 失败且有本地模型 → 按需加载本地后端，切 local 重试一次。
      // 初始化走远程成功时本地后端未加载（bootstrap 早退）——此处按需加载；
      // 本地加载失败（模型损坏）则随本错误上抛（外层包装为 EmbeddingUnavailableError）。
      if (this.backend === 'remote' && this.deps.remote !== undefined && (await this.hasLocalModel())) {
        this.localBackend ??= await this.loadLocalBackend()
        this.backend = 'local'
        this.dimensionValue = LOCAL_EMBEDDING_DIMENSION
        const vectors: Float32Array[] = []
        for (const text of texts) vectors.push(await this.localBackend.embed(text))
        return vectors
      }
      if (error instanceof EmbeddingUnavailableError) throw error
      throw new EmbeddingUnavailableError(`嵌入失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
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
  'query' | 'queryEmbedding' | 'lookupEmbedding'
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
