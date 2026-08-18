/**
 * 基于 LLM 的反思自进化（O-reflect）单元测试。
 *
 * 覆盖：parseReflectionDecisions 严格解析、selectReflectionPairs 焦点排序与相似带
 * 边界、runOnce 用假 llm 验证合并/归档/none/门控/路由回退/失败自收容，
 * 以及与 FakeTable 集成的真实 MemoryStore。
 *
 * 全部经公共接口驱动：FakeLlm 返回固定 JSON 的流；store 用 FakeTable 注入固定时钟。
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  MemoryReflector,
  REFLECT_INTERVAL_MS,
  parseReflectionDecisions,
  selectReflectionPairs,
} from '../src/reflect.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry } from '../src/types.js'
import { FakeTable } from './helpers.js'

/** 固定"现在"：用于门控与 store 时间戳（避免测试随时间漂移） */
const NOW = Date.UTC(2025, 0, 15, 0, 0, 0)
/** 一天毫秒数 */
const MS_PER_DAY = 86_400_000

/** 条目工厂：直接在假表种入受控条目（审计/来源等字段按需补全） */
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

/** 假 llm：按设定分片流返回，并记录收到的 GenerateOptions */
class FakeLlm {
  calls: Array<Record<string, unknown>> = []
  constructor(private readonly chunks: StreamChunk[]) {}
  async *stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    for (const chunk of this.chunks) yield chunk
  }
}

/** 把一段文本编码为流分片 */
function textStream(text: string, reasonKind: 'stop' | 'aborted' | 'error' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: reasonKind } },
  ] as StreamChunk[]
}

/** 组装被测对象：reflector / store / llm / warn 记录 */
function makeReflector(entries: MemoryEntry[], json: string) {
  const table = new FakeTable()
  const store = new MemoryStore(table, () => NOW)
  for (const entry of entries) {
    void table.put(entry.id, entry)
  }
  const llm = new FakeLlm(textStream(json))
  const warns: unknown[] = []
  const reflector = new MemoryReflector({
    store,
    llm: llm as never,
    logger: { warn: (...args: unknown[]) => warns.push(args), info: () => {} },
    now: () => NOW,
  })
  return { table, store, llm, reflector, warns }
}

/** 一对近似重复（tokenJaccard=0.75，落在 [0.15, 0.85) 带内）：newer 新、older 旧 */
function duplicatePair() {
  const older = makeEntry({
    id: 'older01',
    content: 'a b c d e f g h',
    importance: 8,
    createdAt: new Date(NOW - MS_PER_DAY).toISOString(),
  })
  const newer = makeEntry({
    id: 'newer01',
    content: 'a b c d e f',
    importance: 4,
    createdAt: new Date(NOW).toISOString(),
  })
  return { older, newer }
}

describe('parseReflectionDecisions', () => {
  it('解析合法 JSON 裁决', () => {
    const result = parseReflectionDecisions(
      '{"decisions":[{"focusId":"abc","peerId":"def","action":"merge","reason":"同一事实"}]}',
    )
    expect(result).toEqual([{ focusId: 'abc', peerId: 'def', action: 'merge', reason: '同一事实' }])
  })

  it('带前后说明文字时仍能提取 JSON 对象', () => {
    const result = parseReflectionDecisions(
      '好的，审视结果如下：\n{"decisions":[{"focusId":"a","peerId":"b","action":"archive","reason":"冲突"}]}\n以上。',
    )
    expect(result).toEqual([{ focusId: 'a', peerId: 'b', action: 'archive', reason: '冲突' }])
  })

  it('空 decisions 返回空数组', () => {
    expect(parseReflectionDecisions('{"decisions":[]}')).toEqual([])
  })

  it('非 JSON / 形状不符返回空数组（不抛错）', () => {
    expect(parseReflectionDecisions('不是 JSON')).toEqual([])
    expect(parseReflectionDecisions('{"foo":1}')).toEqual([])
    expect(parseReflectionDecisions('')).toEqual([])
  })

  it('非法 action / 字段缺失 / 未知 action 的条目被丢弃，其余保留', () => {
    const result = parseReflectionDecisions(
      '{"decisions":[' +
        '{"focusId":"a","peerId":"b","action":"merge","reason":"x"},' +
        '{"focusId":"a","peerId":"b","action":"gossip","reason":"x"},' +
        '{"focusId":"a","action":"merge","reason":"x"},' +
        '{"focusId":"a","peerId":"b","action":"merge"},' +
        '{"peerId":"b","action":"none","reason":"x"}' +
        ']}',
    )
    expect(result).toEqual([{ focusId: 'a', peerId: 'b', action: 'merge', reason: 'x' }])
  })
})

