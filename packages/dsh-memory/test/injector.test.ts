/**
 * 注入器单元测试：waterfall 契约、预算截断、去重与压缩后重注入、
 * workspace 隔离、开关与边界。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { MemoryInjector, renderCatalog, textOfBatch } from '../src/injector.js'
import { MemoryStableSnapshot, SNAPSHOT_MIN_REBUILD_INTERVAL_MS } from '../src/stable-snapshot.js'
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
 * 快照时钟可拨动（F5 重建降频测试需推进 SNAPSHOT_MIN_REBUILD_INTERVAL_MS）。
 */
function setup(opts?: {
  /**
   * 假嵌入持有者的 KNN 桩（Q1=A 解耦测试用）：提供时注入器走语义融合路径，
   * 每次检索以本工厂的返回值作为语义榜（惰性求值——可在 seed 后再定榜）。
   */
  knnHits?: () => Array<{ id: string; cosine: number }>
}) {
  const ctx = new FakeCtx()
  const table = new FakeTable()
  const store = new MemoryStore(table)
  const logger = { warn: () => {}, info: () => {} }
  // 可拨动时钟：起点 1_000_000（与历史固定值一致，未拨动时行为不变）
  let t = 1_000_000
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
  // P2：稳定快照（恒启用，行为参数已常量化为 SNAPSHOT_* 常量）
  const snapshot = new MemoryStableSnapshot({ store, now: clock.now })
  // 可选假嵌入（语义单榜路径测试）；结构对齐 EmbeddingHolder（state 门控 + embed + index.knn）。
  // embedMarks 记录每次查询嵌入发起（Q2=B 并行性断言用：embed 标记应先于 next-resolved）。
  const embedMarks: string[] = []
  const embedding =
    opts?.knnHits === undefined
      ? undefined
      : ({
          service: {
            state: 'ready',
            dimension: 4,
            embed: async (text: string) => {
              embedMarks.push(`embed:${text}`)
              return new Float32Array(4)
            },
          },
          index: { knn: () => opts.knnHits!() },
        } as never)
  const injector = new MemoryInjector({ store, snapshot, logger, embedding })
  injector.install(ctx as unknown as Context)
  const preStep = ctx.listener('agent/pre-step') as
    | ((payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)
    | undefined
  const sessionEvents = ctx.listener('session/event') as ((session: Session, event: SessionEvent) => void) | undefined
  const disposed = ctx.listener('agent/disposed') as ((payload: { agent: { id: string; session: Session } }) => void) | undefined
  if (preStep === undefined || sessionEvents === undefined) throw new Error('监听未注册')
  return { ctx, store, injector, snapshot, preStep, sessionEvents, disposed, clock, embedMarks }
}

// Q2=B（2026-08-20 拍板）：查询嵌入与下游决定并行发起 + 查询向量 LRU 缓存
describe('MemoryInjector 嵌入并行与查询向量缓存（Q2=B）', () => {
  it('并行性：查询嵌入在 await next() 让出前就已发起（旧串行实现 embed 晚于 next-resolved）', async () => {
    let knnCalls = 0
    const { preStep, store, embedMarks } = setup({
      knnHits: () => {
        knnCalls++
        return []
      },
    })
    await seed(store, { content: longContent('量子纠缠态测量协议') })
    const marks: string[] = []
    const payload = makePayload('s1', '完全无关的查询词')
    const promise = preStep(payload, async () => {
      // next 挂起一拍：给并行嵌入留出发起窗口（微任务排空）
      await Promise.resolve()
      await Promise.resolve()
      marks.push(...embedMarks)
      marks.push('next-resolved')
      return enterDecision()
    })
    await promise
    // 并行语义断言：embed 发生在 next 完成之前（旧实现 embed 在 next 之后才发起）
    const embedIdx = marks.findIndex((m) => m.startsWith('embed:'))
    expect(embedIdx).toBeGreaterThanOrEqual(0)
    expect(embedIdx).toBeLessThan(marks.indexOf('next-resolved'))
    void knnCalls
  })

  it('查询向量缓存：相同查询文本只嵌一次；服务实例变化后失效重嵌', async () => {
    const ctx = new FakeCtx()
    const table = new FakeTable()
    const store = new MemoryStore(table)
    const snapshot = new MemoryStableSnapshot({ store, now: () => 1_000_000 })
    let embedCount = 0
    const embed = async () => {
      embedCount++
      return new Float32Array(4)
    }
    // 服务引用可热换（模拟面板保存）：getter 动态读当前实例
    let currentService: unknown = { state: 'ready', dimension: 4, embed }
    const embedding = {
      get service() {
        return currentService
      },
      index: { knn: () => [] as Array<{ id: string; cosine: number }> },
    }
    const injector = new MemoryInjector({ store, snapshot, logger: { warn: () => {}, info: () => {} }, embedding: embedding as never })
    injector.install(ctx as unknown as Context)
    const preStep = ctx.listener('agent/pre-step') as (payload: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
    await seed(store, { content: longContent('量子纠缠态测量协议') })
    // 注意：步内查询含近期消息窗口（P3），同会话连发会使查询文本变化——
    // 用独立会话 id 保证三次查询文本完全一致，专测"缓存命中/服务失效"语义
    await preStep(makePayload('s-a', '稳定重复查询词'), async () => enterDecision())
    expect(embedCount).toBe(1)
    // 相同查询第二次（独立会话）→ 缓存命中，不再嵌
    await preStep(makePayload('s-b', '稳定重复查询词'), async () => enterDecision())
    expect(embedCount).toBe(1)
    // 服务实例热换（面板保存场景）→ 缓存按服务身份失效，重新嵌入
    currentService = { state: 'ready', dimension: 4, embed }
    await preStep(makePayload('s-c', '稳定重复查询词'), async () => enterDecision())
    expect(embedCount).toBe(2)
  })
})

describe('MemoryInjector pre-step 注入', () => {
  it('命中记忆时追加注入消息并保留下游消息', async () => {
    const { preStep, store } = setup()
    await seed(store, { content: longContent('pnpm workspace 项目规则') })
    // P1 档位（≥0.7 全量/0.4-0.7 摘要）：查询聚焦 'pnpm workspace' 双 token 全命中
    // → relevance 1.0 × timeImportance ≈0.9 ≥0.7 全量档（避免弱相关 seed 被 0.4 底线过滤）
    const decision = await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision())
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
    await seed(store, { content: longContent('pnpm workspace 项目规则'), importance: 10 })
    // 查询含记忆没有的独有词 '怎么'（分离断言用）；importance 10 抬高 timeImportance
    // → 分数稳过 0.4 底线（P1 档位：relevance 2/3 × factor 1.0 ≈0.67 摘要档）
    const decision = await preStep(makePayload('s1', 'pnpm workspace 怎么'), async () => enterDecision())
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // 下游消息保留原样（无注入污染）
    expect(decision.messages[0]).toMatchObject({ id: 'down0', source: { kind: 'user' } })
    // 注入消息独立成条：plugin 来源 + recall 形态
    const injected = decision.messages[1]
    expect(injected.source).toMatchObject({ kind: 'plugin', plugin: '@echocore/dsh-memory', form: 'recall' })
    // 注入消息的 content 不含用户指令的独有词（内容隔离；记忆内容本身不含 '怎么'）
    const injectedText = (injected.content[0] as { type: string; text: string }).text
    expect(injectedText).not.toContain('怎么')
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

  // F2（相关性硬门槛）：旧 MIN_SCORE=0.15 会放行、但新硬门槛 0.3 会拦截的
  // "低相关"记忆不再注入。构造 10-token 查询 + 10 条候选（每条仅含 1 个查询词、
  // 其余词 df>0 需候选覆盖——新 IDF 语义：候选集外词不进分母）——每条命中
  // 1/10 = 0.1 × factor ≈0.075 < 0.4 → 全部不注入。
  it('低相关记忆（relevance 落在 0.15-0.3 区间）不再注入（F2 硬门槛）', async () => {
    const { preStep, store } = setup()
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']
    // 10 条候选：每条含 1 个查询词（df>0）+ 独立内容——查询 10 词时每条仅 1/10 命中
    for (const word of words) {
      await seed(store, { content: longContent(`${word} 一次性备注`), importance: 5 })
    }
    const query = words.join(' ')
    const decision = await preStep(makePayload('s1', query), async () => enterDecision())
    // 无条件断言（防弱断言静默跳过）：低相关记忆不注入 → 消息保持原样 1 条
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
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

// renderPack 已删除（生产死代码：无真实调用点，完整行渲染语义已内联在
// handlePreStep 高置信档——header/逐条 bullet/短 id 溯源/预算截断/计数提示
// 分别由下述 MemoryInjector 用例与原 N2 目录用例覆盖）。
// 此处仅保留原 renderPack 独有、未在别处覆盖的"空包保护"行为：
// 预算连一条都放不下时不得注入空消息（renderBudgetedPack 返回 undefined → 不注入）。
// 以 handlePreStep 等效路径验证：单条记忆渲染行超 INJECT_BUDGET_CHARS(16384)
// 预算 → 空包 → 消息保持原样（仅下游 1 条）。
describe('MemoryInjector 空包保护（预算连一条都放不下时不注入）', () => {
  it('单条渲染超预算 → renderBudgetedPack 返回 undefined → 不注入空包', async () => {
    const { preStep, store } = setup()
    // 内容远超注入预算：formatMemoryLine 全量渲染 → 单行超 16384 → 空包
    await seed(store, { content: longContent('pnpm workspace', 17000), importance: 10 })
    const decision = await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision())
    expect(decision.kind).toBe('enter')
    // 无条件断言（防弱断言静默跳过）：不注入空包 → 消息保持原样 1 条
    expect(decision.messages).toHaveLength(1)
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
    // P1 档位：查询聚焦 'pnpm workspace'（双 token 全命中 → relevance 1.0，过 0.4 底线）
    const decision = await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision())
    const text = injectedText(decision)
    expect(text).toContain('一次性备注')
    expect(text).not.toContain('高重要规则')
  })

  it('快照重建（revision 变更）后排除集合更新：离开快照的记忆恢复可注入', async () => {
    const { preStep, store, clock } = setup()
    // 候选短记忆最初是仅有的记忆 → 在快照 Top-30 → 实时注入排除它
    await seed(store, { content: 'pnpm workspace 旧备注', importance: 6 })
    const first = await preStep(makePayload('s1', 'pnpm workspace 旧备注怎么用'), async () => enterDecision())
    expect(injectedText(first)).not.toContain('旧备注')
    // 写入 30 条更高重要度填充 → revision 变更 → 快照重建：候选被挤出 Top-30 → 离开快照。
    // F5 重建降频：须越过 SNAPSHOT_MIN_REBUILD_INTERVAL_MS 才实际重建
    for (let i = 0; i < 30; i++) {
      await seed(store, { content: `快照填充 ${i}`, importance: 10 })
    }
    clock.advance(SNAPSHOT_MIN_REBUILD_INTERVAL_MS + 1)
    const second = await preStep(makePayload('s1', 'pnpm workspace 旧备注怎么用'), async () => enterDecision())
    expect(injectedText(second)).toContain('旧备注')
  })
})

// P1（2026-08-16 三档注入）：≥0.7 全量完整行 / 0.4-0.7 摘要行 / <0.4 跳过。
// 注意：记忆内容均超快照预算（长尾不进快照）——排除快照排除对分档验证的干扰。
describe('MemoryInjector 置信度分档（P1）', () => {
  function injectedText(decision: PreStepDecision): string {
    if (decision.kind !== 'enter') throw new Error('应注入')
    const injected = decision.messages[decision.messages.length - 1]
    const text = (injected?.content ?? []).find((block) => block.type === 'text')?.text ?? ''
    return text
  }

  it('高置信（≥0.7）：完整行渲染（含重要度与来源会话）——纯相关性驱动，与重要度无关', async () => {
    const { preStep, store } = setup()
    // 长尾内容（> 快照预算不进快照）；Q1=A 解耦后档位只看 relevance：
    // 查询双 token 全命中 → IDF relevance 1.0 ≥0.7 完整档（importance 不参与门槛）
    await seed(store, { content: `pnpm workspace ${'长记忆内容短语'.repeat(2000)}`, importance: 10 })
    const text = injectedText(await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision()))
    expect(text).toContain('重要度 10')
    expect(text).toContain('来自会话')
  })

  it('中置信（0.4-0.7）：摘要行渲染——语义单榜 relevance=0.5（与重要度无关）', async () => {
    // Q1=A 解耦后档位判据 = 纯相关性：语义单榜第一经 RRF 归一化恒 0.5 ∈[0.4,0.7)
    // → 摘要渲染，即使 importance 10（重要性不再抬高置信档位）
    let hits: Array<{ id: string; cosine: number }> = []
    const { preStep, store } = setup({ knnHits: () => hits })
    const seeded = await seed(store, { content: longContent('量子纠缠态测量协议'), importance: 10 })
    hits = [{ id: seeded.id, cosine: 0.9 }]
    const text = injectedText(await preStep(makePayload('s1', '完全无关的查询词'), async () => enterDecision()))
    expect(text).toContain('记忆 #')
    expect(text).not.toContain('重要度')
    expect(text).not.toContain('来自会话')
    expect(text).toContain('…') // 摘要截断省略号
  })

  it('Q1=A 解耦回归：低重要度语义单榜第一仍可注入（门槛不再乘 TIF）', async () => {
    // imp1 fresh：旧耦合分 = relevance 0.5 × TIF(imp1)=0.55 → 0.275 < 0.4 被丢；
    // 解耦后门槛建在 relevance=0.5 上 → 注入（摘要档）。这是解耦修复的直接行为证明。
    let hits: Array<{ id: string; cosine: number }> = []
    const { preStep, store } = setup({ knnHits: () => hits })
    const seeded = await seed(store, { content: longContent('量子纠缠态测量协议'), importance: 1 })
    hits = [{ id: seeded.id, cosine: 0.9 }]
    const text = injectedText(await preStep(makePayload('s1', '完全无关的查询词'), async () => enterDecision()))
    expect(text).toContain('记忆 #')
    expect(text).toContain('…')
  })

  it('低置信（<0.4）：不注入', async () => {
    const { preStep, store } = setup()
    await seed(store, { content: `pnpm workspace ${'长记忆内容短语'.repeat(2000)}`, importance: 1 })
    // 查询零重合 → relevance 0 → 分数 0 <0.4 → 跳过（不注入）
    const decision = await preStep(makePayload('s1', '环境 完全无关话题词'), async () => enterDecision())
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1) // 仅下游消息，无注入
  })
})

// Q4=A（2026-08-20 拍板）：注入侧 Jaccard 冗余折叠——同主题近重复只留最高分，
// TOP_K 坑位不被变体浪费（读端轻量去冗余；写端 supersede/merge 仍是主治理）
describe('MemoryInjector 注入冗余折叠（Q4=A）', () => {
  it('tokenJaccard>0.6 的近重复只保留最高分条，无关记忆不受影响', async () => {
    const { preStep, store } = setup()
    // 三条长尾记忆（超快照预算 → 可实时注入）。夹具关键：A/B 的 token Jaccard
    // 落在 (0.6, 0.7) 开区间——低于写端 supersede 阈值 0.7（否则 create 扫描会先
    // 标记覆盖、检索里根本不会同现），高于读端折叠阈值 0.6：
    // token 集 {pnpm,workspace,alpha,beta,gamma,delta,epsi,va?,x} vs {…vb?,x}：
    // |∩|=8（含 x 填充 token），|∪|=12 → j=0.667 ✓；C 与二者仅共享 x → j≈1/19
    await seed(store, { content: longContent('pnpm workspace alpha beta gamma delta epsi va1 va2'), importance: 9 })
    await seed(store, { content: longContent('pnpm workspace alpha beta gamma delta epsi vb1 vb2'), importance: 5 })
    // C 与查询相关（关键词命中）且与 A/B 仅共享 x 填充 token——验证折叠不误伤异题
    await seed(store, { content: longContent('git rebase 工作流要点记录'), importance: 7 })
    const decision = await preStep(makePayload('s1', 'pnpm workspace git'), async () => enterDecision())
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    const text = injectedTextLocal(decision)
    // 最高分变体保留、次分变体被折叠（摘要行含 content 前 80 字符，头部含 va1/vb1）
    expect(text).toContain('va1')
    expect(text).not.toContain('vb1')
    // 相关的异题记忆照常注入（折叠不误伤）
    expect(text).toContain('rebase')
  })

  function injectedTextLocal(decision: PreStepDecision): string {
    if (decision.kind !== 'enter') throw new Error('应注入')
    const injected = decision.messages[decision.messages.length - 1]
    return (injected?.content ?? []).find((block) => block.type === 'text')?.text ?? ''
  }

  it('Q5=A 观测计数：步/包/条/折叠计数随注入行为累加（getter 返回浅拷贝）', async () => {
    const { preStep, store, injector } = setup()
    // 关键词路径夹具（与折叠测试同款）：A/B 近重复对 j≈0.667∈(0.6,0.7)，每步折叠 1 条
    await seed(store, { content: longContent('pnpm workspace alpha beta gamma delta epsi va1 va2'), importance: 9 })
    await seed(store, { content: longContent('pnpm workspace alpha beta gamma delta epsi vb1 vb2'), importance: 5 })
    await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision())
    await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision())
    const stats = injector.stats
    expect(stats.steps).toBe(2)
    expect(stats.injectedPacks).toBe(2)
    expect(stats.injectedEntries).toBeGreaterThanOrEqual(2)
    expect(stats.foldedDuplicates).toBe(2) // 每步各折叠 1 条次分变体
    // 浅拷贝：外部改写不影响内部累计
    stats.steps = 999
    expect(injector.stats.steps).toBe(2)
  })
})

// P3（2026-08-16 会话上下文派生查询）：近期消息主题词参与召回（openclaw 轻量近似）
describe('MemoryInjector 会话上下文派生查询（P3）', () => {
  function injectedText(decision: PreStepDecision): string {
    if (decision.kind !== 'enter') throw new Error('应注入')
    const injected = decision.messages[decision.messages.length - 1]
    const text = (injected?.content ?? []).find((block) => block.type === 'text')?.text ?? ''
    return text
  }

  it('当前消息换话题时，近期消息的主题词仍参与召回', async () => {
    const { preStep, store } = setup()
    // 31 条高重要度填充：挤占快照 Top-30 → 被测记忆（imp 8）不进快照（P2 排除不干扰）
    for (let i = 0; i < 31; i++) {
      await seed(store, { content: `无关填充词 ${i}`, importance: 10 })
    }
    // 记忆只与"近期话题"（pnpm/workspace/编译器/环境/配置）相关，与当前消息（环境怎么配置）弱相关
    await seed(store, { content: 'pnpm workspace 编译器环境配置', importance: 8 })
    // 第一轮：查询 'pnpm workspace' → 全命中（relevance 1.0 × 0.9 = 0.9）→ 注入
    const first = await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision())
    expect(injectedText(first)).toContain('编译器')
    // 第二轮：当前消息 '环境怎么配置'——无拼接时 A 命中 环境/配置 = 2/5 = 0.4 × 0.9 = 0.36
    // <0.4 不注入；P3 拼接近期窗口（'pnpm workspace'）→ 命中 4/7 ≈0.57 × 0.9 = 0.51 ≥0.4 注入
    const second = await preStep(makePayload('s1', '环境怎么配置'), async () => enterDecision())
    expect(injectedText(second)).toContain('编译器')
  })

  // R3a：P3 窗口滚动边界——窗口满 3 条后最旧话题被丢。
  // 记忆仅靠专属词 W 命中（其余内容为长尾填充，不与后续查询重叠）——因此召回
  // 完全由「拼接查询里是否含 W」决定：q1 若仍在窗口，第 5 步（查询与 q1 主题相关
  // 但当前消息不含 W）仍会召回；q1 被挤出窗口则 W 缺席、不再召回。
  it('P3 窗口满 3 条后最旧被丢（q1 专属词不再参与召回）', async () => {
    const { preStep, store } = setup()
    const W = 'scribblequark'
    await seed(store, { content: longContent(W), importance: 10 })
    // 第 1 步查询含 W → 命中注入（证明 W 在场可召回）
    const first = await preStep(makePayload('s1', `${W} protocol`), async () => enterDecision())
    expect(injectedText(first)).toContain(W)
    // 第 2-4 步：不同话题（均不与记忆词重叠）只推进窗口 → 第 4 步后窗口=[q4,q3,q2]，q1 被丢
    const tailQueries = ['nitrogen maintenance', 'hydraulic pipeline', 'seal ring replacement']
    for (const q of tailQueries) {
      const d = await preStep(makePayload('s1', q), async () => enterDecision())
      expect(d.kind).toBe('enter')
    }
    // 第 5 步：查询与 q1 主题相关（quark）但当前消息不含 W → 若 W 仍在窗口则召回，不在则不召回
    const fifth = await preStep(makePayload('s1', 'quark orbital station'), async () => enterDecision())
    expect(fifth.kind).toBe('enter')
    if (fifth.kind !== 'enter') throw new Error('应 enter')
    expect(fifth.messages).toHaveLength(1) // 仅下游，无注入：q1 已被挤出窗口
  })

  // R3a：P3 窗口有界——连续 20 次 pre-step 后窗口不随会话无限增长（恒 ≤3）。
  // 同一会话积累 20 个不同话题，W 早已被挤出；第 21 步查询与 W 相关但当前消息
  // 不含 W → 不召回，反证窗口长度被上限 3 掐住（未随步数线性膨胀保留 W）。
  it('P3 窗口有界：连续 20 步后最旧 q 被丢（q1 专属词不召回，Map 不无限增长）', async () => {
    const { preStep, store } = setup()
    const W = 'quasiparticle'
    await seed(store, { content: longContent(W), importance: 10 })
    // 第 1 步含 W → 命中（证明 W 在场可召回）
    const first = await preStep(makePayload('s1', W), async () => enterDecision())
    expect(injectedText(first)).toContain(W)
    // 连续 19 个不同话题推进窗口（累计到第 20 步）：窗口恒 ≤3，W 早已被挤出
    for (let i = 0; i < 19; i++) {
      const d = await preStep(makePayload('s1', `independent-topic-${i}`), async () => enterDecision())
      expect(d.kind).toBe('enter')
    }
    // 第 21 步：查询与 W 相关（quasi）但当前消息不含 W → W 已不在窗口 → 不召回
    const after = await preStep(makePayload('s1', 'quasi stellar'), async () => enterDecision())
    expect(after.kind).toBe('enter')
    if (after.kind !== 'enter') throw new Error('应 enter')
    expect(after.messages).toHaveLength(1)
  })
})

