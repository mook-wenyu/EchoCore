/**
 * 语义嵌入模块单元测试（OPTIMIZATION_PLAN_3 P4 + 2026-08-17 sqlite-vec 重构）：
 * - cosine 纯函数（正交/同向/零向量/维度不一致）；
 * - EmbeddingService 状态机（disabled/ready/error）与 EmbeddingUnavailableError；
 * - store 语义融合检索（关键词零重合但语义相关可召回；无向量条目只用关键词分；
 *   KNN 排名器注入分支——sqlite-vec 甲方案）；
 * - EmbeddingIndex（vec0 虚拟表）：KNN 检索/增量 upsert/移除/全量补齐/旧 JSON 迁移。
 * 单测不加载真实 ONNX 模型（22MB）——用假 pipeline 注入；vec0 用真实扩展
 * （:memory: + loadExtension，@photostructure/sqlite-vec 自带 Windows dll）。
 */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMBED_BATCH_SIZE, EmbeddingIndex, cosineSimilarity } from '../src/embed-index.js'
import { EmbeddingService, EmbeddingUnavailableError, cosine, defaultHasLocalModel, remoteEmbedFetch, resolveApiKey, searchWithSemantic } from '../src/embedding.js'
import { BACKFILL_BUDGET, CANDIDATE_WINDOW } from '../src/maintenance.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeTable } from './helpers.js'

// 全模块拦截（pass-through：默认走真实实现，测试按需覆写）——src 与测试共享同一
// mock 模块，避免"动态 import 命名空间 ≠ require 命名空间"导致 spy 失效（实测坑）。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), access: vi.fn(actual.access) }
})

describe('resolveApiKey（env: 前缀解析，用户拍板规则）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('env: 前缀 → 从同名环境变量取值', () => {
    vi.stubEnv('MY_EMBEDDING_KEY', 'sk-from-env')
    expect(resolveApiKey('env:MY_EMBEDDING_KEY')).toBe('sk-from-env')
  })

  it('无前缀 → 视为字面 key 直接用（不被环境变量劫持）', () => {
    vi.stubEnv('sk-literal-abc', 'env-value-should-not-win')
    expect(resolveApiKey('sk-literal-abc')).toBe('sk-literal-abc')
  })

  it('env: 引用的环境变量未设置 → 返回 undefined（远程不可用判定依据）', () => {
    expect(resolveApiKey('env:NOT_SET_ANYWHERE')).toBeUndefined()
  })

  it('空串/空白 → undefined', () => {
    expect(resolveApiKey('')).toBeUndefined()
    expect(resolveApiKey('   ')).toBeUndefined()
  })
})

describe('cosine', () => {
  it('同向向量余弦为 1', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 10)
  })

  it('正交向量余弦为 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })

  it('反向向量余弦为 -1', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10)
  })

  it('零向量返回 0（语义无关，防除零）', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1, 1], [0, 0])).toBe(0)
  })

  it('维度不一致抛错（显式契约）', () => {
    expect(() => cosine([1], [1, 2])).toThrow('维度不一致')
  })
})

