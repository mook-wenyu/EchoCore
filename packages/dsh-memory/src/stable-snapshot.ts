/**
 * @module @echocore/dsh-memory/stable-snapshot
 *
 * 稳定记忆快照（OPTIMIZATION_PLAN_3 P1：缓存感知注入 · system 侧）。
 *
 * 问题：DeepSeek 自动前缀缓存（严格前缀匹配，命中价约未命中 1/50）下，
 * injector 的实时检索注入内容逐轮变化，注入段无法命中缓存。
 *
 * 方案：注册 `ctx.systemPrompt.context()` 段，为每个 workspace 提供
 * 「稳定快照」——窗口（TTL + store.revision 变更）内字节不变的全局重要
 * 记忆（importance 优先）。context 段被 dsh 物化为 user-role 快照（位于
 * 消息历史前缀区），字节稳定则相邻请求共享同一缓存前缀单元。
 *
 * 与实时注入（injector）的分工：
 * - 本模块：全局稳定记忆（重要性优先，窗口内不变）→ 前缀缓存主力；
 * - injector：按查询的实时相关记忆（每步检索）→ 与快照去重（P2）。
 *
 * 作用域：在插件根作用域注册（与现有 memory 插件一致），provider 按
 * `context.agent.session.header.cwd` 区分 workspace；无 agent 上下文时
 * 返回空串（该 context 段不贡献文本）。
 */

import type { Context } from '@deepseek-ai/cordis'

import { DEFAULT_WORKSPACE, MEMORY_INJECTION_HEADER } from './constants.js'
import { renderBudgetedPack } from './render.js'
import type { MemoryStore } from './store.js'

/** 稳定快照配置（由插件 Config 解析后的默认值填充） */
export interface SnapshotConfig {
  enableSnapshot: boolean
  /** 快照缓存窗口（ms；窗口内字节不变） */
  snapshotTtlMs: number
  /** 快照预算上限（字符） */
  snapshotBudgetChars: number
  /** 快照 Top-K 候选上限（预算之外的保险） */
  snapshotTopK: number
}

/** 快照服务依赖（store/now 可注入，便于单测） */
export interface SnapshotDeps {
  store: MemoryStore
  config: SnapshotConfig
  now: () => number
}

/** 单 workspace 的缓存快照：文本 + 含有的记忆 id 集合（供注入去重）+ 失效条件 */
interface CachedSnapshot {
  text: string
  ids: Set<string>
  /** 构建时的 store.revision（变化即失效） */
  revision: number
  /** 构建时刻 + TTL（到期即失效） */
  expiresAt: number
}

/** systemPrompt.context 段名（与现有 dsh 段不冲突；重复注册会抛错，命名即契约） */
export const SNAPSHOT_CONTEXT_NAME = 'memory:snapshot'

/** 段排序：置于策略段（sandbox 110 / approval 115 / subagent 120）之后 */
export const SNAPSHOT_CONTEXT_ORDER = 130

export class MemoryStableSnapshot {
  /** workspace → 快照缓存（进程内；重启清空，与 store.revision 同生命周期） */
  private readonly cache = new Map<string, CachedSnapshot>()
  /** 禁用态共享空集（snapshotIds 的显式返回，避免每次新建 Set） */
  private static readonly EMPTY_IDS: ReadonlySet<string> = new Set()

  constructor(private readonly deps: SnapshotDeps) {}

  /**
   * 注册 systemPrompt.context 段（provider 形态：每次 assemble 求值）。
   * provider 内只读缓存/重建快照，返回空串当快照为空（空文本不贡献段）。
   * 禁用（enableSnapshot=false）时不注册——无快照即无缓存收益，属显式配置
   * 而非静默降级。
   */
  install(ctx: Context): void {
    if (!this.deps.config.enableSnapshot) return
    ctx.systemPrompt.context({
      name: SNAPSHOT_CONTEXT_NAME,
      order: SNAPSHOT_CONTEXT_ORDER,
      text: (assembly) => this.providerText(assembly.agent?.session.header.cwd),
    })
  }

  /** provider 入口：按 workspace 取快照文本（无 agent 上下文回退默认工作区） */
  private providerText(cwd: string | undefined): string {
    const workspace = cwd ?? DEFAULT_WORKSPACE
    return this.snapshotOf(workspace).text
  }

  /**
   * 该 workspace 当前快照含有的记忆 id 集合（供 injector 实时注入去重）。
   * 禁用时返回空集——实时注入路径不受快照影响（与"不注册段"一致：禁用
   * 是显式配置，不是空快照）。
   */
  snapshotIds(workspace: string): ReadonlySet<string> {
    if (!this.deps.config.enableSnapshot) return MemoryStableSnapshot.EMPTY_IDS
    return this.snapshotOf(workspace).ids
  }

  /** 取（或重建）workspace 快照：TTL 未过且 store.revision 未变则复用缓存 */
  private snapshotOf(workspace: string): CachedSnapshot {
    const cached = this.cache.get(workspace)
    const now = this.deps.now()
    if (cached !== undefined && cached.revision === this.deps.store.revision && cached.expiresAt > now) {
      return cached
    }
    const built = this.build(workspace, now)
    this.cache.set(workspace, built)
    return built
  }

  /** 重建快照：按重要度取数 → 预算渲染 → 记录 id 集合与失效条件 */
  private build(workspace: string, now: number): CachedSnapshot {
    const candidates = this.deps.store.listByImportance(workspace, this.deps.config.snapshotTopK)
    const pack = renderBudgetedPack(
      candidates.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        content: entry.content,
        importance: entry.importance,
        sessionId: entry.source.sessionId,
      })),
      this.deps.config.snapshotBudgetChars,
      MEMORY_INJECTION_HEADER,
      (skipped) => `（另有 ${skipped} 条高重要度记忆未入快照，可用 memory_recall 检索）`,
    )
    const rendered = pack?.renderedIds ?? []
    return {
      text: pack?.text ?? '',
      ids: new Set(rendered),
      revision: this.deps.store.revision,
      expiresAt: now + this.deps.config.snapshotTtlMs,
    }
  }
}
