/**
 * 语义嵌入模块单元测试（OPTIMIZATION_PLAN_3 P4）：
 * - cosine 纯函数（正交/同向/零向量/维度不一致）；
 * - EmbeddingService 状态机（disabled/ready/error）与 EmbeddingUnavailableError；
 * - store 语义融合检索（关键词零重合但语义相关可召回；无向量条目只用关键词分）；
 * - EmbeddingIndex 持久化与畸形向量跳过。
 * 单测不加载真实 ONNX 模型（22MB）——用假 pipeline 注入。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EmbeddingIndex } from '../src/embed-index.js'
import { EmbeddingService, EmbeddingUnavailableError, cosine, remoteEmbedFetch, resolveApiKey } from '../src/embedding.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeTable } from './helpers.js'

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

  it('运行期远程 embed 失败 → 回退本地后端重试成功', async () => {
    let remoteCalls = 0
    const service = new EmbeddingService({
      modelDir: '/models',
      remote: remoteConfig,
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
    // 首次 embed 远程失败 → 回退本地成功（维度切换为 384）
    const v = await service.embed('测试')
    expect(v).toHaveLength(384)
    expect(service.dimension).toBe(384)
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
})

describe('EmbeddingIndex', () => {
  let dir: string

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'embed-index-'))
    const file = join(dir, 'memory-embeddings.json')
    const warns: string[] = []
    const service = {
      state: 'ready',
      dimension: 384,
      // 384 维假向量：首位 = 文本长度（通过维度校验）
      embed: async (text: string) => {
        const v = new Float32Array(384)
        v[0] = text.length
        return v
      },
    }
    const index = new EmbeddingIndex({
      file,
      service,
      listAll: () => [] as MemoryEntry[],
      logWarn: (message: string) => warns.push(message),
    })
    return { file, index, warns }
  }

  it('load 缺失文件 = 空索引（正常首启状态）', async () => {
    const { index } = await setup()
    await index.load()
    expect(index.get('任意id')).toBeUndefined()
  })

  it('持久化 round-trip：indexEntry 后可从新实例读回', async () => {
    const { file, index, warns } = await setup()
    const entry = {
      id: 'm-1',
      content: '测试内容',
    } as unknown as MemoryEntry
    index.indexEntry(entry)
    // R2 去抖持久化：轮询 flush（embedOne 完成置 dirty 后落盘；flush 幂等）
    const { readFile } = await import('node:fs/promises')
    let raw: string | undefined
    for (let i = 0; i < 20; i++) {
      await index.flush()
      try {
        raw = await readFile(file, 'utf8')
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(raw).toBeDefined()
    const reloaded = new EmbeddingIndex({
      file,
      service: { state: 'ready', dimension: 384, embed: async () => new Float32Array(384) },
      listAll: () => [],
      logWarn: () => {},
    })
    await reloaded.load()
    const vector = reloaded.get('m-1')
    // '测试内容'.length = 4 → 首位 4，其余 0
    expect(vector?.[0]).toBe(4)
    expect(vector?.slice(1).every((n) => n === 0)).toBe(true)
  })

  it('畸形向量（维度错误）被跳过并告警', async () => {
    const { file, index, warns } = await setup()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, JSON.stringify({ bad: [1, 2, 3] }), 'utf8')
    await index.load()
    expect(index.get('bad')).toBeUndefined()
    expect(warns.some((message) => message.includes('畸形'))).toBe(true)
  })

  it('损坏 JSON 文件 load 降级为空索引并告警（P0-1：不抛致命错误）', async () => {
    const { file, index, warns } = await setup()
    const { writeFile } = await import('node:fs/promises')
    // 半截写入（并发 rename 竞态的产物）——JSON 无法 parse
    await writeFile(file, '{"m-1":[0.1,0.2,', 'utf8')
    await expect(index.load()).resolves.toBeUndefined()
    expect(index.get('m-1')).toBeUndefined()
    expect(warns.some((message) => message.includes('损坏') || message.includes('解析'))).toBe(true)
  })

  it('并发 indexEntry 持久化串行互斥：最终文件完整可解析（P0-1 竞态回归）', async () => {
    const { file, index } = await setup()
    // 慢嵌入制造并发窗口：多条 fire-and-forget 同时进入 embedOne → persist
    // （10ms/条：全量并行跑时留足时序余量，防轮询超时误报）
    const slow = new EmbeddingIndex({
      file,
      service: {
        state: 'ready',
        dimension: 384,
        embed: async (text: string) => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          const v = new Float32Array(384)
          v[0] = text.length
          return v
        },
      },
      listAll: () => [] as MemoryEntry[],
      logWarn: () => {},
    })
    const entries = Array.from({ length: 8 }, (_, i) => ({
      id: `m-${i}`,
      content: `内容${i}`,
    })) as unknown as MemoryEntry[]
    for (const entry of entries) slow.indexEntry(entry)
    // R2 去抖持久化：轮询 flush + 读文件直到全量（flush 幂等；embedOne 完成
    // 置 dirty 后落盘；连续 3 次读到完整内容判定稳定——防最后一次 rename
    // 未落盘时的残留竞态）
    const { readFile } = await import('node:fs/promises')
    let parsed: Record<string, number[]> | undefined
    let stable = 0
    for (let i = 0; i < 300; i++) {
      await slow.flush()
      await new Promise((resolve) => setTimeout(resolve, 25))
      try {
        parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, number[]>
        if (Object.keys(parsed).length === entries.length) {
          stable++
          if (stable >= 3) break
        } else {
          stable = 0
        }
      } catch {
        // 文件未就绪或写入中——继续等
        stable = 0
      }
    }
    expect(parsed).toBeDefined()
    expect(Object.keys(parsed!)).toHaveLength(entries.length)
    // 每条向量可完整读回且维度正确
    for (const entry of entries) {
      expect(parsed![entry.id]).toHaveLength(384)
    }
  })
})