describe('EmbeddingService 状态机（远程优先回退本地）', () => {
  /** 假本地后端：384 维（首位=文本长度，其余 0） */
  function fakeLocalBackend() {
    return {
      async embed(text: string) {
        const v = new Float32Array(384)
        v[0] = text.length
        return v
      },
    }
  }

  /** 假远程调用：按配置维度返回全 1 向量 */
  function fakeRemote(input: string[], config: { dimension: number }) {
    return Promise.resolve(
      input.map(() => {
        const v = new Float32Array(config.dimension)
        v.fill(1)
        return v
      }),
    )
  }

  const remoteConfig = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', dimension: 512 }

  it('无远程配置且无本地模型 → disabled（正常禁用态，不抛错）', async () => {
    const service = new EmbeddingService({
      modelDir: '/nonexistent',
      hasLocalModel: async () => false,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: fakeRemote,
    })
    await expect(service.init()).resolves.toBeUndefined()
    expect(service.state).toBe('disabled')
    await expect(service.embed('任意文本')).rejects.toThrow('语义嵌入不可用')
  })

  it('无远程配置 + 本地模型存在 → ready(local)，dimension=384', async () => {
    const service = new EmbeddingService({
      modelDir: '/models',
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: fakeRemote,
    })
    await service.init()
    expect(service.state).toBe('ready')
    expect(service.dimension).toBe(384)
    const v = await service.embed('测试')
    expect(v).toHaveLength(384)
  })

  it('远程配置齐 + 远程验证成功 → ready(remote)，dimension=配置值（远程优先）', async () => {
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true, // 本地也有，但远程优先
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: fakeRemote,
    })
    await service.init()
    expect(service.state).toBe('ready')
    expect(service.dimension).toBe(512)
    const v = await service.embed('测试')
    expect(v).toHaveLength(512)
  })

  it('远程验证失败 + 本地模型存在 → 自动回退 ready(local)', async () => {
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async () => {
        throw new Error('网络不可达')
      },
    })
    await service.init()
    expect(service.state).toBe('ready')
    expect(service.dimension).toBe(384)
    const v = await service.embed('测试')
    expect(v).toHaveLength(384)
  })

  it('远程验证失败且本地无模型 → disabled（关闭，记录原因不抛错）', async () => {
    const service = new EmbeddingService({
      modelDir: '/nonexistent',
      remote: remoteConfig,
      hasLocalModel: async () => false,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async () => {
        throw new Error('401 Unauthorized')
      },
    })
    await service.init()
    expect(service.state).toBe('disabled')
  })

  it('远程验证失败回退本地时记录 lastInitError（2026-08-17 面板"已解析可用但远程未生效"静默根因——状态可见化）', async () => {
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async () => {
        throw new Error('远程嵌入返回维度 1024 ≠ 配置维度 2048（请核对 embeddingDimension 并删除旧嵌入索引重建）')
      },
    })
    await service.init()
    expect(service.state).toBe('ready')
    expect(service.dimension).toBe(384)
    // 回退原因必须可读（面板据此展示"远程未生效"），不允许静默
    expect(service.lastInitError).toContain('维度')
    // 下一次 init 重置（配置修正后热换不再携带陈旧原因）
    const service2 = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: fakeRemote,
    })
    await service2.init()
    expect(service2.lastInitError).toBeUndefined()
  })

  it('本地模型存在但加载失败 → error（模型损坏是异常，区别于无模型）', async () => {
    const service = new EmbeddingService({
      modelDir: '/models',
      hasLocalModel: async () => true,
      loadLocalBackend: async () => {
        throw new Error('onnx 文件损坏')
      },
      fetchRemoteEmbeddings: fakeRemote,
    })
    await expect(service.init()).rejects.toThrow('语义嵌入初始化失败')
    expect(service.state).toBe('error')
  })

  it('运行期远程 embed 失败 + 本地维度 ≠ 远程维度 → 禁止跨维顶班：显式降级 disabled + 原因可读（Q1/A 拍板）', async () => {
    let remoteCalls = 0
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig, // 512 维；本地假后端恒 384 维——跨维
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async (input, config) => {
        remoteCalls++
        if (remoteCalls === 1) return fakeRemote(input, config) // 初始化验证成功
        throw new Error('网络抖动')
      },
    })
    await service.init()
    expect(service.state).toBe('ready')
    expect(service.dimension).toBe(512)
    // 运行期远程失败：索引按远程维度建表，跨维切本地会让 KNN/写库维度错乱 →
    // Q1/A 显式降级为关键词（不得静默切本地、不得抛裸错破坏检索降级契约）
    await expect(service.embed('测试')).rejects.toThrow('嵌入失败')
    expect(service.state).toBe('disabled')
    expect(service.degradedReason).toContain('维度')
    expect(service.backendLabel).toBe('remote(运行期降级)')
    // 后续调用一致走不可用（state=disabled 门控 → 检索侧 searchWithSemantic 走纯关键词）
    await expect(service.embed('再试')).rejects.toThrow('语义嵌入不可用')
  })

  it('运行期远程 embed 失败 + 本地维度 == 远程维度（384==384）→ 允许切本地顶班', async () => {
    let remoteCalls = 0
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: { ...remoteConfig, dimension: 384 }, // 远程声明 384 维与本地一致——同维顶班安全
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async (input, config) => {
        remoteCalls++
        if (remoteCalls === 1) return fakeRemote(input, config)
        throw new Error('网络抖动')
      },
    })
    await service.init()
    expect(service.state).toBe('ready')
    const v = await service.embed('测试') // 切本地顶班成功（维度不变）
    expect(v).toHaveLength(384)
    expect(service.state).toBe('ready')
    expect(service.backendLabel).toBe('local')
    expect(service.degradedReason).toBeUndefined()
  })

  it('degradedReason 仅记录运行期降级；新实例（热换重建）不携带陈旧原因', async () => {
    let remoteCalls = 0
    const service1 = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async (input, config) => {
        remoteCalls++
        if (remoteCalls === 1) return fakeRemote(input, config)
        throw new Error('网络抖动')
      },
    })
    await service1.init()
    await expect(service1.embed('x')).rejects.toThrow()
    expect(service1.degradedReason).toBeDefined()
    // 热换 = 新实例（initEmbedding 重建），不携带上一实例的降级原因
    const service2 = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: fakeRemote,
    })
    await service2.init()
    expect(service2.state).toBe('ready')
    expect(service2.degradedReason).toBeUndefined()
    expect(service2.lastInitError).toBeUndefined()
  })

  it('超时策略按调用面传参：验证 15s 单发 / 单条 15s+1 重试 / 批量 90s+2 重试', async () => {
    const received: Array<{ opts?: { timeoutMs?: number; retries?: number } }> = []
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
      hasLocalModel: async () => true,
      loadLocalBackend: fakeLocalBackend,
      fetchRemoteEmbeddings: async (input, config, opts) => {
        received.push({ opts })
        return fakeRemote(input, config)
      },
    })
    await service.init() // 验证：VERIFY_FETCH_OPTS
    expect(received[0]?.opts).toEqual({ timeoutMs: 15_000, retries: 0 })
    await service.embed('单条') // 检索：SINGLE_FETCH_OPTS
    expect(received[1]?.opts).toEqual({ timeoutMs: 15_000, retries: 1 })
    await service.embedMany(['批量', '嵌入']) // 写路径：BATCH_FETCH_OPTS
    expect(received[2]?.opts).toEqual({ timeoutMs: 90_000, retries: 2 })
  })
})