// N2（2026-08-16 目录注入）：预算截断跳过的条目标题目录——防 known-information
// forgetting（被预算截断的关键事实模型无从发现，标题作导航供主动 memory_recall 取全文）。
describe('MemoryInjector 目录注入（N2）', () => {
  function injectedText(decision: PreStepDecision): string {
    if (decision.kind !== 'enter') throw new Error('应注入')
    const injected = decision.messages[decision.messages.length - 1]
    const text = (injected?.content ?? []).find((block) => block.type === 'text')?.text ?? ''
    return text
  }

  // 预算极小（16384 只放得下第一条完整行超长记忆）→ 其余条目标题进目录段
  // （含计数提示 + 目录头 + 标题 + 记忆 #短id）。两条内容不同 → 不合并、id 各异。
  it('预算放不下多条完整行时，其余条目标题进目录段（保留计数提示）', async () => {
    const { preStep, store } = setup()
    // 两条都是超快照预算的长尾（>8192 → 不进快照 → 可实时注入）；单条完整行
    // ≈8300 字符，两条合计超 16384 → 第一条渲染、第二条被跳过进目录。
    const first = await seed(store, { content: longContent('pnpm workspace 甲规则', 8230), importance: 10 })
    const second = await seed(store, { content: longContent('pnpm workspace 乙备注', 8230), importance: 10 })
    const text = injectedText(await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision()))
    // 保留原计数提示（一行）
    expect(text).toContain('另有 1 条相关记忆未展示')
    // 目录段：标题（content 前 24 字符）+ 记忆 #短id
    expect(text).toContain('## 未展示的记忆目录（可 memory_recall 检索）')
    expect(text).toContain('pnpm workspace')
    // 恰好一条进目录（跳过条目的短 id），另一条是完整行渲染不重复列目录
    const catalogSection = text.split('## 未展示的记忆目录')[1] ?? ''
    const shortsInCatalog = [first, second].filter((entry) => catalogSection.includes(`记忆 #${entry.id.slice(0, 8)}`))
    expect(shortsInCatalog).toHaveLength(1)
    void second
  })

  // 无跳过（预算内全部放下）→ 不追加目录段
  it('预算内全部放下（无跳过）时不追加目录段', async () => {
    const { preStep, store } = setup()
    // 单条长尾完整行 ≈8300 < 16384 → 全渲染，零跳过
    await seed(store, { content: longContent('pnpm workspace 唯一规则', 8230), importance: 10 })
    const text = injectedText(await preStep(makePayload('s1', 'pnpm workspace'), async () => enterDecision()))
    expect(text).toContain('pnpm workspace 唯一规则')
    expect(text).not.toContain('未展示的记忆目录')
  })
})

