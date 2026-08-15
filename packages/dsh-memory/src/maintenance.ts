/**
 * @module @echocore/dsh-memory/maintenance
 *
 * 后台记忆整理任务（实现计划 O8-M）。
 *
 * 职责：周期性地对记忆库执行轻量整理，防止长期运行后重复、过期、标签
 * 混乱的记忆堆积。与提取器（写）相对，它是记忆库的"卫生员"。
 *
 * 运行模型：
 * - 活动门：仅在本进程出现过会话活动（agent/pre-step 或 session/event）后才
 *   启动计时——无会话活动的进程（如纯初始化）不执行，避免无意义的空转；
 * - 定时链：每次运行结束后重新调度下一周期（setTimeout 链，非 setInterval），
 *   保证单次运行不会被下一次触发覆盖（无并发重入）；
 * - 光标：批次从最近活跃会话解析模型路由（resolveRoute）；无可用路由时
 *   整个批次跳过并告警一次。
 *
 * 范围裁剪（域隔离约束，非兜底，已写入实现计划 O8-M）：
 * - **删除任务 b（supersede 复核）**：store.update 的白名单字段为
 *   content/kind/importance/tags，不支持变更 supersededBy/supersedes；
 *   被覆盖条目的标记解除无法经现有 store API 完成（不能改 store——属于存储
 *   子代理域）。此能力遗留给存储域后续提供专用方法。
 * - **LLM 裁决裁剪（KISS）**：a/c/d 三类任务全部纯规则执行，不调 LLM
 *   （重复合并用 tokenize Jaccard 规则已够；LLM 语义裁决留给未来）。
 *   因此本类不依赖 llm（避免无调用点的死依赖）。
 * - **合并实现裁剪**：设计上的"并集 eventSeqs + merge 审计"需写 source 与
 *   自定义审计 action，均超出现有 store.update 白名单与 store.archive 签名
 *   （archive 无 detail 参数）。在 store API 围栏内，合并 = 归档旧者 +
 *   提升新者重要度；旧者审计保留为 'archive'（by: 'system'），新者保留自己的
 *   source 锚点（旧者审计链完整可溯源）。eventSeqs 并集与 detail:'stale'
 *   同样受该约束省略。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { resolveRoute } from './extract.js'
import { tokenize } from './scoring.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/** 每批处理的候选条目数预算（只处理最新前 N 条，控制单次负载） */
const BATCH_BUDGET = 20
/** 候选拉取窗口（预算应用前的拉取量，放大检索范围） */
const CANDIDATE_WINDOW = 200

/** 重复合并：tokenize Jaccard 相似度下限（≥0.85 视为近似重复） */
const JACCARD_THRESHOLD = 0.85
/** 重复合并：重要度差上限（差异过大视为不同侧重的条目） */
const MAX_IMPORTANCE_DIFF = 2

/** 过期降级：updatedAt 距今超过该天数才可能降级 */
const STALE_DAYS = 90
/** 过期降级：重要度 ≤ 该值且从未被访问才降级（高重要/被访问的不动） */
const MAX_STALE_IMPORTANCE = 3

/** 一天毫秒数 */
const MS_PER_DAY = 86_400_000

/** 后台整理任务配置（由插件 Config 解析后的默认值填充） */
export interface MaintenanceConfig {
  /** 后台记忆整理任务开关 */
  enableMaintenance: boolean
  /** 整理间隔（小时；仅在进程有活跃会话事件后计时） */
  maintenanceIntervalHours: number
}

/** 整理任务依赖（store/logger/config/now 注入，便于单测；无 llm——任务纯规则） */
export interface MemoryMaintenanceDeps {
  store: MemoryStore
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
  config: MaintenanceConfig
  /** 当前时刻（毫秒）；测试注入固定时钟 */
  now: () => number
}

/** 最近一次活跃会话（供批处理的模型路由解析） */
interface ActiveContext {
  session: Session
}

/** session/event 监听器形态 */
type SessionEventListener = (session: Session, event: SessionEvent) => void

