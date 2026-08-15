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
import { EmbeddingService, EmbeddingUnavailableError, cosine, resolveApiKey } from '../src/embedding.js'
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
    // 等 fire-and-forget 落地（embed 是 async——轮询文件）
    for (let i = 0; i < 20; i++) {
      try {
        await readFile(file, 'utf8')
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
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
    // 等全部落地（8 × 10ms 串行化后约 80ms；轮询文件内容达到 8 条或超时）
    const { readFile } = await import('node:fs/promises')
    let parsed: Record<string, number[]> | undefined
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      try {
        parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, number[]>
        if (Object.keys(parsed).length === entries.length) break
      } catch {
        // 文件未就绪或写入中——继续等
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
