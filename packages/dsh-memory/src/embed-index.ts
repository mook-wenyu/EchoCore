/**
 * @module @echocore/dsh-memory/embed-index
 *
 * 嵌入索引（sqlite-vec vec0 虚拟表，2026-08-17 用户拍板：
 * `@photostructure/sqlite-vec` 生产 fork）。
 *
 * 原实现把向量存为独立 JSON 数字数组文件（`memory-embeddings-<dim>.json`）：
 * 2560 维 × 6500 条 ≈ 317MB 文本——10s 去抖整写写放大、启动全量 JSON.parse、
 * 内存 number[] 膨胀（~16.8M 个 JS number ≈ 134MB+）。实测量化与权威依据
 * （FAISS 官方选型指南：百万条以下暴力检索即最优；sqlite-vec 官方：
 * brute-force 到 >1M 高维才慢；BLOB 是 SQLite 向量的生态最佳实践）：
 *
 * 重构为 vec0 虚拟表（同一 memory.sqlite 文件，与 SqliteKvTable 共用连接）：
 * - 向量以 float32 二进制 (X'hex') 存储——每维 4 字节，6500×2560 ≈ 64MB；
 * - 写入 = 行级 upsert（WAL O(1)），无整文件重写；
 * - 检索 = SQL KNN（`embedding MATCH ? AND k = ?`，C+SIMD brute-force，
 *   cosine 度量）——替代进程内全量余弦；
 * - 检索/写入均不需内存驻留全量向量（vec0 数据即权威态）。
 *
 * 维度隔离：表名 `vec_memory_<dim>`（本地 384 / 远程配置值）——换维度自动
 * 新表，与旧 JSON 文件按维度隔离同构。
 */

import { DatabaseSync } from 'node:sqlite'

import { getLoadablePath } from '@photostructure/sqlite-vec'

import type { MemoryEntry } from './types.js'

/** 嵌入批次大小（用户拍板 128/批，2026-08-17；与 EmbeddingService.embedMany 一致） */
export const EMBED_BATCH_SIZE = 128

/** 嵌入索引依赖 */
export interface EmbeddingIndexDeps {
  /**
   * 已打开的 SQLite 连接（须以 `allowExtension: true` 构造方可 loadExtension；
   * 与 SqliteKvTable 共用 memory.sqlite——单一数据文件）。
   */
  db: DatabaseSync
  /** 嵌入服务（embed/embedMany；dimension = 后端输出维度，表名/建表据此） */
  service: {
    state: string
    /** 后端输出维度（本地 384 / 远程配置值）——vec0 表列 float[dim] 据此 */
    dimension: number
    embed(text: string): Promise<Float32Array>
    /** 批量嵌入（可选）：缺失时回退逐条（测试注入假后端） */
    embedMany?(texts: string[]): Promise<Float32Array[]>
  }
  /** 全量构建取数（listRecent(超大 limit) 语义 = 全量 active 列表） */
  listAll(): MemoryEntry[]
  /** 嵌入/迁移故障记录（装配层注入 logger） */
  logWarn: (message: string, error?: unknown) => void
}

/** 模块级已加载扩展的数据库连接集合（loadExtension 每连接一次，防重复加载报错） */
const loadedDbs = new WeakSet<object>()

/** 记忆 id 列名（vec0 metadata 列——KNN 结果经此回到条目域） */
const MID_COL = 'memory_id'

/** Float32Array → vec0 二进制向量字面量（float32 little-endian, X'hex'）：
 * 全精度（优于 JSON 数字文本的 toFixed 截断）+ 体积最小（4 字节/维）。 */
function vecLiteral(vector: Float32Array): string {
  return `X'${Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('hex')}'`
}

/** JSON 数字数组 → Float32Array（旧 JSON 索引文件迁移源的读侧换算）。
 * 可选 expectedLength：不等于该值时视为**维度不匹配**（历史配置维度遗留）——
 * 返回 undefined 由调用方跳过并告警，防错误维度行落库（Q2 拍板：免得 KNN
 * MATCH 维度错乱）。为空/含非有限数同样视为畸形返回 undefined。 */
function parseJsonVec(list: unknown, expectedLength?: number): Float32Array | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined
  if (expectedLength !== undefined && list.length !== expectedLength) return undefined
  const array = new Float32Array(list.length)
  for (let i = 0; i < list.length; i++) {
    const n = list[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
    array[i] = n
  }
  return array
}

