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
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/** 每批处理的候选条目数预算（只处理最新前 N 条，控制单次负载；G2 由 20→200，对 3441 条规模更游刃有余） */
const BATCH_BUDGET = 200

/**
 * C33（2026-08-18 拍板，2026-08-19 调优 256→512）：
 * 向量增量补齐每周期预算（条）。语义补齐是"持续分片"：每维护周期只补一档，
 * 限速防启动/周期瞬间打满远程嵌入 API 触发限流；覆盖随周期收敛（与启动时
 * ensureAll 全量路径并存——启动补一次、周期续补）。
 * 调优：21.8% 覆盖（1900/8709）时 256/周期需约 27h 补齐，期间检索退化为关键
 * 词；提升至 512 后约 13.5h 收敛。启动期夜间可放宽至 1024（约 6-7h），但需
 * 评估远程限流，建议仅夜间或空闲时段启用。
 */
export const BACKFILL_BUDGET = 512
/**
 * 候选拉取窗口（预算应用前的拉取量）。
 * G2 起与 BATCH_BUDGET 解耦：窗口放大到 1000；2026-08-19 调优至 2000，使尾部
 * 7700 条（1000 窗口仅覆盖 11%）也能被轮询到。实现上「拉取后按预算
 * slice(0, BATCH_BUDGET)」真正独立生效——重读语义充分，已归档/被覆盖条目跳过
 * 后批次预算仍能独立约束；若窗口与预算同为 200，slice 恒等、预算不构成独立约束（冗余）。
 * 未来可改为滚动游标分片（按 createdAt 游标分页轮询，每周期一片，N 周期覆盖全
 * 库，记录 lastMaintenanceCursor 持久化到 store 或内存），但当前保持 YAGNI 不过
 * 度设计——仅扩大窗口至 2000 先解 7700 条永不收敛问题。
 * 复杂度说明：mergeDuplicates 双层循环 O(200²) 操作对象为 window.slice(0,
 * BATCH_BUDGET) 的 200 条，保持 BATCH_BUDGET=200 不变则窗口扩大不增加该循环量，
 * 无需限流。
 */
export const CANDIDATE_WINDOW = 2000

/** 重复合并：tokenize Jaccard 相似度下限（≥0.85 视为近似重复） */
const JACCARD_THRESHOLD = 0.85
/** 重复合并：重要度差上限（差异过大视为不同侧重的条目） */
const MAX_IMPORTANCE_DIFF = 2

/** 过期降级：updatedAt 距今超过该天数才可能降级 */
const STALE_DAYS = 90
/**
 * 过期降级：重要度 ≤ 该值 且从未被访问才降级。
 * G2（防上下文腐化——维护力度升级）：由 3 放宽到 5。原 imp≤3 过窄，imp 4-7 且
 * 从未访问的条目永不回收（实测 2108 条唯 imp≤3 的 36 条可降级），记忆库只进难收；
 * imp 4-5 属中低重要度 + 长期未访问应收敛。imp≥6 保留保活语义（高重要度项目规则
 * 即使闲置也不清出检索）。
 */
const MAX_STALE_IMPORTANCE = 5

/** 一天毫秒数 */
const MS_PER_DAY = 86_400_000

/**
 * 后台整理间隔（ms；G2 由 6 小时缩短到 1 小时，配合单批预算放大，应对记忆库规模
 * 增长后清理吞吐不足的问题。与 config 默认 maintenanceIntervalHours 的既有最小值
 * 趋近，现固定为模块内常量；导出供测试以真实常量驱动定时验证）。
 */
export const MAINTENANCE_INTERVAL_MS = 1 * 3_600_000

/**
 * LLM 子任务形状（反思/因果抽取共用）：runOnce(route, {force?}) 自含周期门控与
 * 自收容（不抛错）。结构类型注入——maintenance 不依赖具体模块，测试可用假件。
 */
interface Subtask {
  runOnce(route: { provider: string; model: string }, opts?: { force?: boolean }): Promise<unknown>
}