describe('selectReflectionPairs', () => {
  it('焦点=有带内 peer 的条目，按最强带内 jaccard 降序 → 重要度降序（无 peer 的孤条目不占焦点）', () => {
    // 2026-08-18 实证修复：去重看重合而非重要度 top-20。生产发现 imp6-7 逐字重复对
    // 被重要度前 20 焦点挤掉从未被审；新策略让"带内重合最强的条目"先进被审集。
    const pairA = [
      makeEntry({ id: 'A1', content: 'a b c d e f g h', importance: 7 }),
      makeEntry({ id: 'A2', content: 'a b c d e f', importance: 6 }), // j(A1,A2)=6/8=0.75
    ]
    const pairB = [
      makeEntry({ id: 'B1', content: 'm n o p q r', importance: 9 }),
      makeEntry({ id: 'B2', content: 'm n o p', importance: 8 }), // j=4/6≈0.667
    ]
    const isolated = makeEntry({ id: 'xIso', content: 'z z z z', importance: 10 }) // 无带内 peer → 不进被审集
    const pairs = selectReflectionPairs([...pairA, ...pairB, isolated])
    // 焦点按 maxJ desc：A 组 .75 优先于 B 组 .667；同 maxJ 内按重要度；
    // 同对**两端均进入被审集**（各自以对方为 peer——重复对从两侧都被审，更彻底）
    expect(pairs.map((p) => p.focus.id)).toEqual(['A1', 'A2', 'B1', 'B2'])
    // 孤条目（无 peer）不占焦点
    expect(pairs.some((p) => p.focus.id === 'xIso')).toBe(false)
    // A1 的 peer 含 A2（双向可审）
    expect(pairs[0]?.peers.map((p) => p.id)).toContain('A2')
  })

  it('实证修复：中重要度带内高重合对不被重要度前 20 焦点挤掉（生产真重复场景）', () => {
    // 生产回放：37 条 imp≥8 占据焦点预算时，imp6-7 的逐字同文对仍须进入被审集。
    const entries: MemoryEntry[] = []
    for (let i = 0; i < 25; i++) entries.push(makeEntry({ id: `hi${i}`, content: `isolated ${i}`, importance: 9 }))
    const older = makeEntry({ id: 'dupOld', content: 'CourtGrantTypes 迁至 Project persistence', importance: 7 })
    const newer = makeEntry({ id: 'dupNew', content: 'CourtGrantTypes 迁至 Project persistence 机制', importance: 6 }) // 高重合
    entries.push(older, newer)
    const pairs = selectReflectionPairs(entries)
    const focusIds = pairs.map((p) => p.focus.id)
    // 新旧两端至少其一进入被审焦点集（带内高重合对优先，不被 imp9 孤条目挤掉）
    expect(focusIds).toContain('dupOld')
    expect(pairs.find((p) => p.focus.id === 'dupOld')?.peers.map((x) => x.id)).toContain('dupNew')
  })

  it('相似带边界：<0.15 与 ≥0.85 排除，带内按 jaccard 降序取前 N，排除自身', () => {
    const focus = makeEntry({ id: 'focus', content: 'a b c d e f', importance: 10 })
    const below = makeEntry({ id: 'below', content: 'z y x w v u', importance: 1 }) // j=0
    const above = makeEntry({ id: 'above', content: 'a b c d e f g', importance: 1 }) // j=6/7≈0.857 ≥0.85
    const high = makeEntry({ id: 'high', content: 'a b c d e f g h', importance: 1 }) // j=6/8=0.75
    const mid = makeEntry({ id: 'mid', content: 'a b c d e z y', importance: 1 }) // j=5/8=0.625
    const low = makeEntry({ id: 'low', content: 'a b z y x w', importance: 1 }) // j=2/10=0.2
    const in4 = makeEntry({ id: 'in4', content: 'a b c z y w v', importance: 1 }) // j=3/10=0.3
    const entries = [focus, below, above, high, mid, low, in4]
    const pairs = selectReflectionPairs(entries)
    // 焦点 = 最高重要度的 focus
    expect(pairs[0]?.focus.id).toBe('focus')
    const peers = pairs[0]?.peers.map((p) => p.id) ?? []
    // 带外排除、带内按 jaccard 降序取前 3（high=0.75, mid=0.625, in4=0.3；low=0.2 被截断）
    expect(peers).toEqual(['high', 'mid', 'in4'])
    expect(peers).not.toContain('low')
    expect(peers).not.toContain('below')
    expect(peers).not.toContain('above')
    expect(peers).not.toContain('focus') // 排除自身
    // invariant：peers 与 focus 均同 workspace 同 active（输入过滤）
    for (const id of peers) {
      const peer = entries.find((e) => e.id === id)
      expect(peer?.status).toBe('active')
    }
  })

  it('peer 仅限同 workspace：跨 workspace 不构成对比对', () => {
    // 同 workspace 内相似对才喂 LLM；跨 workspace 即使 jaccard 落在带内也不作 peer
    // （避免跨域对白喂 LLM 随后在 applyDecision 才 skip 的浪费）
    const focus = makeEntry({ id: 'focus', content: 'a b c d e f', workspace: 'D:/wsA', importance: 10 })
    const sameWs = makeEntry({ id: 'same', content: 'a b c d e f g h', workspace: 'D:/wsA', importance: 1 }) // j=6/8=0.75 带内
    const otherWs = makeEntry({ id: 'other', content: 'a b c d e f g h i', workspace: 'D:/wsB', importance: 1 }) // j=6/9≈0.667 带内但跨域
    const pairs = selectReflectionPairs([focus, sameWs, otherWs])
    expect(pairs[0]?.focus.id).toBe('focus')
    expect(pairs[0]?.peers.map((p) => p.id)).toEqual(['same']) // 跨 workspace 不作 peer
  })

  it('每个焦点 peers 数受 REFLECT_PEERS_PER_FOCUS 上限约束', () => {
    const focus = makeEntry({ id: 'focus', content: 'a b c d e f', importance: 10 })
    // 构造 5 个带内 peer（jaccard 各异），仅取前 3
    const p1 = makeEntry({ id: 'p1', content: 'a b c d e f g h i j', importance: 1 }) // j=6/10
    const p2 = makeEntry({ id: 'p2', content: 'a b c d e f g h', importance: 1 }) // j=6/8
    const p3 = makeEntry({ id: 'p3', content: 'a b c d e f g', importance: 1 }) // j=6/7
    const p4 = makeEntry({ id: 'p4', content: 'a b c d e z y', importance: 1 }) // j=5/8
    const p5 = makeEntry({ id: 'p5', content: 'a b c z y w v', importance: 1 }) // j=3/10
    const pairs = selectReflectionPairs([focus, p1, p2, p3, p4, p5])
    expect(pairs[0]?.peers).toHaveLength(3)
  })

  it('焦点预算受 REFLECT_FOCUS_BUDGET 上限约束（20）', () => {
    const entries: MemoryEntry[] = []
    for (let i = 0; i < 25; i++) {
      entries.push(makeEntry({ id: `e${i}`, content: `word ${i}`, importance: i % 10 + 1 }))
    }
    const pairs = selectReflectionPairs(entries)
    expect(pairs).toHaveLength(20)
  })
})