// N2：renderCatalog 目录段预算（CATALOG_BUDGET_CHARS=1500）截断行为。
// 自动注入 TOP_K=8 上限下同批次最多 7 条跳过（合计 ≈350 字符 <1500，永不超）
// ——目录超预算只能由"大量手动跳过条目"触发，故以纯函数方式单测截断路径。
describe('renderCatalog（N2 目录段预算截断）', () => {
  /** 构造带长标题的跳过条目（kind/content 便于断言） */
  function skippedEntryWith(kind: string, title: string): { entry: MemoryEntry; line: string } {
    return {
      entry: {
        id: `${'aaaaaaaa-1111-1111-1111-'}${title.replace(/\W/g, '').slice(0, 12).padEnd(12, '0')}`.slice(0, 36),
        kind,
        content: `${title} 补充细节 ${'x'.repeat(30)}`,
        importance: 8,
      } as MemoryEntry,
      line: '',
    }
  }

  it('大量跳过条目超目录预算时截断并追加截断提示', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      skippedEntryWith('fact', `pnpm workspace 超预算条目 ${i} 区分标题`),
    )
    const text = renderCatalog(many)
    expect(text).toContain('未展示的记忆目录')
    expect(text).toContain('目录截断，可用 memory_recall 检索更多')
    // 目录段整体不超预算上限（截断发生在 1500 字符处，截断提示叠加其后）
    expect(text.length).toBeLessThanOrEqual(1500 + '（目录截断，可用 memory_recall 检索更多）'.length + 4)
  })

  it('预算内的少量条目正常罗列、不截断', () => {
    const few = Array.from({ length: 3 }, (_, i) => skippedEntryWith('decision', `pnpm workspace 决策条目 ${i}`))
    const text = renderCatalog(few)
    expect(text).toContain('未展示的记忆目录')
    expect(text).not.toContain('目录截断')
    expect(text).toContain('- [decision] pnpm workspace 决策条目 0')
  })
})