export class EmbeddingIndex {
  /** vec0 表名（维度隔离：本地 384 / 远程配置值） */
  readonly table: string
  /** UPSERT 用：按 memory_id 查找既有 rowid */
  private readonly findRowStmt
  /** 按 memory_id 删除 */
  private readonly deleteStmt
  /** 全量已有 memory_id（ensureAll 差集） */
  private readonly listIdsStmt
  /** 全量构建串行锁（并发 ensureAll 合并为一次） */
  private building: Promise<void> | undefined

  constructor(private readonly deps: EmbeddingIndexDeps) {
    const { db, service } = deps
    if (!loadedDbs.has(db)) {
      // 加载 sqlite-vec 扩展（getLoadablePath → dist/<platform>-<arch>/vec0.dll）
      db.loadExtension(getLoadablePath())
      loadedDbs.add(db)
    }
    this.table = `vec_memory_${service.dimension}`
    // vec0 表：embedding float[dim] + cosine 度量 + memory_id metadata 列
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${this.table}" USING vec0(embedding float[${service.dimension}] distance_metric=cosine, ${MID_COL} TEXT);`,
    )
    this.findRowStmt = db.prepare(`SELECT rowid FROM "${this.table}" WHERE ${MID_COL} = ? LIMIT 1`)
    this.deleteStmt = db.prepare(`DELETE FROM "${this.table}" WHERE ${MID_COL} = ?`)
    this.listIdsStmt = db.prepare(`SELECT ${MID_COL} FROM "${this.table}"`)
  }

  /** SQL 字符串字面量转义（memory_id 拼进动态 SQL——vec0 的 embedding 列绑定参数
   * 有解析缺陷（实测 "Input does not start with '['"/"Only integers...")，向量一律
   * 内联字面量；memory_id 为外部输入走标准单引号转义防注入） */
  private static esc(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
  }

  /**
   * 写一条向量（UPDATE-or-INSERT，动态 SQL 内联向量字面量）：
   * 实测 vec0 对 embedding 列 prepared 绑定参数整体拒绝（二进制/JSON 文本均
   * "Input does not start with '['"），内联 X'hex' 字面量则正常——见模块头。
   */
  private writeVector(id: string, vector: Float32Array): void {
    const existing = this.findRowStmt.get(id) as { rowid: number } | undefined
    const lit = vecLiteral(vector)
    if (existing !== undefined) {
      this.deps.db.exec(`UPDATE "${this.table}" SET embedding = ${lit} WHERE rowid = ${existing.rowid}`)
    } else {
      this.deps.db.exec(`INSERT INTO "${this.table}"(${MID_COL}, embedding) VALUES (${EmbeddingIndex.esc(id)}, ${lit})`)
    }
  }

  /**
   * 语义 KNN 检索（甲方案主路径）：查询向量 → top-k 近邻（cosine 降序）→
   * `{ id, cosine }[]`（store 语义榜消费，SQLite C+SIMD brute-force）。
   * k 由 store 按榜单宽度派生（semanticTopK，>1M 条前 brute-force 即最优）。
   * 查询向量经内联字面量（vec0 对 embedding 列绑定参数整体拒绝，见 writeVector）。
   */
  knn(queryVector: Float32Array, k: number): Array<{ id: string; cosine: number }> {
    const rows = this.deps.db
      .prepare(
        `SELECT ${MID_COL}, distance FROM "${this.table}" WHERE embedding MATCH ${vecLiteral(queryVector)} AND k = ${k} ORDER BY distance`,
      )
      .all() as Array<{ [MID_COL]: string; distance: number }>
    return rows.map((row) => ({ id: row[MID_COL], cosine: 1 - row.distance }))
  }

  /** 新建条目增量嵌入（UPDATE-or-INSERT：同 id 重嵌覆盖不堆积） */
  async indexEntry(entry: MemoryEntry): Promise<void> {
    const vector = await this.deps.service.embed(entry.content)
    this.writeVector(entry.id, vector)
  }

  /** 归档/覆盖条目移除向量（同步行删；与持久层即时一致） */
  remove(id: string): void {
    this.deleteStmt.run(id)
  }

  /**
   * 清理其它维度表（Q2 拍板 2026-08-17）：维度切换后旧维度 vec0 表
   * （vec_memory_<dim>）不再被引用（ensureAll 已按当前维度重嵌全部缺失条目）
   * —— DROP 防表随维度切换无界堆积。安全过滤：只处理本插件的
   * `vec_memory_%` 命名空间，且跳过当前表；名字经单引号转义防注入。
   * 装配层在 ready 且本维度表已建后调用（数据文件冗余清理，非迁移路径）。
   */
  dropOtherDimensionTables(): void {
    const current = this.table
    const rows = this.deps.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_memory_%'`)
      .all() as Array<{ name: string }>
    for (const row of rows) {
      if (row.name === current) continue
      // 仅 DROP 纯维度表名 vec_memory_<digits>：sqlite-vec 会为每个 vec0 表建影子表
      // （vec_memory_<dim>_info/_rowid/_chunks 等），影子表受 SQLite 保护不可 DROP
      // （"may not be dropped"）——必须跳过；非本插件命名空间同样不碰。
      if (!/^vec_memory_\d+$/.test(row.name)) continue
      const name = row.name.replace(/'/g, "''")
      this.deps.db.exec(`DROP TABLE IF EXISTS "${name}"`)
    }
  }

  /** 全量补齐缺失条目（128/批批量嵌入；失败批跳过——缺失保持关键词检索） */
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

  /** 旧 JSON 索引文件迁移（首启路径）：表非空（幂等守卫——重启/重复调用不
   * 重复迁移）时跳过；读 JSON → 全量插入 vec0 → 返回迁移数 */
  async loadLegacy(jsonFile: string): Promise<number> {
    const count = (this.listIdsStmt.all() as unknown[]).length
    if (count > 0) return 0 // 表已有数据：视为已迁移（防同 id 重复行堆积）
    const { readFile } = await import('node:fs/promises')
    let raw: string
    try {
      raw = await readFile(jsonFile, 'utf8')
    } catch (error) {
      // Q6⑨：ENOENT = 无旧 JSON 文件（正常无迁移）；其它 IO 错误（EACCES 等）→ 仅告警
      // 并继续——迁移是附属路径，缺失向量由 ensureAll 按当前条目补齐，失败不阻断插件
      // 加载（与 EmbeddingService 侧"模型目录不可读即 error"语义分界：那是主嵌入路径）。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.logWarn(`[dsh-memory] 旧嵌入索引读取失败（${jsonFile}）：`, error)
      }
      return 0
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (error) {
      this.deps.logWarn('[dsh-memory] 旧嵌入索引 JSON 损坏（视为无迁移，可删除后重建）：', error)
      return 0
    }
    let migrated = 0
    for (const [id, value] of Object.entries(parsed)) {
      // Q2 拍板：迁移严格按当前表维度校验——历史配置维度遗留的错误维度向量
      // 不得落库（vec0 列维度写死，混维行会让 KNN MATCH 报维度错误）
      const vector = parseJsonVec(value, this.deps.service.dimension)
      if (vector === undefined) {
        this.deps.logWarn(`[dsh-memory] 旧嵌入索引含畸形或维度不匹配向量（跳过）：${id}`)
        continue
      }
      this.writeVector(id, vector)
      migrated++
    }
    return migrated
  }

  /** 全量补齐实现（详述见 ensureAll） */
  private async buildMissing(): Promise<void> {
    const existing = new Set((this.listIdsStmt.all() as Array<{ [MID_COL]: string }>).map((row) => row[MID_COL]))
    const missing = this.deps.listAll().filter((entry) => !existing.has(entry.id))
    if (missing.length === 0) return
    const batch = this.deps.service.embedMany
    if (batch !== undefined) {
      for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
        const chunk = missing.slice(i, i + EMBED_BATCH_SIZE)
        try {
          const vectors = await batch(chunk.map((entry) => entry.content))
          // 4c（Q7 拍板）：单批写包进一个 SQLite 事务——向量落库从"逐行自动提交"
          // 变"批内全有或全无"（sqlite-vec 官方批写建议）；批次中途写失败整批回滚
          // 不留半批，由 catch 记录——缺失保持纯关键词检索（与批次错误语义一致）。
          this.deps.db.exec('BEGIN')
          try {
            for (let j = 0; j < chunk.length; j++) this.writeVector(chunk[j]!.id, vectors[j]!)
            this.deps.db.exec('COMMIT')
          } catch (error) {
            this.deps.db.exec('ROLLBACK')
            throw error
          }
        } catch (error) {
          // 批次失败显式记录并继续下一批——缺失条目保持纯关键词检索（显式语义）
          this.deps.logWarn(`[dsh-memory] 嵌入批次失败（${chunk.length} 条保持纯关键词检索）：`, error)
        }
      }
      return
    }
    // 无批量能力（测试注入假后端）：逐条回退（整体包事务——中途失败整批回滚，
    // 与批量路径的"批内全有或全无"一致）
    this.deps.db.exec('BEGIN')
    try {
      for (const entry of missing) {
        const vector = await this.deps.service.embed(entry.content)
        this.writeVector(entry.id, vector)
      }
      this.deps.db.exec('COMMIT')
    } catch (error) {
      this.deps.db.exec('ROLLBACK')
      throw error
    }
  }
}