describe('MemoryReflector.runOnce', () => {
  it('merge：归档旧者 + 重要度取更大者，LLM 被调用一次', async () => {
    const { older, newer } = duplicatePair()
    const { store, llm, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"merge","reason":"语义近似重复"}]}',
    )
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' })

    // duplicatePair 中两条互为带内 peer → 两者都作为焦点进入提示词（reviewed=2）
    expect(summary).toEqual({ reviewed: 2, decisions: 1, merged: 1, archived: 0, skipped: 0 })
    expect(store.getById('older01')?.status).toBe('archived')
    expect(store.getById('newer01')?.status).toBe('active')
    expect(store.getById('newer01')?.importance).toBe(8) // max(4, 8)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({ provider: 'deepseek', model: 'm' })
  })

  it('archive（矛盾）：归档旧者，不提升重要度', async () => {
    const { older, newer } = duplicatePair()
    const { store, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"archive","reason":"跨条目矛盾"}]}',
    )
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' })

    expect(summary).toEqual({ reviewed: 2, decisions: 1, merged: 0, archived: 1, skipped: 0 })
    expect(store.getById('older01')?.status).toBe('archived')
    expect(store.getById('newer01')?.status).toBe('active')
    expect(store.getById('newer01')?.importance).toBe(4) // 不 boost
  })

  it('none：不动任何条目，计入 skipped', async () => {
    const { older, newer } = duplicatePair()
    const { store, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"none","reason":"无关"}]}',
    )
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' })

    expect(summary).toEqual({ reviewed: 2, decisions: 1, merged: 0, archived: 0, skipped: 1 })
    expect(store.getById('older01')?.status).toBe('active')
    expect(store.getById('newer01')?.status).toBe('active')
  })

  it('执行前重读：任一缺失/非 active → 拒绝执行计入 skipped', async () => {
    const { older, newer } = duplicatePair()
    // 裁决引用一个不存在的 id
    const { store, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"missing","peerId":"newer01","action":"merge","reason":"x"}]}',
    )
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    expect(summary).toEqual({ reviewed: 2, decisions: 1, merged: 0, archived: 0, skipped: 1 })
    // 两条真实条目都未被误动
    expect(store.getById('older01')?.status).toBe('active')
    expect(store.getById('newer01')?.status).toBe('active')
  })

  it('被 supersededBy 标记的条目不进入候选（不参与反思，杜绝误归档现行表述）', async () => {
    const { older, newer } = duplicatePair()
    const supersededOlder = { ...older, supersededBy: 'other' }
    const { store, reflector } = makeReflector([supersededOlder, newer], '{"decisions":[]}')
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    // 被覆盖条目已被 listRecent 排除；newer 无带内 peer → 无焦点进入提示词
    expect(summary).toEqual({ reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 })
    expect(store.getById('older01')?.status).toBe('active') // 未被归档
  })

  it('跨 workspace 条目不构成候选对（Q6⑦ 拍板：不喂 LLM；applyDecision 的跨域守卫仍保留为竞态兜底）', async () => {
    const older = makeEntry({ id: 'older01', content: 'a b c d e f g h', workspace: 'D:/wsA', createdAt: new Date(NOW - MS_PER_DAY).toISOString() })
    const newer = makeEntry({ id: 'newer01', content: 'a b c d e f', workspace: 'D:/wsB', createdAt: new Date(NOW).toISOString() })
    const { store, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"merge","reason":"x"}]}',
    )
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    // 新契约：跨 workspace 对不再进入候选（无带内 peer）→ 不喂 LLM、无裁决、无任何操作
    expect(summary).toEqual({ reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 })
    expect(store.getById('older01')?.status).toBe('active')
    expect(store.getById('newer01')?.status).toBe('active')
  })

  it('周期门控：未满间隔返回 undefined（不打 LLM）；force 无视门控', async () => {
    const { older, newer } = duplicatePair()
    const { llm, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"none","reason":"x"}]}',
    )
    const first = await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    expect(first).toBeDefined()
    expect(llm.calls).toHaveLength(1)

    // 同一 now：距上次未满间隔 → 直接返回 undefined
    const gated = await reflector.runOnce(undefined)
    expect(gated).toBeUndefined()
    expect(llm.calls).toHaveLength(1)

    // force 无视门控 → 再次执行（route 缺省回退缓存）
    const forced = await reflector.runOnce(undefined, { force: true })
    expect(forced).toBeDefined()
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]).toMatchObject({ provider: 'deepseek', model: 'm' })
  })

  it('route 缺省无缓存时 warn 并返回 undefined，不打 LLM', async () => {
    const { older, newer } = duplicatePair()
    const { llm, reflector, warns } = makeReflector(
      [older, newer],
      '{"decisions":[]}',
    )
    const result = await reflector.runOnce(undefined)
    expect(result).toBeUndefined()
    expect(llm.calls).toHaveLength(0)
    expect(warns.length).toBeGreaterThan(0)
  })

  it('失败自收容：LLM 抛错不逃逸 rejection，warn 且不更新 lastRunAt', async () => {
    const { older, newer } = duplicatePair()
    const table = new FakeTable()
    await table.put(older.id, older)
    await table.put(newer.id, newer)
    const broken = {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('网络失败')
      },
    }
    const warns: unknown[] = []
    const reflector = new MemoryReflector({
      store: new MemoryStore(table, () => NOW),
      llm: broken as never,
      logger: { warn: (...args: unknown[]) => warns.push(args), info: () => {} },
      now: () => NOW,
    })
    const result = await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    expect(result).toBeUndefined()
    expect(reflector.lastRunAt).toBeNull() // 失败不更新缓存
    expect(warns.length).toBeGreaterThan(0)
  })

  it('lastRunAt 记录最近一次成功执行时刻', async () => {
    const { older, newer } = duplicatePair()
    const { reflector } = makeReflector([older, newer], '{"decisions":[]}')
    expect(reflector.lastRunAt).toBeNull()
    await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    expect(reflector.lastRunAt).toBe(new Date(NOW).toISOString())
  })

  it('重入互斥：并发调用 runOnce（force）合并为一次，只一次 LLM 调用', async () => {
    const { older, newer } = duplicatePair()
    const { llm, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"none","reason":"x"}]}',
    )
    // 定时（force=false 但首启通过门控）与手动（force=true）并发——都应合并为一次
    const p1 = reflector.runOnce({ provider: 'deepseek', model: 'm' })
    const p2 = reflector.runOnce({ provider: 'deepseek', model: 'm' }, { force: true })
    expect(p2).toBe(p1) // 返回同一 promise，合并并发
    const [s1, s2] = await Promise.all([p1, p2])
    expect(s1).toEqual(s2)
    expect(llm.calls).toHaveLength(1) // 只一次 LLM 调用，不重复
  })

  it('重入互斥：批次结束后 running 复位——可再开新批次（两次独立执行，LLM 各一次）', async () => {
    const { older, newer } = duplicatePair()
    const { llm, reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"none","reason":"x"}]}',
    )
    const route = { provider: 'deepseek', model: 'm' }
    const s1 = await reflector.runOnce(route, { force: true })
    expect(llm.calls).toHaveLength(1)
    // running 已复位：第二次 force 是一轮**新批次**（再次调用 LLM），而非复用旧 promise
    // ——防 running 复位失败导致"永久锁死"（F2 审计点）。同对同裁决 → 观测量一致。
    const s2 = await reflector.runOnce(route, { force: true })
    expect(llm.calls).toHaveLength(2)
    expect(s1).toEqual(s2)
  })

  it('2b 轻量累计钩子：成功批次跨轮累加 cumulative（runs/裁决/跳过）；仅成功路径计数', async () => {
    const { older, newer } = duplicatePair()
    // 用 none（非变更）裁决：两轮看到同一对、各 1 条裁决入 skipped——累计可线性断言
    // （若用 merge，首轮归档旧者后次轮无对可判，decisions 不递增，不便断言）。
    const { reflector } = makeReflector(
      [older, newer],
      '{"decisions":[{"focusId":"older01","peerId":"newer01","action":"none","reason":"x"}]}',
    )
    const route = { provider: 'deepseek', model: 'm' }
    await reflector.runOnce(route, { force: true })
    expect(reflector.cumulativeSummary).toEqual({ runs: 1, decisions: 1, merged: 0, archived: 0, skipped: 1 })
    // 次轮（force 无视门控）：累计继续增长（"反思是否在收敛"可观测）
    await reflector.runOnce(route, { force: true })
    expect(reflector.cumulativeSummary).toEqual({ runs: 2, decisions: 2, merged: 0, archived: 0, skipped: 2 })
  })

  it('callLlm：畸形输出（不含 decisions 字段）→ warn 可观测 + 0 裁决', async () => {
    const { older, newer } = duplicatePair()
    const { reflector, warns } = makeReflector([older, newer], '这只是一段随机文本，不是裁决 JSON')
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' }, { force: true })
    expect(summary?.decisions).toBe(0)
    // 2026-08-18 实证修复：畸形输出不再与"诚实 0 裁决"不可区分
    expect(warns.some((w) => String(w).includes('未含 decisions'))).toBe(true)
  })

  it('合法空裁决 {"decisions":[]} 不触发畸形 warn', async () => {
    const { older, newer } = duplicatePair()
    const { reflector, warns } = makeReflector([older, newer], '{"decisions":[]}')
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' }, { force: true })
    expect(summary?.decisions).toBe(0)
    expect(warns.some((w) => String(w).includes('未含 decisions'))).toBe(false)
  })
})