export class MemoryMaintenance {
  /** 是否已出现会话活动（活动门；true 前不启动计时） */
  private armed = false
  /** 最近一次活跃会话（路由解析用） */
  private recent: ActiveContext | undefined
  /** 当前挂起的定时句柄（setTimeout 链） */
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: MemoryMaintenanceDeps) {}

  /** 开关（config 默认 enableMaintenance: true） */
  private get enabled(): boolean {
    return this.deps.config.enableMaintenance
  }

  /**
   * 注册活动监听与生命周期清理。
   * - 监听 agent/pre-step 与 session/event 作为活动门（纯观察者）；
   * - agent/pre-step 为 waterfall：本类不消费也不改变决定，仅记录活动后
   *   透传 next() 的结果，保证与注入器等其它监听互不干扰；
   * - ctx.effect 注册的 disposer 随插件 fiber 停止轮询、解除活动态。
   * enableMaintenance=false 时完全不接线（无监听、无定时）。
   */
  install(ctx: Context): void {
    if (!this.enabled) return
    ctx.on('agent/pre-step', async (payload, next) => {
      this.markActivity(payload.agent.session)
      return next() // 透传决定：纯观察者不参与流水线决策
    })
    ctx.on('session/event', this.onSessionEvent.bind(this) as SessionEventListener)
    ctx.effect(() => () => {
      this.clearTimer()
      this.armed = false
      this.recent = undefined
    })
  }

  /** session/event 观察者：任何会话事件都算一次活动 */
  private onSessionEvent(session: Session, _event: SessionEvent): void {
    this.markActivity(session)
  }

  /** 活动门：记录最近会话；首次活动时启动定时链 */
  private markActivity(session: Session): void {
    if (!this.enabled) return
    this.recent = { session }
    if (!this.armed) {
      this.armed = true
      this.schedule()
    }
  }

  /** 调度下一周期（setTimeout 链；清除旧挂起句柄防重入）。R2-10/M2：间隔最小 1 由 config schema 保证，此处不夹逼 */
  private schedule(): void {
    this.clearTimer()
    const intervalMs = this.deps.config.maintenanceIntervalHours * 3_600_000
    this.timer = setTimeout(() => this.onInterval(), intervalMs)
  }

  /** 定时触发：清理句柄引用，异步执行批次（尽力不阻塞事件循环） */
  private onInterval(): void {
    this.timer = undefined
    void this.runInterval()
  }

  /** 定时批次外壳：runOnce 自收容 rejection；无论成败最终都重新计时 */
  private async runInterval(): Promise<void> {
    try {
      await this.runOnce()
    } finally {
      this.schedule()
    }
  }

  /** 清理挂起的定时句柄 */
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /**
   * 执行一个整理批次（公开，供定时器与测试直接调用）。
   * 全程自收容：单条处理失败仅告警并继续，批次级整体失败仅告警——
   * 后台异步任务绝不让 rejection 逃离（工程必需）。
   */
  async runOnce(): Promise<void> {
    if (!this.enabled) return
    try {
      const session = this.recent?.session
      if (session === undefined) return // 活动门：进程内尚未出现会话活动
      const route = resolveRoute(session, undefined)
      if (route === undefined) {
        this.deps.logger.warn('[dsh-memory] 无可用模型路由，跳过本批后台整理')
        return
      }

      const candidates = this.deps.store.listRecent(CANDIDATE_WINDOW, 'active')
      const window = candidates.slice(0, BATCH_BUDGET)

      await this.mergeDuplicates(window)
      await this.archiveStale(window)
      await this.normalizeTags(window)
    } catch (error) {
      this.deps.logger.warn('[dsh-memory] 后台记忆整理批次执行失败：', error)
    }
  }

  /**
   * 任务 a：重复合并。
   * 同 workspace + 同 kind、tokenize Jaccard ≥ 0.85、重要度差 ≤ 2 的条目对，
   * 保留新者（高重要度提升），旧者归档。
   * 注意（R2-10/M1）：每对经 getById 重读当前状态是有意为之——mergePair 会
   * 归档旧者/提升新者重要度，重读才能跳过已归档条目并感知重要度变化；
   * getById 为同步内存读（table.get），窗口 20 条下约 380 次读，无性能问题，
   * 勿"优化"为静态快照（会破坏已归档跳过语义）。
   */
  private async mergeDuplicates(window: MemoryEntry[]): Promise<void> {
    for (let i = 0; i < window.length; i++) {
      for (let j = i + 1; j < window.length; j++) {
        const wa = window[i]
        const wb = window[j]
        if (wa === undefined || wb === undefined) continue // noUncheckedIndexedAccess 守卫
        const a = this.deps.store.getById(wa.id)
        const b = this.deps.store.getById(wb.id)
        if (a === undefined || b === undefined) continue
        if (a.status !== 'active' || b.status !== 'active') continue
        if (a.workspace !== b.workspace || a.kind !== b.kind) continue
        if (Math.abs(a.importance - b.importance) > MAX_IMPORTANCE_DIFF) continue
        if (jaccardOf(a.content, b.content) < JACCARD_THRESHOLD) continue
        try {
          const newer = a.createdAt >= b.createdAt ? a : b
          const older = newer.id === a.id ? b : a
          await this.mergePair(newer, older)
          this.deps.logger.info(`[dsh-memory] 重复合并：${older.id} → ${newer.id}`)
        } catch (error) {
          this.deps.logger.warn(`[dsh-memory] 重复合并失败（${a.id}/${b.id}）：`, error)
        }
      }
    }
  }

  /** 合并一对近似重复：新者重要度取更大者，旧者归档（store API 围栏内的合并语义） */
  private async mergePair(newer: MemoryEntry, older: MemoryEntry): Promise<void> {
    if (older.importance > newer.importance) {
      await this.deps.store.update(newer.id, { importance: older.importance }, 'system')
    }
    await this.deps.store.archive(older.id, 'system')
  }

  /**
   * 任务 c：过期降级。
   * updatedAt 距今超 90 天 且 从未被访问（accessCount === 0）且 重要度 ≤ 3
   * 的条目归档（审计 'archive' by 'system'；detail:'stale' 受 store.archive 无
   * detail 参数约束而省略——降级由审计动作与字段状态可还原）。
   */
  private async archiveStale(window: MemoryEntry[]): Promise<void> {
    const cutoff = this.deps.now() - STALE_DAYS * MS_PER_DAY
    for (const candidate of window) {
      const entry = this.deps.store.getById(candidate.id)
      if (entry === undefined || entry.status !== 'active') continue
      if (entry.accessCount !== 0) continue
      if (entry.importance > MAX_STALE_IMPORTANCE) continue
      const updatedAt = Date.parse(entry.updatedAt)
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue
      try {
        await this.deps.store.archive(entry.id, 'system')
      } catch (error) {
        this.deps.logger.warn(`[dsh-memory] 过期降级失败（${entry.id}）：`, error)
      }
    }
  }

  /**
   * 任务 d：标签整理。
   * 将条目 tags 中小写化后去重（不同大小写变体归并到小写），消除同一标签的
   * 大小写分裂——search 按 tag 精确匹配，归一化保证同名标签可命中。
   * store.update 白名单包含 tags，可直接写回。
   */
  private async normalizeTags(window: MemoryEntry[]): Promise<void> {
    for (const candidate of window) {
      const entry = this.deps.store.getById(candidate.id)
      if (entry === undefined || entry.status !== 'active') continue
      const lowered = [...new Set(entry.tags.map((tag) => tag.toLowerCase()))]
      const changed =
        lowered.length !== entry.tags.length || lowered.some((tag, i) => tag !== entry.tags[i])
      if (!changed) continue
      try {
        await this.deps.store.update(entry.id, { tags: lowered }, 'system')
      } catch (error) {
        this.deps.logger.warn(`[dsh-memory] 标签整理失败（${entry.id}）：`, error)
      }
    }
  }
}

/**
 * 两段内容的 tokenize Jaccard 相似度（交集 / 并集）。
 * 双方 token 集合均为空时返回 0（不视为重复，避免 0/0）。
 */
function jaccardOf(a: string, b: string): number {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  const inter = [...ta].filter((t) => tb.has(t)).length
  const union = ta.size + tb.size - inter
  if (union === 0) return 0
  return inter / union
}
