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

/** 远程嵌入 API key 环境变量引用前缀（用户拍板：`env:NAME` = 从环境变量 NAME 取值；无前缀 = 字面 key） */
export const API_KEY_ENV_PREFIX = 'env:'

/**
 * 解析远程嵌入 API key（用户拍板规则，纯函数可单测）：
 * - 配置值以 `env:` 开头 → 取 `env:` 后名字对应的环境变量值；
 * - 无前缀 → 视为字面 key 直接用（字面 key 永不被环境变量劫持）；
 * - 解析结果为空（未配置/环境变量未设/空白）→ undefined（远程不可用判定依据）。
 */
export function resolveApiKey(configured: string): string | undefined {
  const trimmed = configured.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith(API_KEY_ENV_PREFIX)) {
    const name = trimmed.slice(API_KEY_ENV_PREFIX.length).trim()
    if (name === '') return undefined
    const value = process.env[name]
    return value !== undefined && value !== '' ? value : undefined
  }
  return trimmed
}

/** 远程嵌入配置（OpenAI 兼容 /embeddings 端点；apiKey 为原始配置值——含 env: 前缀，运行时解析） */
export interface RemoteEmbeddingConfig {
  /** 端点 base URL（如 https://api.siliconflow.cn/v1；尾部斜杠自动剥除） */
  baseUrl: string
  /** 模型名（如 BAAI/bge-m3、Qwen/Qwen3-Embedding-0.6B） */
  model: string
  /** 期望输出维度（供应商文档声明；返回维度 ≠ 此值时报错防混维） */
  dimension: number
  /** API key 原始配置值（字面 key 或 env:NAME 引用） */
  apiKey: string
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
  /** 远程嵌入调用（默认 fetch OpenAI 兼容端点，带超时+重试；测试注入） */
  fetchRemoteEmbeddings?: (input: string[], config: RemoteEmbeddingConfig, opts?: EmbeddingFetchOptions) => Promise<Float32Array[]>
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

/**
 * 远程嵌入请求选项。
 * 超时与重试依据（2026-08-16 用户拍板 + https://undici.nodejs.org/ + openai-node）：
 * Node fetch 无默认整体超时（undici 连接 10s 固定、响应 300s），挂起端点会让
 * 保存/检索/启动无限等待——必须显式 AbortSignal.timeout。/embeddings 幂等
 * （同输入同向量），可安全重试（连接错误/超时/HTTP 408,409,429,5xx；不重试
 * 4xx 其余——请求语义错误重试无益）。
 */
export interface EmbeddingFetchOptions {
  /** 单次请求超时（毫秒）。默认 90_000（批量写路径）；验证 15_000、单条检索 15_000 */
  timeoutMs?: number
  /** 重试次数（默认 2）。验证用 0（失败立即回退本地——职责是快速判定可用性） */
  retries?: number
}

/** 可重试 HTTP 状态（openai-node 同集） */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])
/** 指数退避基数（毫秒，第 n 次重试前等待；n 从 0 起）+ 随机 jitter ≤200ms */
const RETRY_DELAYS_MS = [1_000, 4_000]
/** 默认批量写路径超时（openai-node 官方 10min 上限之下的务实值：低频单批 64 条） */
export const DEFAULT_REMOTE_TIMEOUT_MS = 90_000
export const DEFAULT_REMOTE_RETRIES = 2
/** 验证调用：15s 单发（失败立即回退本地——验证职责是快速判定可用性，不赌重试） */
export const VERIFY_FETCH_OPTS: EmbeddingFetchOptions = { timeoutMs: 15_000, retries: 0 }
/** 单条检索调用：15s + 1 重试（检索不无限等，但瞬断可恢复——防误降级本地） */
export const SINGLE_FETCH_OPTS: EmbeddingFetchOptions = { timeoutMs: 15_000, retries: 1 }
/** 批量写路径（indexEntry/ensureAll）：90s + 2 重试（瞬断不杀整批） */
export const BATCH_FETCH_OPTS: EmbeddingFetchOptions = { timeoutMs: DEFAULT_REMOTE_TIMEOUT_MS, retries: DEFAULT_REMOTE_RETRIES }

function retryDelayMs(attempt: number): number {
  const base = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
  return base + Math.floor(Math.random() * 200)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 可重试网络层错误：AbortSignal.timeout 超时（DOMException TimeoutError）或 fetch 连接失败（TypeError） */
function isRetryableNetworkError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'TimeoutError') || error instanceof TypeError
}

/** 默认远程嵌入调用：OpenAI 兼容 POST {baseUrl}/embeddings（返回维度强校验；带超时+重试） */
export function defaultFetchRemoteEmbeddings(
  input: string[],
  config: RemoteEmbeddingConfig,
  opts: EmbeddingFetchOptions = {},
): Promise<Float32Array[]> {
  return remoteEmbedFetch(input, config, opts)
}