describe('反思审计详情与观测（A′ 建议：动作需带依据引用、可审计可回滚）', () => {
  it('merge：归档旧者并写入依据 detail（保留侧短 id + 理由）', async () => {
    const { older, newer } = duplicatePair()
    const { store, reflector } = makeReflector(
      [older, newer],
      JSON.stringify({ decisions: [{ focusId: 'newer01', peerId: 'older01', action: 'merge', reason: '表述同一事实' }] }),
    )
    const summary = await reflector.runOnce({ provider: 'deepseek', model: 'm' }, { force: true })
    expect(summary?.merged).toBe(1)
    const archived = store.getById('older01')
    expect(archived?.status).toBe('archived')
    const record = archived?.audit.find((item) => item.action === 'archive')
    expect(record?.by).toBe('system')
    expect(record?.detail).toContain('newer01')
    expect(record?.detail).toContain('表述同一事实')
    // 保留侧重要度取两者更大值（8）
    expect(store.getById('newer01')?.importance).toBe(8)
  })

  it('lastSummary 记录最近一次成功执行的观察量', async () => {
    const { older, newer } = duplicatePair()
    const { reflector } = makeReflector([older, newer], '{"decisions":[]}')
    expect(reflector.lastSummary).toBeNull()
    await reflector.runOnce({ provider: 'deepseek', model: 'm' })
    // 互为带内 peer 的一对：两个焦点都以各自 peer 进入提示词 → reviewed=2
    expect(reflector.lastSummary).toEqual({ reviewed: 2, decisions: 0, merged: 0, archived: 0, skipped: 0 })
  })
})

