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

/** 索引文件内嵌的维度校验（防手工编辑损坏产生垃圾向量） */
export const EMBEDDING_DIMENSION = 384

/** 嵌入索引依赖 */
export interface EmbeddingIndexDeps {
  /** 索引文件绝对路径（JSON：{ [id]: number[] }） */
  file: string
  /** 嵌入服务（state==='ready' 才调用 embed） */
  service: {
    state: string
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
        vector.length === EMBEDDING_DIMENSION &&
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
    if (this.vectors.delete(id)) void this.persist()
  }

  /** 逐条嵌入缺失条目并持久化 */
  private async buildMissing(): Promise<void> {
    const missing = this.deps.listAll().filter((entry) => !this.vectors.has(entry.id))
    if (missing.length === 0) return
    for (const entry of missing) {
      const vector = await this.deps.service.embed(entry.content)
      this.vectors.set(entry.id, Array.from(vector))
    }
    await this.persist()
  }

  /** 单条嵌入（供 indexEntry 调用） */
  private async embedOne(entry: MemoryEntry): Promise<void> {
    const vector = await this.deps.service.embed(entry.content)
    this.vectors.set(entry.id, Array.from(vector))
    await this.persist()
  }

  /** 原子持久化：写临时文件后 rename（防半截文件） */
  private persist(): Promise<void> {
    // P0-1：promise 队列串行化——fire-and-forget 的 indexEntry/remove 可并发进入
    // persist，并发写同一 `${file}.tmp` 会让 rename 落在写入中的局部（半截文件）。
    // 队列保证任意时刻至多一个写事务；每次写的是调用时点的 vectors 快照，后写
    // 覆盖先写，末次写即最终态。写失败沿 promise 上抛（indexEntry/remove 调用方
    // 各自记录），链上失败不阻断后续写（双处理器接续队列）。
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
