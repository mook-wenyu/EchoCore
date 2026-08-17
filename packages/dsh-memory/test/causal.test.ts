/**
 * 因果链模块单元测试（TDD）。
 *
 * 覆盖：因果键分隔符、MemoryCausalStore 存取/幂等/装订/归档联动/依据审计、
 * parseCausalEdges 严格解析、抽取器（假 llm）建边与各类拒绝、门控 force 语义、
 * route 缺省回退、批处理自收容。
 *
 * 存储：不用 sqlite——用内存假表（helpers.FakeTable 构造 MemoryStore；
 * 本地泛型 FakeKvTable 构造 MemoryCausalStore），KvTable 契约对齐。
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import {
  MemoryCausalExtractor,
  MemoryCausalStore,
  causalEdgeKey,
  parseCausalEdges,
  type CausalSummary,
} from '../src/causal.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryCausalEdge, MemoryEntry } from '../src/types.js'
import { FakeTable } from './helpers.js'

/** 固定"现在"（避免测试随时间漂移） */
const NOW = Date.UTC(2025, 0, 15, 0, 0, 0)

/** 泛型内存假表（对齐 KvTable 契约；作边表用） */
class FakeKvTable<V> implements KvTable<string, V> {
  private readonly map = new Map<string, V>()
  get(key: string): V | undefined {
    return this.map.get(key)
  }
  entries(): IterableIterator<[string, V]> {
    return [...this.map.entries()][Symbol.iterator]() as IterableIterator<[string, V]>
  }
  keys(): IterableIterator<string> {
    return [...this.map.keys()][Symbol.iterator]() as IterableIterator<string>
  }
  get size(): number {
    return this.map.size
  }
  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

/** 条目工厂：直接种入受控条目（来源/审计等字段按需补全） */
function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const base = {
    workspace: 'D:/ws',
    sessionId: 's1',
    kind: 'fact' as const,
    content: '内容',
    importance: 5,
    tags: [] as string[],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '亲' },
    dedupKey: `key-${overrides.id}`,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastAccessAt: new Date(NOW).toISOString(),
    accessCount: 0,
    status: 'active' as const,
    audit: [{ action: 'create' as const, at: new Date(NOW).toISOString(), by: 'extractor' as const }],
  }
  return { ...base, ...overrides }
}

/** 把一段文本编码为流分片（假 llm 回包用） */
function textStream(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] as StreamChunk[]
}

/** 假 llm：按预设文本分片返回，记录收到的调用参数与文本 */
class FakeLlm {
  calls: Array<{ provider: string; model: string; system: string; messages: unknown[] }> = []
  constructor(private readonly text: string) {}
  async *stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> {
    this.calls.push(options as { provider: string; model: string; system: string; messages: unknown[] })
    for (const chunk of textStream(this.text)) yield chunk
  }
}

/** 组装抽取器：返回 store / causal / extractor / llm / entryTable / edgeTable */
function setupExtractor(llmText: string) {
  const entryTable = new FakeTable()
  const store = new MemoryStore(entryTable, () => NOW)
  const edgeTable = new FakeKvTable<MemoryCausalEdge>()
  const causal = new MemoryCausalStore(edgeTable, () => NOW)
  const llm = new FakeLlm(llmText)
  const warnings: unknown[][] = []
  const extractor = new MemoryCausalExtractor({
    store,
    causal,
    llm,
    logger: {
      warn: (...args: unknown[]) => warnings.push(args),
      info: () => {},
    },
    now: () => NOW,
  })
  return { entryTable, store, edgeTable, causal, llm, extractor, warnings }
}

/** 在 entryTable 中种入一对关联条目（a 因 → b 果） */
async function seedPair(t: FakeTable, aId = 'a', bId = 'b'): Promise<void> {
  const a = makeEntry({ id: aId, content: '用户决定使用 pnpm' })
  const b = makeEntry({ id: bId, content: '本仓库采用 pnpm 工作区' })
  await t.put(a.id, a)
  await t.put(b.id, b)
}

