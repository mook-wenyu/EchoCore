/**
 * 注入器单元测试：waterfall 契约、预算截断、去重与压缩后重注入、
 * workspace 隔离、开关与边界。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { MemoryInjector, renderPack, textOfBatch } from '../src/injector.js'
import { MemoryStableSnapshot } from '../src/stable-snapshot.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEntry, NewMemoryInput } from '../src/types.js'
import { FakeCtx, FakeTable } from './helpers.js'

/** 会话结束载荷 */
function disposePayload(id: string, session: Session): { agent: { id: string; session: Session } } {
  return { agent: { id, session } }
}

/** 构造会话 */
function makeSession(id: string, cwd = 'D:/workspace'): Session {
  return { id, header: { version: 0, id, createdAt: 1, cwd }, events: [] } as unknown as Session
}

/** 构造 pre-step payload */
function makePayload(agentId: string, text: string): unknown {
  return {
    agent: { id: agentId, session: makeSession(agentId) },
    messages: [{ id: `m-${agentId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  }
}

/** 下游决定（默认 enter 保留原批次） */
function enterDecision(extra = 0): PreStepDecision {
  const messages = Array.from({ length: 1 + extra }, (_, i) => ({
    id: `down${i}`,
    role: 'user' as const,
    content: [{ type: 'text', text: `下游消息${i}` }],
    source: { kind: 'user' },
  }))
  return { kind: 'enter', messages }
}

const REJECT_DECISION: PreStepDecision = { kind: 'reject' }

/** 记忆入库辅助 */
async function seed(store: MemoryStore, input: Partial<NewMemoryInput> = {}): Promise<MemoryEntry> {
  const result = await store.create({
    workspace: 'D:/workspace',
    sessionId: 's-old',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 8,
    tags: ['构建'],
    source: { sessionId: 's-old', eventSeqs: [1], excerpt: '…' },
    by: 'extractor',
    ...input,
  })
  return result.entry
}

/**
 * 长尾记忆构造：内容超出稳定快照预算（SNAPSHOT_BUDGET_CHARS=8192 字符）。
 *
 * 快照已常量化（始终启用）后，稳定快照恒含当前 workspace 的 Top-30 高重要度
 * 短记忆（fetch 预算内）。因此"可实时注入"的记忆只能是快照没收录的长尾——
 * 注入器 P2 去重的真实语义：快照管稳定 Top 记忆，实时注入补查询相关的长尾。
 * 测试以"内容超预算 → 快照 renderBudgetedPack 跳过 → id 不进快照集"来精确
 * 制造长尾记忆，从而使它能被实时注入（对齐 stable-snapshot.test.ts 的
 * `'x'.repeat(SNAPSHOT_BUDGET_CHARS + 1000)` 取"不在快照"的同一手法）。
 */
function longContent(padding: string, overheadChars = 8230): string {
  return `${padding} ${'x'.repeat(Math.max(0, overheadChars - padding.length))}`
}

/**
 * 组装被测对象（R3-1：统一 FakeCtx，监听器经 listener() 取用）。
 * 配置常量化后：注入参数（TOP_K / MIN_SCORE / INJECT_BUDGET_CHARS）与快照
 * 行为（SNAPSHOT_TOP_K=30 / SNAPSHOT_BUDGET_CHARS=8192 / SNAPSHOT_TTL_MS）
 * 均已固化为模块常量，不再经 config 注入——构造只传 store/snapshot/logger。
 * 快照恒启用；"可被实时注入"的记忆须为快照未收录的长尾（见 longContent）。
 */
function setup() {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const logger = { warn: () => {}, info: () => {} }
  // P2：稳定快照（恒启用，行为参数已常量化为 SNAPSHOT_* 常量）
  const snapshot = new MemoryStableSnapshot({ store, now: () => 1_000_000 })
  const injector = new MemoryInjector({ store, snapshot, logger })
  injector.install(ctx as unknown as Context)
  const preStep = ctx.listener('agent/pre-step') as
    | ((payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)
    | undefined
  const sessionEvents = ctx.listener('session/event') as ((session: Session, event: SessionEvent) => void) | undefined
  const disposed = ctx.listener('agent/disposed') as ((payload: { agent: { id: string; session: Session } }) => void) | undefined
  if (preStep === undefined || sessionEvents === undefined) throw new Error('监听未注册')
  return { ctx, store, injector, snapshot, preStep, sessionEvents, disposed }
}

describe('MemoryInjector pre-step 注入', () => {
  it('命中记忆时追加注入消息并保留下游消息', async () => {
    const { preStep, store } = setup()
    await seed(store, { content: longContent('pnpm workspace 项目规则') })
    const decision = await preStep(makePayload('s1', 'pnpm workspace 怎么管理'), async () => enterDecision())
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2) // 下游 1 条 + 注入 1 条
    const injected = decision.messages[1]
    expect(injected.source).toMatchObject({ kind: 'plugin', plugin: '@echocore/dsh-memory', form: 'recall' })
    const text = (injected.content[0] as { type: string; text: string }).text
    expect(text).toContain('参考记忆')
    expect(text).toContain('仅作背景资料')
    expect(text).toContain('可能过时或被覆盖') // R4-2：注入声明强化（对抗经验跟随）
    expect(text).toContain('pnpm workspace')
  })

  // R4-3：注入隔离钉住——注入块始终是独立 user/message（source plugin + form recall），
  // 与用户指令消息分离，绝不与指令同块（Injection-Execution Dissociation 防线）
  it('注入消息与用户指令分离（独立 recall 消息，不混入指令块）', async () => {
    const { preStep, store } = setup()
    await seed(store, { content: longContent('pnpm workspace 项目规则') })
    const decision = await preStep(makePayload('s1', 'pnpm workspace 怎么管理'), async () => enterDecision())
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // 下游消息保留原样（无注入污染）
    expect(decision.messages[0]).toMatchObject({ id: 'down0', source: { kind: 'user' } })
    // 注入消息独立成条：plugin 来源 + recall 形态
    const injected = decision.messages[1]
    expect(injected.source).toMatchObject({ kind: 'plugin', plugin: '@echocore/dsh-memory', form: 'recall' })
    // 注入消息的 content 不含用户指令文本（内容隔离）
    const injectedText = (injected.content[0] as { type: string; text: string }).text
    expect(injectedText).not.toContain('怎么管理')
  })

  it('下游为 reject 时不注入', async () => {
    const { preStep, store } = setup()
    await seed(store)
    const decision = await preStep(makePayload('s1', 'pnpm'), async () => REJECT_DECISION)
    expect(decision).toEqual(REJECT_DECISION)
  })

  // waterfall 契约：下游 next() 抛错必须原样透传（注入器不得吞错掩盖下游失败）
  it('下游 next() 抛错时原样透传（不吞错）', async () => {
    const { preStep, store } = setup()
    await seed(store)
    const boom = new Error('下游瀑布流失败')
    await expect(preStep(makePayload('s1', 'pnpm workspace'), async () => Promise.reject(boom))).rejects.toThrow(
      '下游瀑布流失败',
    )
  })

  it('无命中或空批次不注入', async () => {
    const { preStep, store } = setup()
    await seed(store)
    const none = await preStep(makePayload('s1', '完全不相关的词汇组合'), async () => enterDecision())
    expect(none.kind).toBe('enter')
    expect(none.messages).toHaveLength(1)
    const empty = await preStep({ agent: { id: 's1', session: makeSession('s1') }, messages: [{ id: 'x', role: 'user', content: [], source: { kind: 'user' } }] }, async () => enterDecision())
    expect(empty.kind).toBe('enter')
    expect(empty.messages).toHaveLength(1)
  })

  it('workspace 隔离：他项目记忆不注入', async () => {
    const { preStep, store } = setup()
    await seed(store, { workspace: 'D:/other-project' })
    const decision = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    // 无条件断言（防弱断言静默跳过）：他项目记忆不注入 → 消息保持原样 1 条
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
  })

  it('同一记忆已注入且仍在表层时不重复注入', async () => {
    const { preStep, sessionEvents, store } = setup()
    const entry = await seed(store, { content: longContent('pnpm workspace 项目规则') })
    const decision = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    // 模拟注入消息落日志（序号 10），回填注入序号
    const session = makeSession('s1')
    sessionEvents(session, {
      type: 'user/message',
      seq: 10,
      time: 10,
      data: decision.messages[1],
    } as SessionEvent)
    // 再次 pre-step：不再注入
    const again = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (again.kind === 'enter') expect(again.messages).toHaveLength(1)
    void entry
  })

  it('注入消息被压缩遮蔽后允许重新注入', async () => {
    const { preStep, sessionEvents, store } = setup()
    await seed(store, { content: longContent('pnpm workspace 项目规则') })
    const first = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (first.kind !== 'enter') return
    const session = makeSession('s1')
    sessionEvents(session, { type: 'user/message', seq: 10, time: 10, data: first.messages[1] } as SessionEvent)
    // 压缩遮蔽 1..12：注入序号 10 被遮蔽
    sessionEvents(session, {
      type: 'compaction/summary',
      seq: 13,
      time: 13,
      data: {
        compactionId: 'c1',
        summary: [],
        shadowedRange: { start: 1, end: 12 },
        shadowedSeqs: [10],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        rawOutput: [],
        llmStreamCall: true,
      },
    } as SessionEvent)
    const again = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (again.kind === 'enter') expect(again.messages).toHaveLength(2)
  })
})

describe('renderPack', () => {
  const entries = [
    {
      id: 'aaaaaaaa-1111-1111-1111-111111111111',
      kind: 'fact',
      content: '内容甲',
      importance: 7,
      source: { sessionId: 'ssssssss-2222-2222-2222-222222222222', eventSeqs: [1], excerpt: '' },
    },
    {
      id: 'bbbbbbbb-3333-3333-3333-333333333333',
      kind: 'decision',
      content: '内容乙',
      importance: 9,
      source: { sessionId: 'ssssssss-2222-2222-2222-222222222222', eventSeqs: [2], excerpt: '' },
    },
  ] as MemoryEntry[]

  it('渲染标题与逐条 bullet，包含短 id 溯源', () => {
    const pack = renderPack(entries, 4096)
    expect(pack).toBeDefined()
    expect(pack?.text).toContain('[参考记忆]')
    expect(pack?.text).toContain('[fact] 内容甲')
    expect(pack?.text).toContain('记忆 #aaaaaaaa')
    expect(pack?.text).toContain('来自会话 ssssssss')
    expect(pack?.ids).toEqual(['aaaaaaaa-1111-1111-1111-111111111111', 'bbbbbbbb-3333-3333-3333-333333333333'])
  })

  it('预算不足时截断并提示其余数量', () => {
    const longEntries = [
      entries[0] as MemoryEntry,
      { ...entries[1] as MemoryEntry, content: '内容乙'.repeat(80) },
    ]
    const pack = renderPack(longEntries, 200)
    expect(pack).toBeDefined()
    expect(pack?.text).toContain('另有 1 条相关记忆')
    expect(pack?.ids).toHaveLength(1)
  })

  it('预算连一条都放不下时返回 undefined（不注入空包）', () => {
    expect(renderPack(entries, 10)).toBeUndefined()
  })
})

describe('textOfBatch 查询清洗（M8）', () => {
  const userMsg = { source: { kind: 'user' }, content: [{ type: 'text', text: '用户问题' }] }
  const pluginMsg = { source: { kind: 'plugin', plugin: '@echocore/dsh-memory', form: 'recall' }, content: [{ type: 'text', text: '插件注入文本' }] }
  const modelToolMsg = { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', text: '工具结果' }] }

  it('批含 plugin 注入与 tool 来源时仅取用户文本', () => {
    expect(textOfBatch([userMsg, pluginMsg, modelToolMsg] as never)).toBe('用户问题')
  })

  it('全 plugin / 全 tool 时返回空串', () => {
    expect(textOfBatch([pluginMsg] as never)).toBe('')
    expect(textOfBatch([modelToolMsg] as never)).toBe('')
  })

  it('全 plugin 时 pre-step 不注入（空查询）', async () => {
    const { preStep, store } = setup()
    await seed(store)
    const allPlugin = {
      agent: { id: 's1', session: makeSession('s1') },
      messages: [pluginMsg],
    }
    const decision = await preStep(allPlugin as never, async () => enterDecision())
    if (decision.kind === 'enter') expect(decision.messages).toHaveLength(1)
  })
})

describe('MemoryInjector 会话生命周期清理（O2-4）', () => {
  it('disposed 清理 injectedSeqs：结束后记忆重新可注入', async () => {
    const { preStep, sessionEvents, disposed, store } = setup()
    const entry = await seed(store, { content: longContent('pnpm workspace 项目规则') })
    const session = makeSession('s1')
    // 第一次注入并回填序号
    const first = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (first.kind !== 'enter') throw new Error('应注入')
    expect(first.messages).toHaveLength(2)
    sessionEvents(session, { type: 'user/message', seq: 10, time: 10, data: first.messages[1] } as SessionEvent)
    // 再次 pre-step：已在表层，不重复注入
    const again = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (again.kind !== 'enter') throw new Error('应 enter')
    expect(again.messages).toHaveLength(1)
    // 会话结束：清理 injectedSeqs
    disposed?.(disposePayload('s1', session))
    // 结束后重新 pre-step：不再去重，应重新注入
    const after = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (after.kind !== 'enter') throw new Error('应 enter')
    expect(after.messages).toHaveLength(2)
    void entry
  })

  it('disposed 清理 pendingIds：后续注入序号不再回填旧批次', async () => {
    const { preStep, sessionEvents, disposed, store } = setup()
    await seed(store, { content: longContent('pnpm workspace 项目规则') })
    const session = makeSession('s1')
    const first = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (first.kind !== 'enter') throw new Error('应注入')
    // 注入消息已发出但未回填前 dispose
    disposed?.(disposePayload('s1', session))
    // 模拟一次用户普通消息，不应触发对本插件消息的回填（pendingIds 已清），故注入标记不落
    sessionEvents(session, { type: 'user/message', seq: 20, time: 20, data: { role: 'user', content: [{ type: 'text', text: '普通' }], source: { kind: 'user' } } } as SessionEvent)
    // 不清除 injectedSeqs 的前提下……重新注入验证，见前一个用例；这里断言清理后不残留 pendingIds
    const again = await preStep(makePayload('s1', 'pnpm'), async () => enterDecision())
    if (again.kind !== 'enter') throw new Error('应 enter')
    expect(again.messages).toHaveLength(2)
  })
})

// P2（OPTIMIZATION_PLAN_3）：实时注入排除稳定快照已含的记忆（混合形态去重）。
// 快照已常量化（恒启用，Top-K=30 / 预算 8192），实时注入只补快照未收录的长尾。
describe('MemoryInjector 快照去重（P2）', () => {
  /** 从注入消息提取文本 */
  function injectedText(decision: PreStepDecision): string {
    if (decision.kind !== 'enter') throw new Error('应注入')
    const injected = decision.messages[decision.messages.length - 1]
    const text = (injected?.content ?? []).find((block) => block.type === 'text')?.text ?? ''
    return text
  }

  it('快照已含的短高重要度记忆不进实时包，未收录的长尾记忆正常注入', async () => {
    const { preStep, store } = setup()
    // 短记忆（进预算）高重要度 → 被稳定快照收录 → P2 排除
    await seed(store, { content: 'pnpm workspace 高重要规则', importance: 9 })
    // 超预算长尾记忆（内容 > SNAPSHOT_BUDGET_CHARS）→ 快照跳过 → 可实时注入
    await seed(store, { content: longContent('pnpm workspace 一次性备注'), importance: 3 })
    const decision = await preStep(makePayload('s1', 'pnpm workspace 怎么用'), async () => enterDecision())
    const text = injectedText(decision)
    expect(text).toContain('一次性备注')
    expect(text).not.toContain('高重要规则')
  })

  it('快照重建（revision 变更）后排除集合更新：离开快照的记忆恢复可注入', async () => {
    const { preStep, store } = setup()
    // 候选短记忆最初是仅有的记忆 → 在快照 Top-30 → 实时注入排除它
    await seed(store, { content: 'pnpm workspace 旧备注', importance: 6 })
    const first = await preStep(makePayload('s1', 'pnpm workspace 旧备注怎么用'), async () => enterDecision())
    expect(injectedText(first)).not.toContain('旧备注')
    // 写入 30 条更高重要度填充 → revision 变更 → 快照重建：候选被挤出 Top-30 → 离开快照
    for (let i = 0; i < 30; i++) {
      await seed(store, { content: `快照填充 ${i}`, importance: 10 })
    }
    const second = await preStep(makePayload('s1', 'pnpm workspace 旧备注怎么用'), async () => enterDecision())
    expect(injectedText(second)).toContain('旧备注')
  })
})