/** OpenAI 兼容 /embeddings 请求实现（纯函数形态，便于直接单测；apiKey 经 resolveApiKey 解析） */
export async function remoteEmbedFetch(
  input: string[],
  config: RemoteEmbeddingConfig,
  opts: EmbeddingFetchOptions = {},
): Promise<Float32Array[]> {
  const apiKey = resolveApiKey(config.apiKey)
  if (apiKey === undefined) {
    throw new EmbeddingUnavailableError(`远程嵌入不可用：embeddingApiKey 未配置或引用的环境变量未设置（支持字面 key 或 env:NAME）`)
  }
  const base = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_REMOTE_RETRIES
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries
    try {
      const response = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input,
          encoding_format: 'float',
          // 显式声明输出维度（2026-08-17 实测根因：不带 dimensions 时端点回
          // 默认维度（qwen3.7-text-embedding=1024），与配置维度不符被下方强校验
          // 拦截并静默回退本地——面板显示 ready 但远程从未生效）。OpenAI
          // text-embedding-3 与阿里云百炼 qwen3 系列 OpenAI 兼容端点均支持；
          // 老端点若不支持会报 400 → 走既有回退链（明确失败而非静默降级）。
          dimensions: config.dimension,
        }),
        // 显式超时：Node fetch 默认无整体超时，挂起端点会把保存/检索/启动无限卡死
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        // 可重试状态且重试未耗尽 → 退避后重试；否则按 API 错误抛出
        if (canRetry && RETRYABLE_STATUS.has(response.status)) {
          await sleep(retryDelayMs(attempt))
          continue
        }
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
    } catch (error) {
      // 网络层可重试（超时/连接失败）→ 退避重试；非可重试（HTTP 4xx 语义错误/
      // 维度不匹配/JSON 解析失败）立即上抛（调用方回退关键词/本地）
      if (canRetry && isRetryableNetworkError(error)) {
        await sleep(retryDelayMs(attempt))
        continue
      }
      throw error
    }
  }
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
  /**
   * 最近一次初始化期远程验证失败原因（状态可见化，2026-08-17 用户拍板）：
   * bootstrap 远程验证失败回退本地/禁用时记录——面板据此展示"远程未生效"，
   * 不静默降级。每次 init 开始重置（配置修正后热换不携带陈旧原因）。
   */
  lastInitError: string | undefined

  private readonly hasLocalModel: () => Promise<boolean>
  private readonly loadLocalBackend: () => Promise<LocalEmbeddingBackend>
  private readonly fetchRemoteEmbeddings: (
    input: string[],
    config: RemoteEmbeddingConfig,
    opts?: EmbeddingFetchOptions,
  ) => Promise<Float32Array[]>

  constructor(private readonly deps: EmbeddingServiceDeps) {
    this.hasLocalModel = deps.hasLocalModel ?? defaultHasLocalModel(deps.modelDir)
    this.loadLocalBackend = deps.loadLocalBackend ?? defaultLoadLocalBackend(deps.modelDir)
    this.fetchRemoteEmbeddings =
      deps.fetchRemoteEmbeddings ??
      ((input, config, opts) => defaultFetchRemoteEmbeddings(input, config, opts))
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
    // 每次初始化重置陈旧失败原因（配置修正后热换不携带上次的降级原因）
    this.lastInitError = undefined
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
        // 远程优先：一次短文本验证（配置/网络/鉴权/维度全链路）。15s 单发——
        // 验证职责是快速判定可用性，挂起/失败立即回退本地（验证不赌重试）
        await this.fetchRemoteEmbeddings(['验证'], remote, VERIFY_FETCH_OPTS)
        this.backend = 'remote'
        this.dimensionValue = remote.dimension
        this.stateValue = 'ready'
        return
      } catch (error) {
        // 远程验证失败 → 记录原因（状态可见化：面板展示"远程未生效"而非
        // 静默回退本地）→ 按既有优先级回退本地模型（若存在）
        this.lastInitError = error instanceof Error ? error.message : String(error)
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
    // 单条检索：15s + 1 重试（检索不无限等，瞬断可恢复防误降级本地）
    return this.embedWithFallback([text], SINGLE_FETCH_OPTS).then((vectors) => vectors[0]!)
  }

  /** 批量嵌入（内部按 64 条分批，摊薄单次调用开销；90s + 2 重试——瞬断不杀整批） */
  async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (this.stateValue !== 'ready') {
      throw new EmbeddingUnavailableError(`语义嵌入不可用（state=${this.stateValue}）`)
    }
    const results: Float32Array[] = []
    // 内部批次 128（用户拍板 2026-08-17，与 embed-index 的 EMBED_BATCH_SIZE 一致：
    // 全量构建每批恰好一次请求；90s + 2 重试——瞬断不杀整批）
    const BATCH = 128
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH)
      results.push(...(await this.embedWithFallback(chunk, BATCH_FETCH_OPTS)))
    }
    return results
  }

  /**
   * 带运行期回退的嵌入：当前后端失败（重试耗尽后）→ 有下一优先级后端则切换并
   * 重试一次（用户拍板"自动回退"的运行期形态）；无后备则抛错（调用方显式降级
   * 关键词）。超时/连接类失败由 remoteEmbedFetch 内部退避重试，此层只做后端回退。
   */
  private async embedWithFallback(texts: string[], opts?: EmbeddingFetchOptions): Promise<Float32Array[]> {
    try {
      if (this.backend === 'remote' && this.deps.remote !== undefined) {
        return await this.fetchRemoteEmbeddings(texts, this.deps.remote, opts)
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
 * 实时嵌入后端持有者（装配层单例对象——面板保存后原位热换，不重启插件）。
 * 消费方（store 钩子/注入器/工具/状态展示）在**调用时**读 holder 字段：
 * 热换只改 holder 内容，引用不变，无陈旧对象竞态。
 */
export interface EmbeddingHolder {
  /** 当前嵌入服务（未就绪 = undefined） */
  service: EmbeddingService | undefined
  /** 当前嵌入索引（与 service 成对；维度变更时按新维度文件重建） */
  index: import('./embed-index.js').EmbeddingIndex | undefined
}

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