describe('causalEdgeKey 复合主键', () => {
  it('以 \\u0000 分隔，源 id 前缀不撞车', () => {
    // "a" + "bc" 与 "ab" + "c"：中间有 \0 时不会产生相同键
    const k1 = causalEdgeKey('a', 'c', 'causal')
    const k2 = causalEdgeKey('ab', 'c', 'causal')
    expect(k1).not.toBe(k2)
    expect(k1).toBe('a\u0000causal\u0000c')
    expect(k2).toBe('ab\u0000causal\u0000c')
    // 分隔符规则化：键内含 2 个 \0
    expect(k1.split('\u0000')).toEqual(['a', 'causal', 'c'])
  })

  it('relation 参与主键，方向区分', () => {
    const fwd = causalEdgeKey('a', 'b', 'causal')
    const rev = causalEdgeKey('b', 'a', 'causal')
    expect(fwd).not.toBe(rev)
  })
})

describe('MemoryCausalStore', () => {
  it('upsertEdge 成功建边并写入 create 审计', async () => {
    const edgeTable = new FakeKvTable<MemoryCausalEdge>()
    const causal = new MemoryCausalStore(edgeTable, () => NOW)
    const edge = await causal.upsertEdge({
      sourceId: 'a',
      targetId: 'b',
      relation: 'causal',
      confidence: 0.9,
      source: { sessionId: 's1', eventSeqs: [1], excerpt: '亲' },
    })
    expect(edge).not.toBeUndefined()
    expect(edge!.sourceId).toBe('a')
    expect(edge!.audit).toHaveLength(1)
    expect(edge!.audit[0]!.action).toBe('create')
    expect(edge!.audit[0]!.by).toBe('system')
    expect(causal.listEdges()).toHaveLength(1)
  })

  it('upsertEdge 幂等：同键第二次返回 undefined，不覆盖', async () => {
    const causal = new MemoryCausalStore(new FakeKvTable<MemoryCausalEdge>(), () => NOW)
    const input = {
      sourceId: 'a',
      targetId: 'b',
      relation: 'causal' as const,
      confidence: 0.9,
      source: { sessionId: 's1', eventSeqs: [1], excerpt: '亲' },
    }
    const first = await causal.upsertEdge(input)
    const second = await causal.upsertEdge({ ...input, confidence: 0.99 })
    expect(first).not.toBeUndefined()
    expect(second).toBeUndefined()
    expect(causal.listEdges()).toHaveLength(1)
    // add-only：不覆盖——置信度仍为首次的 0.9
    expect(causal.listEdges()[0]!.confidence).toBe(0.9)
  })

  it('edgesOf 返回出边/入边', async () => {
    const causal = new MemoryCausalStore(new FakeKvTable<MemoryCausalEdge>(), () => NOW)
    const src = { sessionId: 's1', eventSeqs: [1], excerpt: '亲' }
    await causal.upsertEdge({ sourceId: 'a', targetId: 'b', relation: 'causal', confidence: 0.9, source: src })
    await causal.upsertEdge({ sourceId: 'c', targetId: 'a', relation: 'causal', confidence: 0.8, source: src })
    const ofA = causal.edgesOf('a')
    expect(ofA.out.map((e) => e.targetId)).toEqual(['b'])
    expect(ofA.in.map((e) => e.sourceId)).toEqual(['c'])
  })

  it('removeEdgesFor 删除与 id 相关的所有边（source 或 target 侧）', async () => {
    const edgeTable = new FakeKvTable<MemoryCausalEdge>()
    const causal = new MemoryCausalStore(edgeTable, () => NOW)
    const src = { sessionId: 's1', eventSeqs: [1], excerpt: '亲' }
    await causal.upsertEdge({ sourceId: 'a', targetId: 'b', relation: 'causal', confidence: 0.9, source: src })
    await causal.upsertEdge({ sourceId: 'c', targetId: 'a', relation: 'causal', confidence: 0.8, source: src })
    await causal.upsertEdge({ sourceId: 'c', targetId: 'd', relation: 'causal', confidence: 0.7, source: src })
    await causal.removeEdgesFor('a')
    expect(causal.listEdges().map((e) => `${e.sourceId}->${e.targetId}`)).toEqual(['c->d'])
  })

  it('appendAudit 追加依据审计到既有边；键不存在静默跳过', async () => {
    const causal = new MemoryCausalStore(new FakeKvTable<MemoryCausalEdge>(), () => NOW)
    const src = { sessionId: 's1', eventSeqs: [1], excerpt: '亲' }
    await causal.upsertEdge({ sourceId: 'a', targetId: 'b', relation: 'causal', confidence: 0.9, source: src })
    await causal.appendAudit('a', 'b', 'causal', 'LLM 因果抽取：依据 pnpm 决策')
    const [edge] = causal.listEdges()
    expect(edge!.audit).toHaveLength(2)
    expect(edge!.audit[1]!.detail).toBe('LLM 因果抽取：依据 pnpm 决策')
    // 键不存在：静默
    await expect(causal.appendAudit('x', 'y', 'causal', '无')).resolves.toBeUndefined()
  })
})