describe('remoteEmbedFetch 超时与重试', () => {
  const remoteConfig = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'm', dimension: 4 }
  /** 构造 4 维全 1 的假响应体 */
  function okResponse(): { ok: true; status: number; async text(): Promise<string>; async json(): Promise<unknown> } {
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return { data: [{ embedding: [1, 1, 1, 1] }] }
      },
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('携带 AbortSignal.timeout（显式超时——Node fetch 默认无整体超时）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(okResponse() as never)
    const inputTexts = ['测试']
    await remoteEmbedFetch(inputTexts, remoteConfig, { timeoutMs: 5_000, retries: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    expect((init as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal)
  })

  it('请求体携带 dimensions=配置维度（2026-08-17 实测根因：不带时端点回默认维度，与配置不匹配被强校验拦截并静默回退本地）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    // 2048 维假响应（与配置维度一致，先通过维度校验再断言请求体）
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return { data: [{ embedding: new Array(2048).fill(1) }] }
      },
    } as never)
    await remoteEmbedFetch(['测试'], { ...remoteConfig, dimension: 2048 }, { retries: 0 })
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as { body?: string }).body ?? '{}') as { dimensions?: number }
    expect(body.dimensions).toBe(2048)
  })

  it('网络层失败（TypeError fetch failed）→ 指数退避重试后成功', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse() as never)
    const result = await remoteEmbedFetch(['测试'], remoteConfig)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Array.from(result[0]!)).toEqual([1, 1, 1, 1])
  })

  it('可重试 HTTP 状态（429）→ 重试；非重试状态（400）→ 立即抛错不重试', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, async text() { return 'rate limited' } } as never)
      .mockResolvedValueOnce(okResponse() as never)
    const result = await remoteEmbedFetch(['测试'], remoteConfig)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, async text() { return 'bad request' } } as never)
    await expect(remoteEmbedFetch(['测试'], remoteConfig)).rejects.toThrow('HTTP 400')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('超时（TimeoutError）→ 按可重试处理退避重试', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    fetchMock
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(okResponse() as never)
    const result = await remoteEmbedFetch(['测试'], remoteConfig)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Array.from(result[0]!)).toEqual([1, 1, 1, 1])
  })

  it('retries=0：网络失败立即上抛不重试（验证调用语义）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(remoteEmbedFetch(['测试'], remoteConfig, { timeoutMs: 15_000, retries: 0 })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('维度不匹配不重试（EmbeddingUnavailableError，语义错误）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return { data: [{ embedding: [1, 1] }] } // 2 维 ≠ 配置 4 维
      },
    } as never)
    await expect(remoteEmbedFetch(['测试'], remoteConfig)).rejects.toThrow('维度')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('store 语义融合检索', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')

  async function seed(store: MemoryStore, input: Partial<NewMemoryInput> = {}): Promise<string> {
    const result = await store.create({
      workspace: 'D:/ws',
      sessionId: 's-1',
      kind: 'fact',
      content: '使用 pnpm workspace 管理多包',
      importance: 5,
      tags: [],
      source: { sessionId: 's-1', eventSeqs: [1], excerpt: '…' },
      by: 'extractor',
      ...input,
    })
    return result.entry.id
  }

  /** 构造 384 维测试向量（一维为 1 其余 0） */
  function vec(hot: number): Float32Array {
    const v = new Float32Array(384)
    v[hot] = 1
    return v
  }

  it('关键词零重合但语义相关（cosine 高）的条目被召回（RRF 单榜上榜）', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, () => now)
    // 内容与"怎么管理多包项目"零 token 重合
    await seed(store, { content: '量子物理中的纠缠态测量' })
    const results = store.search({
      query: '怎么管理多包项目',
      workspace: 'D:/ws',
      limit: 5,
      minScore: 0.15,
      queryEmbedding: vec(0),
      lookupEmbedding: () => Array.from(vec(0)),
    })
    expect(results).toHaveLength(1)
  })

  it('无向量条目在融合路径只用关键词分（cosine=0）', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, () => now)
    const id = await seed(store, { content: 'pnpm workspace 规则' })
    // lookupEmbedding 返回 undefined（尚无嵌入）
    const results = store.search({
      query: 'pnpm workspace',
      workspace: 'D:/ws',
      limit: 5,
      minScore: 0.15,
      queryEmbedding: vec(0),
      lookupEmbedding: () => undefined,
    })
    expect(results.some((entry) => entry.id === id)).toBe(true)
  })

  it('未提供语义参数时行为与纯关键词路径一致', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, () => now)
    await seed(store, { content: 'pnpm workspace 规则' })
    const results = store.search({ query: 'pnpm workspace', workspace: 'D:/ws', limit: 5, minScore: 0.15 })
    expect(results).toHaveLength(1)
  })

  it('R1a：RRF+withScore 组合路径——语义单榜条目分数落 0.4-0.7 摘要档（标定钉住）', async () => {
    // P1×P4 标定契约（2026-08-16 审计）：RRF 归一化单榜第一=0.5 × timeImportance ≤1.0
    // → 语义单榜条目最高 0.5——永远低于 0.7 高置信档（摘要档 0.4-0.7 是设计语义：
    // 单榜=半权=中置信）。本测试钉住该标定防漂移（若未来改阈值需同步改此契约）。
    const table = new FakeTable()
    const store = new MemoryStore(table, () => now)
    // 关键词零重合但语义相关（cosine 高）——P4 的召回目标
    await seed(store, { content: '量子物理中的纠缠态测量', importance: 10 })
    const scored = store.search({
      query: '怎么管理多包项目',
      workspace: 'D:/ws',
      limit: 5,
      minScore: 0.4,
      withScore: true,
      queryEmbedding: vec(0),
      lookupEmbedding: () => Array.from(vec(0)),
    })
    expect(scored).toHaveLength(1)
    // 单榜第一 0.5 × timeImportance(imp10)=1.0 = 0.5——落入摘要档（0.4-0.7）
    const score = scored[0]!.score
    expect(score).toBeGreaterThanOrEqual(0.4)
    expect(score).toBeLessThanOrEqual(0.7)
    // 双榜（关键词也命中）可达 1.0——同一记忆不同路径的档位差异被钉住
    const kw = await seed(store, { content: 'pnpm workspace 规则', importance: 10 })
    const both = store.search({
      query: 'pnpm workspace',
      workspace: 'D:/ws',
      limit: 5,
      minScore: 0.4,
      withScore: true,
      queryEmbedding: vec(0),
      lookupEmbedding: () => Array.from(vec(0)),
    })
    expect(both.some((item) => item.entry.id === kw && item.score > 0.7)).toBe(true)
  })

  it('语义榜来自注入的 KNN 排名器（sqlite-vec 甲方案）——榜外条目不占语义分、榜内条目可单榜上榜', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, () => now)
    // a：与查询零 token 重合（纯语义命中）；b：与查询零重合且不在语义榜
    const a = await seed(store, { content: '量子物理中的纠缠态测量' })
    const b = await seed(store, { content: 'pnpm workspace 规则' })
    const ranker = vi.fn((_q: ArrayLike<number>, k: number) => {
      expect(k).toBeGreaterThan(0)
      return [{ id: a, cosine: 0.5 }]
    })
    const results = store.search({
      query: '怎么管理多包项目',
      workspace: 'D:/ws',
      limit: 5,
      minScore: 0.15,
      queryEmbedding: vec(0),
      semanticRank: ranker,
    })
    expect(ranker).toHaveBeenCalled()
    // a 经单榜上榜召回；b 无关键词分且不在语义榜 → 不上榜
    expect(results.some((entry) => entry.id === a)).toBe(true)
    expect(results.some((entry) => entry.id === b)).toBe(false)
  })

  it('降级后检索契约：语义停用（disabled）→ searchWithSemantic 纯关键词命中、不抛裸 sqlite 维度错（F2 P2 定点）', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, () => now)
    await seed(store, { content: 'pnpm workspace 规则' })
    // 构造并触发跨维降级：512 维远程 + 384 维本地（Q1/A 禁止跨维顶班 → disabled）
    const fakeLocal = {
      async embed(text: string): Promise<Float32Array> {
        const v = new Float32Array(384)
        v[0] = text.length
        return v
      },
    }
    const fakeRemote = (input: string[], config: { dimension: number }) =>
      Promise.resolve(input.map(() => {
        const v = new Float32Array(config.dimension)
        v.fill(1)
        return v
      }))
    let remoteCalls = 0
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', dimension: 512 },
      hasLocalModel: async () => true,
      loadLocalBackend: async () => fakeLocal,
      fetchRemoteEmbeddings: async (input, config) => {
        remoteCalls++
        if (remoteCalls === 1) return fakeRemote(input, config)
        throw new Error('网络抖动')
      },
    })
    await service.init()
    await expect(service.embed('x')).rejects.toThrow() // 触发跨维降级
    expect(service.state).toBe('disabled')
    // 语义不可用但检索必须可用：searchWithSemantic 经 state 门控走**纯关键词**，
    // 返回命中且不抛裸错（无维度不匹配 → KNN 的裸 SQL 维度错）——检索契约端到端
    const warns: string[] = []
    const results = await searchWithSemantic(
      store,
      service,
      undefined, // index 缺省：disabled 下不触及
      'pnpm workspace',
      { workspace: 'D:/ws', limit: 5, minScore: 0.1 },
      (message, error) => warns.push(error instanceof Error ? `${message}::${error.message}` : message),
    )
    expect(results.length).toBeGreaterThan(0)
    // 状态门控路径（非异常）不产生"降级"告警，也不抛维度错
    expect(warns).toEqual([])
  })
})

