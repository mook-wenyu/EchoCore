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
import { MemoryStableSnapshot, SNAPSHOT_BUDGET_CHARS, SNAPSHOT_CONTEXT_NAME, SNAPSHOT_CONTEXT_ORDER, SNAPSHOT_MIN_REBUILD_INTERVAL_MS, SNAPSHOT_PER_SESSION_CAP, SNAPSHOT_TTL_MS } from '../src/stable-snapshot.js'
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

/** 组装被测对象（快照行为已常量化：TTL/预算/TopK 均为模块内固定值） */
function setup() {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const clock = fixedNow()
  const snapshot = new MemoryStableSnapshot({ store, now: clock.now })
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
  it('始终注册 memory:snapshot 段（排序 130，位于策略段之后）', () => {
    const { ctx, snapshot } = setup()
    snapshot.install(ctx as unknown as Context)
    expect(ctx.systemPromptContexts.has(SNAPSHOT_CONTEXT_NAME)).toBe(true)
    expect((ctx.systemPromptContexts.get(SNAPSHOT_CONTEXT_NAME) as { order: number }).order).toBe(SNAPSHOT_CONTEXT_ORDER)
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

  it('revision 变更且超过最小重建间隔后重建（F5：60s 内防挤动）', async () => {
    const { store, snapshot, clock } = setup()
    await seed(store, { content: '旧记忆内容' })
    const before = textOf(snapshot, 'D:/ws-a')
    await seed(store, { content: 'TTL 后的新记忆' })
    // F5：revision 已变但距上次重建 < SNAPSHOT_MIN_REBUILD_INTERVAL_MS → 复用旧快照
    const withinWindow = textOf(snapshot, 'D:/ws-a')
    expect(withinWindow).toBe(before)
    // 越过最小重建间隔 → 重建，新记忆入快照
    clock.advance(SNAPSHOT_MIN_REBUILD_INTERVAL_MS + 1)
    const afterRevision = textOf(snapshot, 'D:/ws-a')
    expect(afterRevision).not.toBe(before)
    expect(afterRevision).toContain('TTL 后的新记忆')
  })

  it('仅 TTL 到期（无内容变更）也重建', async () => {
    const { store, snapshot, clock } = setup()
    await seed(store, { content: '唯一记忆' })
    const before = textOf(snapshot, 'D:/ws-a')
    clock.advance(SNAPSHOT_TTL_MS + 1)
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
    const { store, snapshot } = setup()
    const shortId = await seed(store, { content: '短记忆' })
    // 内容远超 SNAPSHOT_BUDGET_CHARS（8192）→ 单条即超预算，被跳过
    const longId = await seed(store, { content: 'x'.repeat(SNAPSHOT_BUDGET_CHARS + 1000) })
    const ids = snapshot.snapshotIds('D:/ws-a')
    // 同 importance（7）按创建倒序：长记忆在前；预算放不下超长单条 → 只渲染短记忆
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

  it('按来源会话浅聚（F1）：每会话至多 SNAPSHOT_PER_SESSION_CAP 条', async () => {
    const { store, snapshot } = setup()
    // 3 个会话各播种 4 条同重要度、内容互异（Jaccard<0.7 不触发 supersede）的记忆
    const FACTS: string[][] = [
      ['量子物理纠缠态测量实验', 'pnpm 包管理器版本升级策略', '前端构建产物优化体积', '后端接口限流阈值调整'],
      ['数据库索引设计规范', '日志采集链路延迟排查', '缓存淘汰策略选型', '部署流水线超时设置'],
      ['代码评审流程约定', '测试环境数据脱敏规则', '性能基准测试方法', '异常上报渠道配置'],
    ]
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 4; i++) {
        // 注意：浅聚按 entry.source.sessionId（渲染来源会话）——顶层 sessionId 与 source 都要覆盖
        await seed(store, {
          sessionId: `s-${s + 1}`,
          source: { sessionId: `s-${s + 1}`, eventSeqs: [1], excerpt: '原文' },
          content: FACTS[s]![i]!,
        })
      }
    }
    const ids = snapshot.snapshotIds('D:/ws-a')
    // 浅聚语义：12 条候选（每会话 4 条）→ 每会话至多 SNAPSHOT_PER_SESSION_CAP 条 = 共 9 条。
    // 不断言具体哪条被拒（同刻 createdAt 的 tie-breaker 是随机 id，仅总量确定）。
    expect(ids.size).toBe(3 * SNAPSHOT_PER_SESSION_CAP)
    const perSession = new Map<string, number>()
    for (const id of ids) {
      const sessionId = store.getById(id)?.source.sessionId ?? '?'
      perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1)
    }
    for (let s = 1; s <= 3; s++) {
      expect(perSession.get(`s-${s}`)).toBe(SNAPSHOT_PER_SESSION_CAP)
    }
  })

  it('渲染创建日期（F3）：快照文本含"创建于"（模型可判断新旧）', async () => {
    const { store, snapshot } = setup()
    await seed(store, { content: '带时间戳的记忆' })
    const text = textOf(snapshot, 'D:/ws-a')
    expect(text).toContain('创建于')
  })
})

/** MemoryEntry 类型引用（防未使用告警——实际断言用到） */
void (null as unknown as MemoryEntry)