/** 整理任务依赖（store/logger/now 注入，便于单测）。纯规则任务不依赖 llm；反思/因果为可选 LLM 子任务 */
export interface MemoryMaintenanceDeps {
  store: MemoryStore
  logger: Pick<ReturnType<Context['logger']>, 'warn' | 'info'>
  /** 当前时刻（毫秒）；测试注入固定时钟 */
  now: () => number
  /** 反思自进化子任务（可选；注入则每批规则后按其自身周期门控执行，缺省不调 LLM） */
  reflector?: Subtask
  /** 因果抽取子任务（可选；注入则每批规则后按其自身周期门控执行，缺省不调 LLM） */
  causal?: Subtask
  /** C33：语义向量增量补齐（可选；注入则每批规则后补 BACKFILL_BUDGET 条缺失——限速分片） */
  backfill?: (budget: number) => Promise<number>
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
  /** O1：上次 runOnce 完成时刻（ISO；未运行过 null——memory_status 可观测） */
  private lastRunAtValue: string | null = null

  /** O1：上次维护运行时刻（runOnce 完成时记录；未运行 null） */
  get lastRunAt(): string | null {
    return this.lastRunAtValue
  }

  /**
   * 重入互斥：当前运行中的批次 promise。
   * 定时触发器、手动工具/RPC 触发可能并发进入 runOnce——若先后起动两次会对同一
   * 对象重复 merge/update/archive 产生重复审计。合并并发：已有批次在运行则返回
   * 同一 promise，不重复执行。规则任务幂等可安全合并；子任务（反思/因果）各自带
   * 周期门控，天然去重，不会因合并产生额外执行。
   */
  private running: Promise<void> | undefined

  constructor(private readonly deps: MemoryMaintenanceDeps) {}

  /**
   * 注册活动监听与生命周期清理。
   * - 监听 agent/pre-step 与 session/event 作为活动门（纯观察者）；
   * - agent/pre-step 为 waterfall：本类不消费也不改变决定，仅记录活动后
   *   透传 next() 的结果，保证与注入器等其它监听互不干扰；
   * - ctx.effect 注册的 disposer 随插件 fiber 停止轮询、解除活动态。
   * 整理恒启用（行为已常量化），始终接线监听与定时。
   */
  install(ctx: Context): void {
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
    this.recent = { session }
    if (!this.armed) {
      this.armed = true
      this.schedule()
    }
  }