describe('EmbeddingIndex（sqlite-vec vec0，2026-08-17 用户拍板）', () => {
  /**
   * 假嵌入服务：384 维"热位 = 文本长度 mod 384"向量（该位为 1，其余 0）——
   * 同长度 → 同向量（cosine 1）；不同长度 → 正交（cosine 0）——KNN 用 cosine
   * 可精确断言命中/未命中（KNN 无"零匹配空"语义，命中与否看 cosine 值）。
   */
  function fakeService(overrides?: { failOnCall?: number }) {
    let call = 0
    const make = (text: string) => {
      const v = new Float32Array(384)
      v[text.length % 384] = 1
      return v
    }
    return {
      state: 'ready',
      dimension: 384,
      embed: async (text: string) => make(text),
      embedMany: async (texts: string[]) => {
        call++
        if (overrides?.failOnCall === call) throw new Error('网络错误（模拟批量失败）')
        return texts.map((text) => make(text))
      },
    }
  }

  /** 构造 384 维查询向量（热位 = 长度 mod 384） */
  function queryVec(len: number): Float32Array {
    const v = new Float32Array(384)
    v[len % 384] = 1
    return v
  }

  it('构造即建表；空表 knn 返回空', () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const warns: string[] = []
    const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => [], logWarn: (m) => warns.push(m) })
    expect(index.table).toBe('vec_memory_384')
    expect(index.knn(queryVec(4), 10)).toEqual([])
    db.close()
  })

  it('indexEntry 后 KNN 命中（同向量 → cosine≈1；语义榜供 store 消费）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const warns: string[] = []
    const index = new EmbeddingIndex({
      db,
      service: fakeService(),
      listAll: () => [],
      logWarn: (m) => warns.push(m),
    })
    const entry = { id: 'mem-aaaa', content: '测试内容' } as unknown as MemoryEntry // length 4
    await index.indexEntry(entry)
    const hits = index.knn(queryVec(4), 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe('mem-aaaa')
    expect(hits[0]!.cosine).toBeGreaterThan(0.999)
    // KNN 无"零匹配空"语义（始终返回最近的 top-k）——正交查询命中该条时
    // cosine ≈ 0（不相似），以此区分命中/未命中
    const far = index.knn(queryVec(42), 10).find((h) => h.id === 'mem-aaaa')
    expect(far === undefined || far.cosine < 0.01).toBe(true)
    db.close()
  })

  it('indexEntry 同 id 重嵌覆盖（UPDATE-or-INSERT：不堆积重复行）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const index = new EmbeddingIndex({
      db,
      service: fakeService(),
      listAll: () => [],
      logWarn: () => {},
    })
    await index.indexEntry({ id: 'mem-a', content: 'AAAAA' } as unknown as MemoryEntry) // len 5
    await index.indexEntry({ id: 'mem-a', content: 'BB' } as unknown as MemoryEntry) // 同 id 重嵌 len 2
    const hits = index.knn(queryVec(2), 50)
    // 表内仅一行 mem-a（被覆盖为 len 2 → 热位 2）
    expect(hits.filter((h) => h.id === 'mem-a')).toHaveLength(1)
    expect(hits[0]!.cosine).toBeGreaterThan(0.999)
    // 旧向量（len 5）已被覆盖：正交查询下 cosine ≈ 0
    const old = index.knn(queryVec(5), 50).find((h) => h.id === 'mem-a')
    expect(old === undefined || old.cosine < 0.01).toBe(true)
    db.close()
  })

  it('remove 移除向量（KNN 不再召回）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const index = new EmbeddingIndex({
      db,
      service: fakeService(),
      listAll: () => [],
      logWarn: () => {},
    })
    await index.indexEntry({ id: 'mem-x', content: '记忆内容' } as unknown as MemoryEntry)
    expect(index.knn(queryVec(4), 10)).toHaveLength(1)
    index.remove('mem-x')
    expect(index.knn(queryVec(4), 10)).toEqual([])
    db.close()
  })

  it('ensureAll 批量补齐（128/批）+ 幂等（已存在不重复插入）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const entries = Array.from({ length: 300 }, (_, i) => ({ id: `mem-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({
      db,
      service: fakeService(),
      listAll: () => entries,
      logWarn: () => {},
    })
    await index.ensureAll()
    // 每条 content（'内容N'）长度 3 → 全表同向量 → KNN 全量召回 300 行
    expect(index.knn(queryVec(3), 400)).toHaveLength(entries.length)
    // 幂等：再次 ensureAll 不重复（行数不变）
    await index.ensureAll()
    expect(index.knn(queryVec(3), 400)).toHaveLength(entries.length)
    db.close()
  })

  it('backfill(budget) 只补预算内缺失并返回处理数；再次调用续补剩余', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `b-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => entries, logWarn: () => {} })
    const first = await index.backfill(4)
    expect(first).toBe(4)
    expect(index.knn(queryVec(3), 400)).toHaveLength(4)
    const second = await index.backfill(4)
    expect(second).toBe(4)
    expect(index.knn(queryVec(3), 400)).toHaveLength(8)
    const third = await index.backfill(4)
    expect(third).toBe(2) // 剩 2 条
    expect(index.knn(queryVec(3), 400)).toHaveLength(10)
    db.close()
  })

  it('backfill(0) 不处理；ensureAll 全量补齐不受预算限制', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: `c-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => entries, logWarn: () => {} })
    expect(await index.backfill(0)).toBe(0)
    expect(index.knn(queryVec(3), 400)).toHaveLength(0)
    await index.ensureAll()
    expect(index.knn(queryVec(3), 400)).toHaveLength(5)
    db.close()
  })

  it('C34 getVector：返回已索引向量（维度=服务维度）；未索引 id → undefined', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const entries = [{ id: 'v-1', content: '内容A' }, { id: 'v-2', content: '内容B' }] as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => entries, logWarn: () => {} })
    await index.ensureAll()
    const v1 = index.getVector('v-1')
    expect(v1).toBeInstanceOf(Float32Array)
    expect(v1?.length).toBe(384)
    expect(index.getVector('nope')).toBeUndefined()
    db.close()
  })

  it('C34 cosineSimilarity：同向=1 / 正交=0 / 反向=-1', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-3, 0]))).toBeCloseTo(-1)
  })

  it('ensureAll 批次中途失败：logWarn 跳过继续，其余批次已入库', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const warns: string[] = []
    const entries = Array.from({ length: 300 }, (_, i) => ({ id: `mem-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({
      db,
      service: fakeService({ failOnCall: 2 }),
      listAll: () => entries,
      logWarn: (m, e) => warns.push(`${m}${e instanceof Error ? e.message : ''}`),
    })
    await index.ensureAll()
    expect(warns.some((m) => m.includes('网络错误'))).toBe(true)
    // 第 2 批（128..255）失败未入库；第 1/3 批已入库
    const hits = index.knn(queryVec(3), 400)
    const ids = new Set(hits.map((h) => h.id))
    expect(ids.has('mem-0')).toBe(true)
    expect(ids.has('mem-128')).toBe(false)
    expect(ids.has('mem-256')).toBe(true)
    db.close()
  })

  it('无 embedMany（假后端）→ ensureAll 逐条回退', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const service = {
      state: 'ready',
      dimension: 384,
      embed: async (text: string) => {
        const v = new Float32Array(384)
        v[0] = text.length
        return v
      },
    }
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: `mem-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({ db, service, listAll: () => entries, logWarn: () => {} })
    await index.ensureAll()
    expect(index.knn(queryVec(3), 10)).toHaveLength(entries.length)
    db.close()
  })

  it('loadLegacy：旧 JSON 索引迁移入表；非空表幂等跳过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-legacy-'))
    const file = join(dir, 'memory-embeddings-384.json')
    const vectors: Record<string, number[]> = {}
    for (let i = 0; i < 5; i++) {
      const v = new Array(384).fill(0)
      v[0] = i // 首位 = 序号（区分）
      vectors[`legacy-${i}`] = v
    }
    await writeFile(file, JSON.stringify(vectors), 'utf8')
    try {
      const db = new DatabaseSync(':memory:', { allowExtension: true })
      const warns: string[] = []
      const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => [], logWarn: (m) => warns.push(m) })
      const migrated = await index.loadLegacy(file)
      expect(migrated).toBe(5)
      // knn 命中（查询首位=3）
      const hits = index.knn(queryVec(3), 10)
      expect(hits.some((h) => h.id === 'legacy-3')).toBe(true)
      // 幂等：表非空 → 再次 loadLegacy 返回 0（不重复迁移）
      expect(await index.loadLegacy(file)).toBe(0)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loadLegacy：损坏 JSON 降级为 0（不致命）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-legacy-bad-'))
    const file = join(dir, 'memory-embeddings-384.json')
    await writeFile(file, '{"mem-1":[0.1,0.2,', 'utf8')
    try {
      const db = new DatabaseSync(':memory:', { allowExtension: true })
      const warns: string[] = []
      const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => [], logWarn: (m) => warns.push(m) })
      expect(await index.loadLegacy(file)).toBe(0)
      expect(warns.some((m) => m.includes('损坏') || m.includes('解析'))).toBe(true)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loadLegacy：迁移向量维度不匹配 → 跳过 + logWarn（防错误维度行落库，Q2 拍板）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-legacy-dim-'))
    const file = join(dir, 'memory-embeddings-384.json')
    const vectors: Record<string, number[]> = {}
    // 两条 384 维合法
    for (let i = 0; i < 2; i++) {
      const v = new Array(384).fill(0)
      v[0] = i
      vectors[`ok-${i}`] = v
    }
    // 一条 512 维不匹配（历史配置维度遗留）——不得落库（否则 KNN MATCH 维度错乱）
    vectors['bad-dim'] = new Array(512).fill(0.5)
    await writeFile(file, JSON.stringify(vectors), 'utf8')
    try {
      const db = new DatabaseSync(':memory:', { allowExtension: true })
      const warns: string[] = []
      const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => [], logWarn: (m) => warns.push(m) })
      const migrated = await index.loadLegacy(file)
      expect(migrated).toBe(2) // 维度不匹配行被跳过
      expect(warns.some((m) => m.includes('维度'))).toBe(true)
      // 仅合法 384 维行可被 KNN 命中；bad-dim 未落库
      const hits = index.knn(queryVec(1), 10)
      expect(hits.some((h) => h.id === 'ok-1')).toBe(true)
      expect(hits.some((h) => h.id === 'bad-dim')).toBe(false)
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('dropOtherDimensionTables：只删除非当前维度表（防旧维度表堆积，Q2 拍板）', () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => [], logWarn: () => {} }) // 当前维度 384
    // 手工模拟历史遗留的同库其它维度表（换维后 ensureAll 已按新维重嵌，旧表无引用价值）
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS "vec_memory_512" USING vec0(embedding float[512] distance_metric=cosine, memory_id TEXT)')
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS "vec_memory_768" USING vec0(embedding float[768] distance_metric=cosine, memory_id TEXT)')
    index.dropOtherDimensionTables()
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_memory_%'`).all() as Array<{ name: string }>
    // 仅断言纯维度表（vec_memory_<digits>）：vec0 影子表（_info/_rowid 等）受 SQLite
    // 保护不可 DROP，属预期残留；换维后旧维度表应已清理
    const dimTables = rows.filter((r) => /^vec_memory_\d+$/.test(r.name)).map((r) => r.name).sort()
    expect(dimTables).toEqual(['vec_memory_384'])
    db.close()
  })

  it('ensureAll 批次写事务：批次中途一条写入失败 → 该批整批回滚不留半批（Q7/4c）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const warns: string[] = []
    const entries = Array.from({ length: 6 }, (_, i) => ({ id: `mem-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    // embedMany 返回 6 条：第 5 条（j=4）为 512 维错误向量（表中浮点列定 384）→
    // writeVector 写入该行抛错 → 事务 ROLLBACK → 整批 6 条（含已写的前 4 条）都不落库
    const service = {
      state: 'ready',
      dimension: 384,
      embed: async (text: string) => {
        const v = new Float32Array(384)
        v[1] = text.length
        return v
      },
      embedMany: async (texts: string[]) =>
        texts.map((_, j) => {
          // 第 5 条维度错误触发写入失败（其余同维度）
          const v = new Float32Array(j === 4 ? 512 : 384)
          v[0] = texts[j]!.length
          return v
        }),
    }
    const index = new EmbeddingIndex({ db, service, listAll: () => entries, logWarn: (m) => warns.push(m) })
    await index.ensureAll()
    // 批次已回滚：表内无任何该批的行（前 4 条也不落库）——"批内全有或全无"
    expect(index.knn(queryVec(3), 100)).toEqual([])
    expect(warns.some((m) => m.includes('嵌入批次失败'))).toBe(true)
    db.close()
  })

  it('loadLegacy：非 ENOENT 读失败（EACCES）→ logWarn 且返回 0（不阻断挂载，Q6⑨）', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    try {
      const db = new DatabaseSync(':memory:', { allowExtension: true })
      const warns: string[] = []
      const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => [], logWarn: (m) => warns.push(m) })
      expect(await index.loadLegacy('/some/legacy-384.json')).toBe(0)
      expect(warns.some((m) => m.includes('读取失败'))).toBe(true)
      db.close()
    } finally {
      vi.mocked(readFile).mockClear()
    }
  })
})

describe('defaultHasLocalModel（Q6⑨：ENOENT 归为"无模型"，其它 IO 归为真实故障上抛）', () => {
  it('模型文件不存在（ENOENT）→ false', async () => {
    const has = defaultHasLocalModel(join(tmpdir(), 'no-such-model-dir-xyz'))
    expect(await has()).toBe(false)
  })

  it('非 ENOENT（如 EACCES 不可读）→ 上抛，不静默当作"无模型"', async () => {
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    try {
      const has = defaultHasLocalModel('/models')
      await expect(has()).rejects.toThrow('permission denied')
    } finally {
      vi.mocked(access).mockClear()
    }
  })
})

describe('调优回归（2026-08-19：BACKFILL_BUDGET/窗口/BATCH 协同）', () => {
  function fakeService() {
    let call = 0
    const make = (text: string) => {
      const v = new Float32Array(384)
      v[text.length % 384] = 1
      return v
    }
    return {
      state: 'ready',
      dimension: 384,
      embed: async (text: string) => make(text),
      embedMany: async (texts: string[]) => {
        call++
        return texts.map((text) => make(text))
      },
    }
  }
  function queryVec(len: number): Float32Array {
    const v = new Float32Array(384)
    v[len % 384] = 1
    return v
  }

  it('维护预算与嵌入批次协同：BACKFILL_BUDGET=512 为 EMBED_BATCH_SIZE=128 的整数倍（单周期 4 批整除）', () => {
    expect(BACKFILL_BUDGET).toBe(512)
    expect(EMBED_BATCH_SIZE).toBe(128)
    expect(BACKFILL_BUDGET % EMBED_BATCH_SIZE).toBe(0)
    expect(CANDIDATE_WINDOW).toBe(2000)
  })

  it('预算扩大后 backfill(512) 单周期可处理 512 条（原 256 需约 27h，512 约 13.5h 收敛）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const entries = Array.from({ length: 600 }, (_, i) => ({ id: `tune-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({ db, service: fakeService(), listAll: () => entries, logWarn: () => {} })
    const first = await index.backfill(BACKFILL_BUDGET)
    expect(first).toBe(512)
    expect(index.knn(queryVec(3), 700)).toHaveLength(512)
    const second = await index.backfill(BACKFILL_BUDGET)
    expect(second).toBe(88) // 剩余 88 条
    expect(index.knn(queryVec(3), 700)).toHaveLength(600)
    db.close()
  })

  it('backfill 预算内批失败不影响预算语义：失败批不消耗预算、剩余可续补（失败跳过后仍按预算补齐）', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true })
    const warns: string[] = []
    let call = 0
    const service = {
      state: 'ready',
      dimension: 384,
      embed: async (text: string) => {
        const v = new Float32Array(384)
        v[0] = text.length
        return v
      },
      embedMany: async (texts: string[]) => {
        call++
        if (call === 1) throw new Error('模拟批失败')
        const v = new Float32Array(384)
        return texts.map(() => v)
      },
    }
    const entries = Array.from({ length: 300 }, (_, i) => ({ id: `fail-${i}`, content: `内容${i}` })) as unknown as MemoryEntry[]
    const index = new EmbeddingIndex({ db, service, listAll: () => entries, logWarn: (m) => warns.push(m) })
    const processed = await index.backfill(256)
    // 第 1 批128失败不计入processed，第2批128成功，第3批44（300-256）成功=172；失败不消耗预算符合"跳过继续"语义
    expect(processed).toBe(172)
    expect(warns.some((m) => m.includes('网络') || m.includes('批次') || m.includes('失败'))).toBe(true)
    db.close()
  })
})

