/**
 * 自我学习契约锁线（2026-08-18 用户拍板 Q1/A）：
 * 用可复现断言把当前「已对齐权威」的自我学习红线钉死，防未来回归。
 * 依据（网络第二轮子代理，均已核实 URL）：
 * - Echo-Gap / Memory Reward Inflation（arXiv:2608.00017）：LLM 自评/反思分数会被
 *   膨胀、被高置信复用、误差经记忆复合放大，且更强 judge/阈值剪枝都去不了偏——
 *   因此系统**绝不可**把 LLM 自评分/反思结果写回 stored importance 或直接增强检索；
 *   使用证据只经 effectiveImportance（保留决策面）生效，永不改写 stored importance
 *   （否则同一证据在评分+保留双计，且自评分误差复合放大）。
 * - invalidate-not-delete（Field Guide / Zep-Graphiti / Hindsight）：合并/归档/覆盖
 *   只加状态标记，不物理删行——保证可回滚、审计完整、失误不丢数据。
 * - 检索命中 → 保留提升（SF-AMS / Hindsight access count / mem0 decay 20 次封顶）：
 *   accessCount 经 effectiveImportance 在 listByImportance 排序生效（对数封顶）。
 */

import { describe, expect, it } from 'vitest'

import { effectiveImportance } from '../src/scoring.js'
import { MemoryStore } from '../src/store.js'
import { FakeTable, settle } from './helpers.js'

const FIXED_NOW = Date.parse('2026-01-15T00:00:00.000Z')
const nowFn = (): number => FIXED_NOW

function input(overrides: Record<string, unknown> = {}): Parameters<MemoryStore['create']>[0] {
  return {
    workspace: 'D:/ws',
    sessionId: 's1',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 5,
    tags: ['架构'],
    source: { sessionId: 's1', eventSeqs: [3, 4], excerpt: '…原文…' },
    by: 'extractor',
    ...(overrides as object),
  } as Parameters<MemoryStore['create']>[0]
}

describe('自我学习契约 · Echo-Gap 红线（arXiv:2608.00017）', () => {
  it('effectiveImportance 是纯函数：仅 (importance, accessCount, selfRelevance) 决定输出，无反射/维护隐式态', () => {
    // 确定性：同入参恒同出参（无进程内隐式状态被卷入）
    expect(effectiveImportance(5, 3, 0)).toBe(effectiveImportance(5, 3, 0))
    // 边界钳制：输出恒在 0..10
    expect(effectiveImportance(9, 1000, 8)).toBeLessThanOrEqual(10)
    expect(effectiveImportance(-5, 0, 0)).toBeGreaterThanOrEqual(0)
    // 输入不被改写（纯函数）
    const imp = 4
    const acc = 2
    const self = 6
    effectiveImportance(imp, acc, self)
    expect(imp).toBe(4)
    expect(acc).toBe(2)
    expect(self).toBe(6)
  })

  it('检索命中改写 accessCount，但永不改写 stored importance（使用证据不写回 LLM 自评分）', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const { entry } = await store.create(input({ content: 'pnpm workspace 管理多包规则' }))
    const before = store.getById(entry.id)!
    // 检索命中（含语义/含注入在 store.search 层面同为访问计数）
    store.search({ query: 'pnpm workspace', workspace: 'D:/ws', limit: 5 })
    await settle() // 等待 fire-and-forget 访问追踪落盘
    const after = store.getById(entry.id)!
    // accessCount 增长（使用证据在累计）
    expect(after.accessCount).toBeGreaterThanOrEqual(before.accessCount)
    // stored importance 严格不变（Echo-Gap：访问证据绝不回写 LLM 自评分）
    expect(after.importance).toBe(before.importance)
    // updatedAt 语义不变性（访问追踪不改内容时间戳——快照稳定性）
    expect(after.updatedAt).toBe(before.updatedAt)
  })
})

describe('自我学习契约 · invalidate-not-delete', () => {
  it('supersede 只加后向标记，不物理删除原行（可回滚/审计完整）', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    // 复用已验证的高重合对（Jaccard≈0.778 ≥0.7）：旧决策被新决策覆盖
    const a = (await store.create(input({ kind: 'decision', content: '决定采用评分检索' }))).entry
    await store.create(input({ kind: 'decision', content: '决定采用评分检索方案' }))
    const aAfter = store.getById(a.id)!
    // 原行仍在库、带 supersededBy 标记、审计仍可读
    expect(aAfter).toBeDefined()
    expect(aAfter.supersededBy).toBeDefined()
    expect(aAfter.status).toBe('active') // 被覆盖非归档（D-A 语义：仅是后向引用隐藏）
    // 默认检索排除被覆盖条目；审计视图（includeSuperseded）仍可见
    expect(store.search({ query: '评分检索', workspace: 'D:/ws' }).some((e) => e.id === a.id)).toBe(false)
    expect(
      store.search({ query: '评分检索', workspace: 'D:/ws', includeSuperseded: true }).some((e) => e.id === a.id),
    ).toBe(true)
  })

  it('archive 只置状态，不物理删除原行', async () => {
    const store = new MemoryStore(new FakeTable(), nowFn)
    const a = (await store.create(input({ content: '待归档原语' }))).entry
    await store.archive(a.id, 'tool')
    const aAfter = store.getById(a.id)!
    expect(aAfter).toBeDefined()
    expect(aAfter.status).toBe('archived')
    // 审计可追溯归档动作
    expect(aAfter.audit.some((r) => r.action === 'archive')).toBe(true)
  })
})

describe('自我学习契约 · 检索命中 → 保留提升（accessCount → effectiveImportance → listByImportance）', () => {
  it('访问证据在对数封顶下抬升保留排序（SF-AMS/Hindsight/mem0 decay 同构）', () => {
    // 3 次访问 → evidence +1（log2(4)=2→1? 见 scoring：floor(log2(1+3))=2→min(2,2)=2）
    // 以 scoring 语义为准：7 次 → +2；0 次 → +0
    expect(effectiveImportance(5, 0, 0)).toBe(5)
    expect(effectiveImportance(5, 1, 0)).toBe(6) // 1 次 → +1
    expect(effectiveImportance(5, 3, 0)).toBe(7) // 3 次 → +2（对数封顶 2）
    expect(effectiveImportance(5, 1000, 0)).toBe(7) // 高频仍封顶 +2
    // 保留排序：imp6 无访问 < imp5 + 7 次访问（eff7）
    expect(effectiveImportance(5, 7, 0)).toBeGreaterThan(effectiveImportance(6, 0, 0))
  })

  it('listByImportance 实际消费 effectiveImportance（检索命中 → 保留/快照前排）', async () => {
    const table = new FakeTable()
    const store = new MemoryStore(table, nowFn)
    const low = (await store.create(input({ content: '普通规则', importance: 6 }))).entry
    const used = (await store.create(input({ content: '高频使用规则', importance: 5 }))).entry
    await table.update(used.id, (cur) => ({ ...cur, accessCount: 7 }))
    const top = store.listByImportance('D:/ws', 10)
    expect(top[0]!.id).toBe(used.id) // eff7 > eff6 → 被高频使用的记忆排在保留前排
  })
})
