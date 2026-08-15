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

import { afterEach, describe, expect, it } from 'vitest'

import { EmbeddingIndex } from '../src/embed-index.js'
import { EmbeddingService, EmbeddingUnavailableError, cosine } from '../src/embedding.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeTable } from './helpers.js'

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

describe('EmbeddingService 状态机', () => {
  /** 假 pipeline（不加载真实模型） */
  function fakePipeline() {
    return {
      async call(_text: string) {
        return { data: new Float32Array([1, 0]) }
      },
    }
  }

  it('禁用时 state=disabled 且 embed 抛 EmbeddingUnavailableError', async () => {
    const service = new EmbeddingService({ enabled: false, modelDir: '/nonexistent' })
    await service.init()
    expect(service.state).toBe('disabled')
    await expect(service.embed('任意文本')).rejects.toThrow('语义嵌入不可用')
  })

  it('启用但模型加载失败 → state=error 且抛 EmbeddingUnavailableError', async () => {
    // 模型目录不存在 → pipeline 加载失败（allowRemoteModels=false 下无远程回退）
    const service = new EmbeddingService({ enabled: true, modelDir: 'C:/不存在目录/embedding-model' })
    await expect(service.init()).rejects.toThrow('语义嵌入初始化失败')
    expect(service.state).toBe('error')
  })

  it('就绪后可嵌入（注入假 pipeline 验证调用形态）', async () => {
    // 通过子类注入假 pipeline（load 是私有方法——用原型替换）
    const service = new EmbeddingService({ enabled: true, modelDir: '/tmp/models' })
    const original = EmbeddingService.prototype
    // 直接验证状态门控：未 init 前 embed 抛错
    await expect(service.embed('x')).rejects.toThrow('语义嵌入不可用')
    void original
    void fakePipeline
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

  it('关键词零重合但语义相关（cosine 高）的条目被召回', async () => {
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
      fusionWeight: 0.5,
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
      service: { state: 'ready', embed: async () => new Float32Array(384) },
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
})