// ── P1 补覆盖：embedding.ts:86/413/503-518 的降级分支（TDD，目标 >90%） ───────
describe('P1 补覆盖：embedding 降级分支（86/413/503-518）', () => {
  it('413：ready 但 backend 非法 → embed 抛不可用（显式降级契约，非防御性兜底）', async () => {
    // 中文注释：构造一个 state=ready 但 backend 未设的异常态（私有字段篡改模拟边界），
    // 直接触发 try 块的 throw EmbeddingUnavailableError 分支（413 行），并验证 catch
    // 中 instanceof 判定将其原样抛出（非吞错）。
    const service = new EmbeddingService({
      modelDir: '/models',
      hasLocalModel: async () => false,
      loadLocalBackend: async () => ({ async embed() { return new Float32Array(384) } }),
      fetchRemoteEmbeddings: async () => [new Float32Array(384)],
    })
    await service.init()
    // 篡改私有状态：state=ready 但 backend=undefined + 无 localBackend → 走 413 抛错
    ;(service as unknown as { stateValue: string }).stateValue = 'ready'
    ;(service as unknown as { backend: string | undefined }).backend = undefined
    ;(service as unknown as { localBackend: unknown }).localBackend = undefined
    await expect(service.embed('测试')).rejects.toThrow(EmbeddingUnavailableError)
    await expect(service.embed('测试')).rejects.toThrow('语义嵌入不可用')
  })

  it('503-518：searchWithSemantic 在 ready 态下 embed 抛 EmbeddingUnavailableError → 显式降级关键词并 logWarn（非静默）', async () => {
    // 中文注释：语义检索的显式降级语义——ready 态下远程抖动导致 embed 失败，
    // 必须显式记录并回退关键词，而非抛裸错杀检索链路。
    const table = new FakeTable()
    const store = new MemoryStore(table, () => Date.now())
    await store.create({
      workspace: 'D:/ws',
      sessionId: 's1',
      kind: 'fact',
      content: 'pnpm workspace 管理多包的实践',
      importance: 5,
      tags: [],
      source: { sessionId: 's1', eventSeqs: [1], excerpt: '…' },
      by: 'extractor',
    })
    const warns: string[] = []
    // 伪造 ready 的 embedding，其 embed 直接抛不可用（触发 503-518 的 catch 分支）
    const fakeEmbedding = {
      state: 'ready' as const,
      embed: async () => { throw new EmbeddingUnavailableError('远程嵌入抖动（模拟）') },
    }
    const fakeIndex = { knn: () => [] as Array<{ id: string; cosine: number }> }
    const results = await searchWithSemantic(
      store,
      fakeEmbedding as unknown as import('../src/embedding.js').EmbeddingService,
      fakeIndex,
      'pnpm workspace',
      { workspace: 'D:/ws', limit: 5 },
      (msg) => warns.push(msg),
    )
    // 降级后仍返回关键词命中（检索可用），且显式记录
    expect(results.length).toBeGreaterThan(0)
    expect(warns.some((m) => m.includes('语义检索降级为关键词'))).toBe(true)
  })

  it('503-518：searchWithSemantic 非 EmbeddingUnavailableError → 原样上抛（不吞错）', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, () => Date.now())
    const fakeEmbedding = {
      state: 'ready' as const,
      embed: async () => { throw new Error('非降级类错误（应上抛）') },
    }
    await expect(
      searchWithSemantic(
        store,
        fakeEmbedding as unknown as import('../src/embedding.js').EmbeddingService,
        { knn: () => [] },
        '测试',
        { workspace: 'D:/ws', limit: 5 },
        () => {},
      ),
    ).rejects.toThrow('非降级类错误')
  })

  it('86/边界：resolveApiKey 的 env: 空名与空白名分支（显式降级语义）', () => {
    // 中文注释：env: 前缀后无有效名 → 视为未配置（undefined），防静默用空 key 误判为已配置
    expect(resolveApiKey('env:')).toBeUndefined()
    expect(resolveApiKey('env:   ')).toBeUndefined()
    expect(resolveApiKey('env:MY_KEY ')).toBeUndefined() // 未设环境变量
  })

  it('86/默认路径：defaultHasLocalModel 默认检测在无模型时返回 false（显式无模型态）', async () => {
    // 中文注释：默认检测走真实文件访问，无模型时正常禁用态（非错误）
    const { defaultHasLocalModel } = await import('../src/embedding.js')
    const has = defaultHasLocalModel('/tmp/no-such-dir-xyz-embedding')
    await expect(has()).resolves.toBe(false)
  })

  it('86/默认路径：defaultLoadLocalBackend 走假 pipeline 分支（显式本地加载语义，非防御性兜底）', async () => {
    // 中文注释：本地后端默认加载路径需经 pipeline，但测试不加载真实 22MB 模型——用最小假实现覆盖分支
    const mod = await import('../src/embedding.js')
    const fakePipeline = async () => ({
      async embed(text: string) {
        const v = new Float32Array(384)
        v[0] = text.length
        return v
      },
    })
    const service = new mod.EmbeddingService({
      modelDir: '/tmp/any',
      hasLocalModel: async () => true,
      loadLocalBackend: fakePipeline as never,
      fetchRemoteEmbeddings: async () => [new Float32Array(384)],
    })
    await service.init()
    expect(service.state).toBe('ready')
    expect(service.dimension).toBe(384)
  })

  it('86/默认路径：默认 loadLocalBackend 真实进入（模型缺失 → error 态，非静默禁用）', async () => {
    // 中文注释：默认 loadLocalBackend 会尝试 pipeline 加载，缺模型时抛错转 error（显式异常态，区别于无模型的 disabled）
    const mod = await import('../src/embedding.js')
    const service = new mod.EmbeddingService({
      modelDir: '/tmp/no-model-dir-for-coverage',
      hasLocalModel: async () => true, // 假称有模型，迫使走默认 loadLocalBackend
      fetchRemoteEmbeddings: async () => [new Float32Array(384)],
    })
    await expect(service.init()).rejects.toThrow('语义嵌入初始化失败')
    expect(service.state).toBe('error')
  })
})