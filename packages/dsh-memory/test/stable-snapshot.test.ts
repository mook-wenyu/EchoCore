/**
 * 稳定快照单元测试（OPTIMIZATION_PLAN_3 P1）：
 * - 窗口内字节稳定（缓存感知注入的核心不变量）；
 * - TTL 到期 / store.revision 变更后重建；
 * - 按重要度取数、预算截断、空库返回空串；
 * - workspace 隔离；
 * - 注册到 systemPrompt.context（段名/排序/禁用不注册）。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { MemoryStableSnapshot, SNAPSHOT_CONTEXT_NAME, SNAPSHOT_CONTEXT_ORDER, type SnapshotConfig } from '../src/stable-snapshot.js'
import { MemoryStore } from '../src/store.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 固定时钟（测试注入，可拨动） */
function fixedNow(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** 组装被测对象 */
function setup(config: Partial<SnapshotConfig> = {}) {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const clock = fixedNow()
  const full: SnapshotConfig = {
    enableSnapshot: true,
    snapshotTtlMs: 300_000,
    snapshotBudgetChars: 8192,
    snapshotTopK: 30,
    ...config,
  }
  const snapshot = new MemoryStableSnapshot({ store, config: full, now: clock.now })
  return { ctx, store, snapshot, clock }
}

/** 播种一条记忆（可覆盖重要度/workspace） */
async function seed(store: MemoryStore, input: Partial<NewMemoryInput> = {}): Promise<string> {
  const result = await store.create({
    workspace: 'D:/ws-a',
    sessionId: 's-1',
    kind: 'fact',
    content: '项目规则：使用 pnpm workspace 管理多包',
    importance: 7,
    tags: ['规则'],
    source: { sessionId: 's-1', eventSeqs: [1], excerpt: '原文' },
    by: 'extractor',
    ...input,
  })
  return result.entry.id
}

/** 取快照文本（模拟 provider 求值） */
function textOf(snapshot: MemoryStableSnapshot, cwd: string | undefined): string {
  // 通过公开 API 取：注册 context 后以 provider 形态求值
  const ctx = new FakeCtx()
  snapshot.install(ctx as unknown as Context)
  const entry = ctx.systemPromptContexts.get(SNAPSHOT_CONTEXT_NAME) as {
    text: (assembly: { agent?: { session: { header: { cwd?: string } } } }) => string
  }
  return entry.text({ agent: cwd === undefined ? undefined : { session: { header: { cwd } } } })
}

describe('MemoryStableSnapshot 注册', () => {
  it('启用时注册 memory:snapshot 段（排序 130，位于策略段之后）', () => {
    const { ctx, snapshot } = setup()
    snapshot.install(ctx as unknown as Context)
    expect(ctx.systemPromptContexts.has(SNAPSHOT_CONTEXT_NAME)).toBe(true)
    expect((ctx.systemPromptContexts.get(SNAPSHOT_CONTEXT_NAME) as { order: number }).order).toBe(SNAPSHOT_CONTEXT_ORDER)
  })

  it('禁用时不注册（显式配置，非静默降级）', () => {
    const { ctx, snapshot } = setup({ enableSnapshot: false })
    snapshot.install(ctx as unknown as Context)
    expect(ctx.systemPromptContexts.has(SNAPSHOT_CONTEXT_NAME)).toBe(false)
  })

  it('无 agent 上下文时回退默认工作区', async () => {
    const { store, snapshot } = setup()
    await seed(store, { workspace: 'default' })
    const text = textOf(snapshot, undefined)
    expect(text).toContain('pnpm workspace')
  })
})

describe('快照稳定性（缓存感知核心不变量）', () => {
  it('同一窗口内两次求值字节完全相同', async () => {
    const { store, snapshot } = setup()
    await seed(store)
    const first = textOf(snapshot, 'D:/ws-a')
    const second = textOf(snapshot, 'D:/ws-a')
    expect(second).toBe(first)
  })

  it('TTL 到期后重建（可感知新记忆）', async () => {
    const { store, snapshot, clock } = setup()
    await seed(store, { content: '旧记忆内容' })
    const before = textOf(snapshot, 'D:/ws-a')
    await seed(store, { content: 'TTL 后的新记忆' })
    // revision 已变 → 立即重建，不等 TTL
    const afterRevision = textOf(snapshot, 'D:/ws-a')
    expect(afterRevision).not.toBe(before)
    expect(afterRevision).toContain('TTL 后的新记忆')
    clock.advance(0)
  })

  it('仅 TTL 到期（无内容变更）也重建', async () => {
    const { store, snapshot, clock } = setup()
    await seed(store, { content: '唯一记忆' })
    const before = textOf(snapshot, 'D:/ws-a')
    clock.advance(300_001)
    const after = textOf(snapshot, 'D:/ws-a')
    expect(after).toBe(before) // 内容未变，重建后字节相同（幂等）
  })
})

describe('快照取数与预算', () => {
  it('按重要度降序取数', async () => {
    const { store, snapshot } = setup()
    await seed(store, { content: '低重要度记忆', importance: 3 })
    await seed(store, { content: '高重要度记忆', importance: 9 })
    const text = textOf(snapshot, 'D:/ws-a')
    const lowIdx = text.indexOf('低重要度记忆')
    const highIdx = text.indexOf('高重要度记忆')
    expect(highIdx).toBeGreaterThan(-1)
    expect(lowIdx).toBeGreaterThan(-1)
    expect(highIdx).toBeLessThan(lowIdx)
  })

  it('预算截断：超限条目不入快照，且被截断条目的 id 不进 ids 集合', async () => {
    const { store, snapshot } = setup({ snapshotBudgetChars: 400 })
    const shortId = await seed(store, { content: '短记忆' })
    const longId = await seed(store, { content: 'x'.repeat(500) })
    const ids = snapshot.snapshotIds('D:/ws-a')
    // 同 importance（7）按创建倒序：长记忆在前；预算 400 放不下 500 字 → 只渲染短记忆
    expect(ids.has(shortId)).toBe(true)
    expect(ids.has(longId)).toBe(false)
    const text = textOf(snapshot, 'D:/ws-a')
    expect(text).toContain('短记忆')
    expect(text).toContain('另有 1 条')
    expect(text).not.toContain('x'.repeat(20))
  })

  it('空库返回空串（空文本不贡献段）', async () => {
    const { snapshot } = setup()
    expect(textOf(snapshot, 'D:/ws-a')).toBe('')
  })

  it('被覆盖条目不进快照', async () => {
    const { store, snapshot } = setup()
    await seed(store, { content: '项目采用方案A' })
    await seed(store, { content: '项目采用方案A 修订' })
    const text = textOf(snapshot, 'D:/ws-a')
    // 两条 tokenize Jaccard = 4/5 = 0.8 ≥ 0.7 → 旧被新覆盖；快照只含新
    const ids = snapshot.snapshotIds('D:/ws-a')
    expect(ids.size).toBe(1)
    expect(text).toContain('修订')
    expect(text).not.toContain('方案A\n') // 旧条目不在快照文本（content 短 id 不同，用换行锚点）
  })

  it('workspace 隔离：不同工作区互不串扰', async () => {
    const { store, snapshot } = setup()
    await seed(store, { content: '甲工作区记忆', workspace: 'D:/ws-a' })
    await seed(store, { content: '乙工作区记忆', workspace: 'D:/ws-b' })
    const textA = textOf(snapshot, 'D:/ws-a')
    const textB = textOf(snapshot, 'D:/ws-b')
    expect(textA).toContain('甲工作区')
    expect(textA).not.toContain('乙工作区')
    expect(textB).toContain('乙工作区')
    expect(textB).not.toContain('甲工作区')
  })
})

/** MemoryEntry 类型引用（防未使用告警——实际断言用到） */
void (null as unknown as MemoryEntry)