describe('parseCausalEdges', () => {
  it('解析正常输出', () => {
    const parsed = parseCausalEdges(
      '{"edges":[{"sourceId":"a","targetId":"b","confidence":0.9,"justification":"因为"}]}',
    )
    expect(parsed).toEqual([
      { sourceId: 'a', targetId: 'b', confidence: 0.9, justification: '因为' },
    ])
  })

  it('丢弃非法条目：缺字段/confidence 非有限数/空 id', () => {
    const text = JSON.stringify({
      edges: [
        { sourceId: 'a', targetId: 'b', confidence: 0.9 },
        { sourceId: 'a', confidence: 0.5 }, // 缺 targetId
        { sourceId: 'a', targetId: 'b', confidence: 'high' }, // confidence 非数
        { sourceId: '', targetId: 'b', confidence: 0.5 }, // 空 id
        { sourceId: 'a', targetId: 'b', confidence: NaN }, // 非有限数（JSON 会转 null）
      ],
    })
    const parsed = parseCausalEdges(text)
    expect(parsed).toEqual([{ sourceId: 'a', targetId: 'b', confidence: 0.9 }])
  })

  it('非 JSON 返回 []', () => {
    expect(parseCausalEdges('不是 JSON')).toEqual([])
    expect(parseCausalEdges('')).toEqual([])
  })

  it('多余文本（JSON 后有自然语言）仍只取首个平衡 JSON', () => {
    const parsed = parseCausalEdges(
      '好的，我找到了：\n{"edges":[{"sourceId":"a","targetId":"b","confidence":0.8}]} \n以上是结果。',
    )
    expect(parsed).toEqual([{ sourceId: 'a', targetId: 'b', confidence: 0.8 }])
  })
})

