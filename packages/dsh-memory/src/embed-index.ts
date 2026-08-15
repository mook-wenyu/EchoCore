/**
 * @module @echocore/dsh-memory/embed-index
 *
 * 嵌入索引（OPTIMIZATION_PLAN_3 P4）：记忆 id → 384 维向量，独立 JSON 文件
 * 持久化（`<数据目录>/memory-embeddings.json`）——不污染 memory.json 的
 * 条目 schema 与审计链。
 *
 * 语义（显式，非兜底）：
 * - `get(id)` 返回 undefined = "该条目尚无嵌入"（刚创建未嵌入/嵌入失败），
 *   检索融合时该条目只用关键词分——这是索引的附加层语义，不是吞错；
 * - 维护路径：启动全量补齐（ensureAll，后台） + 新建增量（indexEntry，
 *   fire-and-forget） + 归档移除（remove）；
 * - 嵌入文本 = entry.content（不含 tags：tags 变化无需重建索引，KISS；
 *   关键词路径仍覆盖 tags 命中）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { MemoryEntry } from './types.js'

/** R2：持久化去抖窗口（ms）——高频 indexEntry/remove 合并为一次整写 */
export const PERSIST_DEBOUNCE_MS = 10_000

/** 嵌入索引依赖 */
export interface EmbeddingIndexDeps {
  /** 索引文件绝对路径（JSON：{ [id]: number[] }；装配层按后端维度隔离命名） */
  file: string
  /** 嵌入服务（state==='ready' 才调用 embed；dimension = 后端输出维度，动态校验用） */
  service: {
    state: string
    /** 后端输出维度（本地 384 / 远程配置值）——索引校验与持久化按此维度 */
    dimension: number
    embed(text: string): Promise<Float32Array>
  }
  /** 全量构建取数（listRecent(超大 limit) 语义 = 全量 active 列表） */
  listAll(): MemoryEntry[]
  /** 嵌入/持久化故障记录（装配层注入 logger） */
  logWarn: (message: string, error?: unknown) => void
}

export class EmbeddingIndex {
  /** id → 向量（进程内权威态；JSON 文件为持久层） */
  private readonly vectors = new Map<string, number[]>()
  /** 全量构建串行锁（并发调用合并为一次） */
  private building: Promise<void> | undefined
  /** 持久化串行队列（P0-1：并发 persist 互斥，见 persist()） */
  private persistChain: Promise<void> | undefined

  constructor(private readonly deps: EmbeddingIndexDeps) {}

  /** 从 JSON 文件加载（文件不存在 = 空索引，正常首启状态） */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.deps.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    // P0-1：损坏 JSON（并发 rename 竞态/手工编辑产物）降级为空索引 + 告警——
    // 嵌入层语义本为"可选附加层"（缺失向量仅影响语义召回），损坏文件不应让
    // 插件整体加载失败；显式降级（logWarn）非静默吞错。
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (error) {
      this.deps.logWarn('[dsh-memory] 嵌入索引文件损坏（解析失败，已按空索引加载；可删除该文件后重启重建）：', error)
      return
    }
    for (const [id, vector] of Object.entries(parsed)) {
      if (
        Array.isArray(vector) &&
        vector.length === this.deps.service.dimension &&
        vector.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        this.vectors.set(id, vector as number[])
      } else {
        this.deps.logWarn(`[dsh-memory] 嵌入索引含畸形向量（跳过）：${id}`)
      }
    }
  }

  /** 读取向量；undefined = 尚无嵌入（显式语义，见模块头） */
  get(id: string): number[] | undefined {
    return this.vectors.get(id)
  }

  /** 全量补齐缺失条目（后台调用；串行锁防并发重复构建） */
  ensureAll(): Promise<void> {
    if (this.building !== undefined) return this.building
    this.building = this.buildMissing()
      .catch((error: unknown) => {
        this.deps.logWarn('[dsh-memory] 嵌入全量构建失败（缺失条目将保持纯关键词检索）：', error)
      })
      .finally(() => {
        this.building = undefined
      })
    return this.building
  }

  /** 新建条目增量嵌入（fire-and-forget：写入路径不因嵌入变慢；失败仅记录） */
  indexEntry(entry: MemoryEntry): void {
    void this.embedOne(entry).catch((error: unknown) => {
      this.deps.logWarn(`[dsh-memory] 嵌入失败（记忆 ${entry.id}，保持纯关键词检索）：`, error)
    })
  }

  /** 归档条目移除向量（与持久层同步，防陈旧向量占检索分） */
  remove(id: string): void {
    if (this.vectors.delete(id)) this.persist()
  }

  /** 逐条嵌入缺失条目并持久化（全量补齐后立即落盘——不等去抖窗口） */
  private async buildMissing(): Promise<void> {
    const missing = this.deps.listAll().filter((entry) => !this.vectors.has(entry.id))
    if (missing.length === 0) return
    for (const entry of missing) {
      const vector = await this.deps.service.embed(entry.content)
      this.vectors.set(entry.id, Array.from(vector))
    }
    await this.flushPersist()
  }

  /** 单条嵌入（供 indexEntry 调用；持久化走 R2 去抖） */
  private async embedOne(entry: MemoryEntry): Promise<void> {
    const vector = await this.deps.service.embed(entry.content)
    this.vectors.set(entry.id, Array.from(vector))
    this.persist()
  }

  /**
   * R2（2026-08-15）：去抖持久化——indexEntry/remove 高频调用合并为
   * PERSIST_DEBOUNCE_MS 窗口一次整写（原实现每条新记忆全量写 7MB JSON，
   * 与旧 memory.json 的 O(n) 整写同构病）。向量索引是可重建的派生层
   * （启动 ensureAll 补齐）——进程退出丢最后窗口内的落盘可接受。
   * 内存 Map 是权威态（检索读内存），持久化仅服务重启恢复。
   */
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private dirty = false

  private persist(): void {
    this.dirty = true
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.flushPersist()
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * 立即持久化（去抖窗口内合并；buildMissing/卸载前调用保证落盘）。
   * 公开供装配层卸载时 flush + 测试确定性断言。
   */
  flush(): Promise<void> {
    return this.flushPersist()
  }

  /** 立即持久化（去抖窗口内合并；buildMissing/卸载前调用保证落盘） */
  private flushPersist(): Promise<void> {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    // P0-1：promise 队列串行化——并发 flush 时写同一 tmp 文件会交错，
    // 队列保证任意时刻至多一个写事务；写的是调用时点 vectors 快照。
    const next = this.persistChain === undefined ? this.persistNow() : this.persistChain.then(() => this.persistNow(), () => this.persistNow())
    this.persistChain = next
    return next
  }

  /** 实际写事务（仅由 persist 队列调用，保证串行） */
  private async persistNow(): Promise<void> {
    await mkdir(dirname(this.deps.file), { recursive: true })
    const tmp = `${this.deps.file}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.vectors)), 'utf8')
    await rename(tmp, this.deps.file)
  }
}