  /** 调度下一周期（setTimeout 链；清除旧挂起句柄防重入）。R2-10/M2：间隔固定 1 小时（G2），此处不夹逼 */
  private schedule(): void {
    this.clearTimer()
    this.timer = setTimeout(() => this.onInterval(), MAINTENANCE_INTERVAL_MS)
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
   * 重入互斥：定时+手动/工具并发合并为一次（见 running 字段说明），避免对同一
   * 对象重复处理产生重复审计。全程自收容：单条处理失败仅告警并继续，批次级整体
   * 失败仅告警——后台异步任务绝不让 rejection 逃离（工程必需）。
   */
  runOnce(): Promise<void> {
    // 重入互斥：已有批次在运行 → 返回同一 promise（合并并发，不重复执行）
    if (this.running !== undefined) return this.running
    // 同步建立运行中 Promise（在进入异步体前赋值），使"批执行中再调一次"能看见它；
    // 并发方（含首个）都拿到同一个 run 引用——外层不能是 async 包装（async 函数会
    // 产生新的 promise 身份，破坏"合并为一次"的身份语义与测试断言）。
    const run = (async () => {
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
        // LLM 子任务（反思/因果抽取）：规则任务之后串行执行（各自带周期门控与自收容）。
        // 与规则任务同处 runOnce 成功路径——任一段失败仅告警不影响后续与批次完成记录。
        await this.runSubtask('向量补齐', this.deps.backfill?.(BACKFILL_BUDGET))
        await this.runSubtask('反思', this.deps.reflector?.runOnce(route))
        await this.runSubtask('因果抽取', this.deps.causal?.runOnce(route))
        // O1：批次完成时刻记录（成功路径；失败由 catch 告警且不更新——可观测"上次成功维护"）
        this.lastRunAtValue = new Date().toISOString()
      } catch (error) {
        this.deps.logger.warn('[dsh-memory] 后台记忆整理批次执行失败：', error)
      }
    })()
    // 失败清理钩子：批次体自收容（logger.warn）不会 reject，finally 派生态无拒绝；
    // 比对引用才复位——并发方已被合并到同一 run，引用不变则复位；若被替换则不覆盖。
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = undefined
    })
    return run
  }

  /**
   * 任务 a：重复合并。
   * 同 workspace + 同 kind、tokenize Jaccard ≥ 0.85、重要度差 ≤ 2 的条目对，
   * 保留新者（高重要度提升），旧者归档。
   * 注意（R2-10/M1）：每对经 getById 重读当前状态是有意为之——mergePair 会
   * 归档旧者/提升新者重要度，重读才能跳过已归档条目并感知重要度变化；
   * getById 为同步内存读（table.get），窗口 200 条（G2 由 20 放大）下约 2 万次读，
   * 仍为内存操作可接受，勿"优化"为静态快照（会破坏已归档跳过语义）。
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
        // 已被 supersede 标记的条目不再参与合并配对（P1-2 交错补盲）：窗口快照
        // 可能在 create 的 supersede 回写前取得，重读时感知——被覆盖条目已从
        // 检索隐藏，再合并会与 supersede 语义打架（可能归档"现行表述"）。
        if (a.supersededBy !== undefined || b.supersededBy !== undefined) continue
        if (a.workspace !== b.workspace || a.kind !== b.kind) continue
        if (Math.abs(a.importance - b.importance) > MAX_IMPORTANCE_DIFF) continue
        // O2：走 store.tokenJaccard 复用 token 缓存（原 jaccardOf 每对双方各
        // tokenize 一次 ≈39,800 次/批 ≈16s CPU → 缓存后 ≈40ms）
        if (this.deps.store.tokenJaccard(a, b) < JACCARD_THRESHOLD) continue
        try {
          // 新者判定：createdAt 更大者为新；同刻（并发写入/同批导入）时按 id
          // 字典序大者（与 listRecent 同刻展示序一致）——`>=` 会把先扫描者
          // 误判为新者（窗口序由 id 决定，扫描序与时间序无关，曾致归档新者，
          // P1-2 交叠补盲发现）。tie-breaker 保证合并方向确定性，不依赖扫描序。
          const newer =
            a.createdAt === b.createdAt
              ? a.id >= b.id
                ? a
                : b
              : a.createdAt > b.createdAt
                ? a
                : b
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
   * updatedAt 距今超 90 天 且 从未被访问（accessCount === 0）且 重要度 ≤ 5
   * （G2 由 3 放宽，imp 4-5 中低重要度亦收敛，imp≥6 保活）的条目归档
   * （审计 'archive' by 'system'；detail:'stale' 受 store.archive 无
   * detail 参数约束而省略——降级由审计动作与字段状态可还原）。
   */
  private async archiveStale(window: MemoryEntry[]): Promise<void> {
    const cutoff = this.deps.now() - STALE_DAYS * MS_PER_DAY
    for (const candidate of window) {
      const entry = this.deps.store.getById(candidate.id)
      if (entry === undefined || entry.status !== 'active') continue
      // 重读补查 supersededBy（与 mergeDuplicates 同语义）：窗口快照可能在并发
      // create 的 supersede 回写前取得——已被覆盖的条目不应再被降级归档
      // （"现行表述"由 create 侧 supersede 语义管理，降级会与之打架）。
      if (entry.supersededBy !== undefined) continue
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
      // 重读补查 supersededBy（与 mergeDuplicates/archiveStale 同语义）：窗口快照
      // 可能在并发 create 的 supersede 回写前取得——已被覆盖的现行表述由 create 侧
      // supersede 语义管理，标签整理不应再触碰（与归档同理，防与 supersede 打架）。
      if (entry.supersededBy !== undefined) continue
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

  /**
   * 执行一个可选 LLM 子任务（反思/因果抽取；注入缺失则跳过）。
   * 子任务自含周期门控与自收容（正常不抛错）；此处兜底再收一次——后台批次
   * 绝不让必然成功之外的 rejection 逃逸（防测试假件/异常实现上抛打翻整批）。
   */
  private async runSubtask(name: string, task: Promise<unknown> | undefined): Promise<void> {
    if (task === undefined) return
    try {
      await task
    } catch (error) {
      this.deps.logger.warn(`[dsh-memory] ${name} 子任务执行失败：`, error)
    }
  }
}