describe('MemoryCausalExtractor', () => {
  it('建边：有效候选 + LLM 提议 → 建成并计 created', async () => {
    const { entryTable, causal, extractor, llm } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"b","confidence":0.9,"justification":"pnpm 决策"}]}',
    )
    await seedPair(entryTable)
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ reviewed: 2, edges: 1, created: 1, skipped: 0 })
    expect(causal.listEdges()).toHaveLength(1)
    const [edge] = causal.listEdges()
    // 边带有来源锚点（取自源条目 source）
    expect(edge!.source).toEqual({ sessionId: 's1', eventSeqs: [1], excerpt: '亲' })
    // 依据审计已补记
    expect(edge!.audit.map((a) => a.detail)).toContain('LLM 因果抽取：依据 pnpm 决策')
    expect(extractor.lastRunAt).not.toBeNull()
    // 提示词传入的是真实条目列表与系统提示
    expect(llm.calls[0]!.provider).toBe('p')
    expect(llm.calls[0]!.system).toContain('因果')
  })

  it('已有边跳过：已建过 → skipped', async () => {
    const { entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"b","confidence":0.9}]}',
    )
    await seedPair(entryTable)
    await causal.upsertEdge({
      sourceId: 'a',
      targetId: 'b',
      relation: 'causal',
      confidence: 0.9,
      source: { sessionId: 's1', eventSeqs: [1], excerpt: '亲' },
    })
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(1) // 不新增
  })

  it('自环拒绝', async () => {
    const { entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"a","confidence":0.9}]}',
    )
    await seedPair(entryTable)
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ edges: 1, created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(0)
  })

  it('未知 id 拒绝', async () => {
    const { entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"ghost","confidence":0.9}]}',
    )
    await seedPair(entryTable)
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(0)
  })

  it('非 active 拒绝', async () => {
    const { store, entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"arch","confidence":0.9}]}',
    )
    await seedPair(entryTable)
    entryTable.put('arch', makeEntry({ id: 'arch', status: 'archived', content: '已归档' }))
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(0)
  })

  it('已被 supersededBy 覆盖的条目拒绝', async () => {
    const { store, entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"old","confidence":0.9}]}',
    )
    await seedPair(entryTable)
    entryTable.put('old', makeEntry({ id: 'old', status: 'active', supersededBy: 'new', content: '旧表述' }))
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(0)
  })

  it('跨 workspace 拒绝', async () => {
    const { store, entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"other","confidence":0.9}]}',
    )
    await seedPair(entryTable)
    entryTable.put('other', makeEntry({ id: 'other', workspace: 'D:/other', content: '其它项目' }))
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(0)
  })

  it('confidence < 0.6 拒绝', async () => {
    const { entryTable, causal, extractor } = setupExtractor(
      '{"edges":[{"sourceId":"a","targetId":"b","confidence":0.5}]}',
    )
    await seedPair(entryTable)
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ created: 0, skipped: 1 })
    expect(causal.listEdges()).toHaveLength(0)
  })

  it('周期门控：未满间隔返回 undefined，force 无视', async () => {
    const { entryTable, extractor } = setupExtractor('{"edges":[]}')
    await seedPair(entryTable)
    // 首次成功
    const first = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(first).toMatchObject({ created: 0 })
    expect(extractor.lastRunAt).not.toBeNull()
    // 立即再跑（未满 CAUSAL_INTERVAL_MS）→ 被门控
    const gated = await extractor.runOnce({ provider: 'p', model: 'm' })
    expect(gated).toBeUndefined()
    // force 无视门控
    const forced = await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })
    expect(forced).toMatchObject({ created: 0 })
  })

  it('route 缺省回退缓存；无缓存时告警并返回 undefined', async () => {
    const { entryTable, extractor, llm, warnings } = setupExtractor('{"edges":[]}')
    await seedPair(entryTable)
    // 无显式 route 且无缓存 → warn 返回 undefined
    const missing = await extractor.runOnce(undefined, { force: true })
    expect(missing).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
    expect(llm.calls).toHaveLength(0) // 未调 LLM
    // 显式 route 成功 → 缓存
    await extractor.runOnce({ provider: 'deepseek', model: 'm1' }, { force: true })
    expect(llm.calls).toHaveLength(1)
    // 再次缺省 → 回退缓存
    await extractor.runOnce(undefined, { force: true })
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.provider).toBe('deepseek')
    expect(llm.calls[1]!.model).toBe('m1')
  })

  it('自收容：LLM 抛错 → 返回 undefined 且不更新 lastRunAt', async () => {
    const { store, entryTable, edgeTable, warnings } = setupExtractor('')
    await seedPair(entryTable)
    // 覆盖 llm 为抛错版本
    const throwing: Pick<import('@deepseek-ai/dsh-llm').LlmRuntime, 'stream'> = {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('LLM 挂了')
      },
    }
    const extractor2 = new MemoryCausalExtractor({
      store,
      causal: new MemoryCausalStore(edgeTable, () => NOW),
      llm: throwing,
      logger: { warn: (...args: unknown[]) => warnings.push(args), info: () => {} },
      now: () => NOW,
    })
    const result = await extractor2.runOnce({ provider: 'p', model: 'm' }, { force: true })
    expect(result).toBeUndefined()
    expect(extractor2.lastRunAt).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('空窗口：reviewed=0 成功结束（非失败）', async () => {
    const { extractor } = setupExtractor('{"edges":[]}')
    const summary = (await extractor.runOnce({ provider: 'p', model: 'm' }, { force: true })) as CausalSummary
    expect(summary).toMatchObject({ reviewed: 0, edges: 0, created: 0, skipped: 0 })
    expect(extractor.lastRunAt).not.toBeNull()
  })
})
