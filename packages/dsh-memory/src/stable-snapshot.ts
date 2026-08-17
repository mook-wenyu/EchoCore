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
import { formatMemoryLine, renderBudgetedPack } from './render.js'
import type { MemoryStore } from './store.js'

/**
 * 快照行为参数（配置常量化）：快照保证在 SNAPSHOT_TTL_MS 窗口内字节不变，
 * 是缓存感知注入的核心不变量——字节稳定则相邻请求共享同一前缀缓存单元。
 * 导出供测试以真实常量驱动行为验证。
 */
/** 快照缓存窗口（ms；窗口内字节不变，到期即重建） */
export const SNAPSHOT_TTL_MS = 300_000
/**
 * 快照预算上限（**字符**口径，非 token；Q3 拍板：诚实化标注）。
 * 中文 ≈1 字符/1 token → 8192 字符 ≈8K token；英文 ≈2K token。与注入预算同为
 * 字符口径——注释不再写"≈N token"误导（token 换算需引入 tokenizer，YAGNI）。
 */
export const SNAPSHOT_BUDGET_CHARS = 8192
/** 快照 Top-K 候选上限（预算之外的保险） */
export const SNAPSHOT_TOP_K = 30
/**
 * 快照按来源会话浅聚上限（F1 防污染：快照取数保持重要度优先，但每个来源
 * 会话最多入选此条数——防止单一/少数会话的高重要度记忆垄断快照（审计实测：
 * 快照 26-29 条来自 9-13 个不同会话，其中大量与当前会话无关），多会话均
 * 衡后无关噪音占比下降，同时保留项目级背景价值）。
 */
export const SNAPSHOT_PER_SESSION_CAP = 3
/**
 * 快照重建最小间隔（ms）（F5 缓存保护：store.revision 变化会触发快照重建，
 * 但高重要度新记忆会挤动 Top 边界、频繁重建破坏前缀缓存字节稳定。revision
 * 变化且距上次重建小于此间隔 → 复用旧快照，防连续写入抖动）。
 */
export const SNAPSHOT_MIN_REBUILD_INTERVAL_MS = 60_000

/** 快照服务依赖（store/now 可注入，便于单测；行为参数已常量化） */
export interface SnapshotDeps {
  store: MemoryStore
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
  /** 构建时刻（F5 重建降频判定用） */
  rebuiltAt: number
}

/** systemPrompt.context 段名（与现有 dsh 段不冲突；重复注册会抛错，命名即契约） */
export const SNAPSHOT_CONTEXT_NAME = 'memory:snapshot'

/** 段排序：置于策略段（sandbox 110 / approval 115 / subagent 120）之后 */
export const SNAPSHOT_CONTEXT_ORDER = 130

export class MemoryStableSnapshot {
  /** workspace → 快照缓存（进程内；重启清空，与 store.revision 同生命周期） */
  private readonly cache = new Map<string, CachedSnapshot>()

  constructor(private readonly deps: SnapshotDeps) {}

  /**
   * 注册 systemPrompt.context 段（provider 形态：每次 assemble 求值）。
   * provider 内只读缓存/重建快照，返回空串当快照为空（空文本不贡献段）。
   * 快照恒启用（行为已常量化），始终注册——无快照即无缓存收益点。
   */
  install(ctx: Context): void {
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
   * 快照恒启用，恒返回真实 id 集（供注入器与快照文本去重）。
   */
  snapshotIds(workspace: string): ReadonlySet<string> {
    return this.snapshotOf(workspace).ids
  }

  /** 取（或重建）workspace 快照：TTL 未过且 store.revision 未变则复用缓存 */
  private snapshotOf(workspace: string): CachedSnapshot {
    const cached = this.cache.get(workspace)
    const now = this.deps.now()
    if (cached !== undefined && cached.revision === this.deps.store.revision && cached.expiresAt > now) {
      return cached
    }
    // F5：revision 变化但距上次重建小于最小间隔 → 复用旧快照（防高重要度
    // 新记忆频繁挤动 Top 边界、破坏前缀缓存字节稳定；TTL 到期仍强制重建）
    if (cached !== undefined && now - cached.rebuiltAt < SNAPSHOT_MIN_REBUILD_INTERVAL_MS && cached.expiresAt > now) {
      return cached
    }
    const built = this.build(workspace, now)
    this.cache.set(workspace, built)
    return built
  }

  /**
   * 重建快照：按重要度取数 → 按来源会话浅聚（F1）→ 预算渲染。
   * F1 防污染：纯重要度取数会让少数会话的高重要度记忆垄断快照（实测 26-29
   * 条来自 9-13 个会话，大量与当前会话无关）；浅聚后每会话至多
   * SNAPSHOT_PER_SESSION_CAP 条，多会话均衡，无关噪音占比下降。
   */
  private build(workspace: string, now: number): CachedSnapshot {
    const candidates = this.deps.store.listByImportance(workspace, SNAPSHOT_TOP_K)
    const perSession = new Map<string, number>()
    const balanced = candidates.filter((entry) => {
      const count = perSession.get(entry.source.sessionId) ?? 0
      if (count >= SNAPSHOT_PER_SESSION_CAP) return false
      perSession.set(entry.source.sessionId, count + 1)
      return true
    })
    const pack = renderBudgetedPack(
      balanced.map((entry) => ({
        id: entry.id,
        line: formatMemoryLine({
          id: entry.id,
          kind: entry.kind,
          content: entry.content,
          importance: entry.importance,
          sessionId: entry.source.sessionId,
          // F3：渲染创建日期——模型可判断记忆新旧（防把过时记忆当现行事实）
          createdAt: entry.createdAt,
        }),
      })),
      SNAPSHOT_BUDGET_CHARS,
      MEMORY_INJECTION_HEADER,
      (skipped) => `（另有 ${skipped} 条高重要度记忆未入快照，可用 memory_recall 检索）`,
    )
    const rendered = pack?.renderedIds ?? []
    return {
      text: pack?.text ?? '',
      ids: new Set(rendered),
      revision: this.deps.store.revision,
      expiresAt: now + SNAPSHOT_TTL_MS,
      rebuiltAt: now,
    }
  }
}
