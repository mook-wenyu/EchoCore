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

/**
 * 嵌入批次大小（用户拍板 128/批，2026-08-17；与 EmbeddingService.embedMany 一致）。
 * 维护侧 BACKFILL_BUDGET 已调优至 512（夜间可 1024），单周期需 4 批（512/128）；
 * 嵌入侧批次大小保持 128 不变，批次内事务"全有或全无"，与维护预算协同收敛。
 */
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

/** 余弦相似度（C34：反思语义门/语义工具共用）。向量未归一化 → 显式除以模长。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
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
  /**
   * vec0 表名（2026-08-20 Q3=B 拍板升级为第二代表 vec2_*：新增 workspace metadata 列
   * 支持 KNN 过滤下推——实证 @photostructure/sqlite-vec@1.2.0 支持等值过滤，跨域最近邻
   * 在 SQLite 层被排除，本域语义榜不再被其它 workspace 条目挤占）。
   */
  readonly table: string
  /** 上一代表名（无 workspace 列；构造时若存在则自动迁移到新表并清理） */
  private readonly legacyTable: string
  /** UPSERT 用：按 memory_id 查找既有 rowid */
  private readonly findRowStmt
  /** 按 memory_id 删除 */
  private readonly deleteStmt
  /** 按 memory_id 取向量（C34：反思语义门/审计展示） */
  private readonly getVecStmt
  /** 全量已有 memory_id（ensureAll 差集） */
  private readonly listIdsStmt
  /** 全量构建串行锁（并发 ensureAll/backfill 合并为一次；Promise<unknown> 容纳两条路径的返回值） */
  private building: Promise<unknown> | undefined

  constructor(private readonly deps: EmbeddingIndexDeps) {
    const { db, service } = deps
    if (!loadedDbs.has(db)) {
      // 加载 sqlite-vec 扩展（getLoadablePath → dist/<platform>-<arch>/vec0.dll）
      db.loadExtension(getLoadablePath())
      loadedDbs.add(db)
    }
    this.table = `vec2_memory_${service.dimension}`
    this.legacyTable = `vec_memory_${service.dimension}`
    // vec0 表：embedding float[dim] + cosine 度量 + metadata 列
    // （memory_id/workspace——workspace 为 KNN 过滤下推列，值以 entries 表为权威源）
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${this.table}" USING vec0(embedding float[${service.dimension}] distance_metric=cosine, ${MID_COL} TEXT, workspace TEXT);`,
    )
    this.findRowStmt = db.prepare(`SELECT rowid FROM "${this.table}" WHERE ${MID_COL} = ? LIMIT 1`)
    this.deleteStmt = db.prepare(`DELETE FROM "${this.table}" WHERE ${MID_COL} = ?`)
    this.getVecStmt = db.prepare(`SELECT embedding FROM "${this.table}" WHERE ${MID_COL} = ? LIMIT 1`)
    this.listIdsStmt = db.prepare(`SELECT ${MID_COL} FROM "${this.table}"`)
    // 存量旧代表迁移（R2-Q2=A）：二进制复制不重嵌；幂等，失败不阻断挂载
    this.migrateLegacyDimension()
  }

  /**
   * 存量旧代表迁移（R2-Q2=A 拍板）：旧 vec_memory_<dim>（无 workspace 列）→ 新表
   * 二进制复制。幂等：旧表不存在即跳过；新表已有数据时仅清理旧表残留。workspace 以
   * listAll()（entries 表）为权威源，库中不存在的 id 不迁移（无归属依据防跨域污染）；
   * 维度异常行跳过（防 KNN MATCH 维度错乱）。事务包批全有或全无；失败告警保留旧表
   * 待下轮重试，缺失向量由 backfill 收敛（与 loadLegacy 同降级语义，不阻断挂载）。
   */
  private migrateLegacyDimension(): void {
    const exists = this.deps.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(this.legacyTable)
    if (exists === undefined) return
    try {
      if ((this.listIdsStmt.all() as unknown[]).length === 0) {
        const wsOf = new Map(this.deps.listAll().map((entry) => [entry.id, entry.workspace]))
        const rows = this.deps.db
          .prepare(`SELECT ${MID_COL}, embedding FROM "${this.legacyTable}"`)
          .all() as Array<{ [MID_COL]: string; embedding: Uint8Array }>
        let migrated = 0
        let skipped = 0
        this.deps.db.exec('BEGIN')
        try {
          for (const row of rows) {
            const ws = wsOf.get(row[MID_COL])
            if (ws === undefined) {
              skipped++
              continue
            }
            const vector = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
            if (vector.length !== this.deps.service.dimension) {
              skipped++
              continue
            }
            this.writeVector(row[MID_COL], vector, ws)
            migrated++
          }
          this.deps.db.exec('COMMIT')
        } catch (error) {
          this.deps.db.exec('ROLLBACK')
          throw error
        }
        this.deps.logWarn(
          `[dsh-memory] 向量表升级迁移完成：${this.legacyTable} → ${this.table}（复制 ${migrated} 条，跳过 ${skipped} 条无归属/维度异常）`,
        )
      }
      // DROP 主虚拟表：sqlite vtab xDestroy 级联清理影子表（与 dropOtherDimensionTables 同语义）
      this.deps.db.exec(`DROP TABLE IF EXISTS "${this.legacyTable}"`)
    } catch (error) {
      this.deps.logWarn('[dsh-memory] 向量表升级迁移失败（旧表保留待下轮，缺失向量由补齐收敛）：', error)
    }
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
   * workspace：Q3=B 下推过滤列（UPDATE 同步刷新防归属变化残留；缺省写空串——
   * 等值过滤永不命中空串，仅无过滤 KNN 可见；生产路径恒有 workspace）。
   */
  private writeVector(id: string, vector: Float32Array, workspace?: string): void {
    const existing = this.findRowStmt.get(id) as { rowid: number } | undefined
    const lit = vecLiteral(vector)
    if (existing !== undefined) {
      this.deps.db.exec(
        `UPDATE "${this.table}" SET embedding = ${lit}, workspace = ${EmbeddingIndex.esc(workspace ?? '')} WHERE rowid = ${existing.rowid}`,
      )
    } else {
      this.deps.db.exec(
        `INSERT INTO "${this.table}"(${MID_COL}, workspace, embedding) VALUES (${EmbeddingIndex.esc(id)}, ${EmbeddingIndex.esc(workspace ?? '')}, ${lit})`,
      )
    }
  }

  /**
   * 语义 KNN 检索（甲方案主路径）：查询向量 → top-k 近邻（cosine 降序）→
   * `{ id, cosine }[]`（store 语义榜消费，SQLite C+SIMD brute-force）。
   * k 由 store 按榜单宽度派生（semanticTopK，>1M 条前 brute-force 即最优）。
   * 查询向量经内联字面量（vec0 对 embedding 列绑定参数整体拒绝，见 writeVector）。
   * workspace：Q3=B 拍板（2026-08-20）metadata 过滤下推——跨域条目在 SQLite 层被
   * 排除，本域语义榜不再被其它 workspace 挤占；undefined = 不过滤（全库检索语义，
   * 供无 workspace 场景的工具使用）。
   */
  knn(queryVector: Float32Array, k: number, workspace?: string): Array<{ id: string; cosine: number }> {
    const filter = workspace === undefined ? '' : ` AND workspace = ${EmbeddingIndex.esc(workspace)}`
    const rows = this.deps.db
      .prepare(
        `SELECT ${MID_COL}, distance FROM "${this.table}" WHERE embedding MATCH ${vecLiteral(queryVector)} AND k = ${k}${filter} ORDER BY distance`,
      )
      .all() as Array<{ [MID_COL]: string; distance: number }>
    return rows.map((row) => ({ id: row[MID_COL], cosine: 1 - row.distance }))
  }

  /** 新建条目增量嵌入（UPDATE-or-INSERT：同 id 重嵌覆盖不堆积；workspace 随条目写入） */
  async indexEntry(entry: MemoryEntry): Promise<void> {
    const vector = await this.deps.service.embed(entry.content)
    this.writeVector(entry.id, vector, entry.workspace)
  }

  /** 归档/覆盖条目移除向量（同步行删；与持久层即时一致） */
  remove(id: string): void {
    this.deleteStmt.run(id)
  }

  /** 按 memory_id 取向量（C34：反思语义门——双侧有向量时以 cosine≥0.75 为合并
   * 主门，对齐 ai-memory CONSOLIDATE_COSINE_THRESHOLD；无向量条目回退 Jaccard）。
   * 未命中返回 undefined（缺失/归档条目）。 */
  getVector(id: string): Float32Array | undefined {
    const row = this.getVecStmt.get(id) as { embedding: Uint8Array } | undefined
    if (row === undefined) return undefined
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
  }

  /**
   * 清理其它维度表（Q2 拍板 2026-08-17；Q3=B 升级 2026-08-20 兼容两代命名）：
   * 维度切换/表升级后旧表不再被引用（迁移/ensureAll 已收敛当前维度数据）
   * —— DROP 防表无界堆积。安全过滤：只处理本插件的 `vec_memory_%` /
   * `vec2_memory_%` 命名空间，且跳过当前表；名字经单引号转义防注入。
   * 装配层在 ready 且本维度表已建后调用（数据文件冗余清理，非迁移路径）。
   */
  dropOtherDimensionTables(): void {
    const current = this.table
    const rows = this.deps.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'vec_memory_%' OR name LIKE 'vec2_memory_%')`)
      .all() as Array<{ name: string }>
    for (const row of rows) {
      if (row.name === current) continue
      // 仅 DROP 纯维度表名 vec[_2]_memory_<digits>：sqlite-vec 会为每个 vec0 表建影子表
      // （vec_memory_<dim>_info/_rowid/_chunks 等），影子表受 SQLite 保护不可 DROP
      // （"may not be dropped"）——必须跳过；非本插件命名空间同样不碰。
      if (!/^vec\d*_memory_\d+$/.test(row.name)) continue
      const name = row.name.replace(/'/g, "''")
      this.deps.db.exec(`DROP TABLE IF EXISTS "${name}"`)
    }
  }

  /** 全量补齐缺失条目（128/批批量嵌入；失败批跳过——缺失保持关键词检索）。
   * 语义 = backfill(∞)：一次性补完。与 backfill 共用 building 串行锁。 */
  ensureAll(): Promise<void> {
    return this.backfill(Number.POSITIVE_INFINITY).then(() => undefined)
  }

  /**
   * 增量补齐（C33，2026-08-18 拍板）：一次性处理**至多 budget 条**缺失条目
   * （128/批；失败批跳过——缺失保持纯关键词检索，显式语义），返回本批处理数。
   * 维护周期内调用＝持续分片补齐（限速：每周期只补一档，避免启动瞬间打满远程
   * API 触发限流；覆盖随周期收敛）。与 ensureAll 共用 building 串行锁——并发
   * 调用合并为一次（并发方 await 后返回 0，由进行中的批次实际处理）。
   */
  backfill(budget: number): Promise<number> {
    if (this.building !== undefined) {
      // 并发合并：等待进行中的批次完成后返回 0（保守观测；实际由该批次处理）
      return this.building.then(() => 0)
    }
    const run = this.buildMissing(budget)
      .catch((error: unknown) => {
        this.deps.logWarn('[dsh-memory] 嵌入补齐失败（缺失条目将保持纯关键词检索）：', error)
        return 0
      })
      .finally(() => {
        this.building = undefined
      })
    this.building = run
    return run
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
    // workspace 以 entries 表为权威源（旧 JSON 无此信息）；无归属 id 跳过防跨域污染
    const wsOf = new Map(this.deps.listAll().map((entry) => [entry.id, entry.workspace]))
    for (const [id, value] of Object.entries(parsed)) {
      // Q2 拍板：迁移严格按当前表维度校验——历史配置维度遗留的错误维度向量
      // 不得落库（vec0 列维度写死，混维行会让 KNN MATCH 报维度错误）
      const vector = parseJsonVec(value, this.deps.service.dimension)
      if (vector === undefined) {
        this.deps.logWarn(`[dsh-memory] 旧嵌入索引含畸形或维度不匹配向量（跳过）：${id}`)
        continue
      }
      const ws = wsOf.get(id)
      if (ws === undefined) {
        this.deps.logWarn(`[dsh-memory] 旧嵌入索引含库中不存在的条目（跳过）：${id}`)
        continue
      }
      this.writeVector(id, vector, ws)
      migrated++
    }
    return migrated
  }

  /** 全量补齐实现（limit 预算：≤limit 条后停止；∞=全量。返回实际处理数） */
  private async buildMissing(limit = Number.POSITIVE_INFINITY): Promise<number> {
    const existing = new Set((this.listIdsStmt.all() as Array<{ [MID_COL]: string }>).map((row) => row[MID_COL]))
    const missing = this.deps.listAll().filter((entry) => !existing.has(entry.id))
    if (missing.length === 0) return 0
    let processed = 0
    const batch = this.deps.service.embedMany
    if (batch !== undefined) {
      for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
        // 预算须在**批内**生效：批大小与剩余预算取 min（预算 < 批大小时不被整批越过）
        const take = Math.min(EMBED_BATCH_SIZE, limit - processed)
        if (take <= 0) break
        const chunk = missing.slice(i, i + take)
        try {
          const vectors = await batch(chunk.map((entry) => entry.content))
          // 4c（Q7 拍板）：单批写包进一个 SQLite 事务——向量落库从"逐行自动提交"
          // 变"批内全有或全无"（sqlite-vec 官方批写建议）；批次中途写失败整批回滚
          // 不留半批，由 catch 记录——缺失保持纯关键词检索（与批次错误语义一致）。
          this.deps.db.exec('BEGIN')
          try {
            for (let j = 0; j < chunk.length; j++) this.writeVector(chunk[j]!.id, vectors[j]!, chunk[j]!.workspace)
            this.deps.db.exec('COMMIT')
          } catch (error) {
            this.deps.db.exec('ROLLBACK')
            throw error
          }
          processed += chunk.length
        } catch (error) {
          // 批次失败显式记录并继续下一批——缺失条目保持纯关键词检索（显式语义）
          this.deps.logWarn(`[dsh-memory] 嵌入批次失败（${chunk.length} 条保持纯关键词检索）：`, error)
        }
      }
      return processed
    }
    // 无批量能力（测试注入假后端）：逐条回退（整体包事务——中途失败整批回滚，
    // 与批量路径的"批内全有或全无"一致；同样受 limit 预算约束）
    this.deps.db.exec('BEGIN')
    try {
      for (const entry of missing) {
        if (processed >= limit) break
        const vector = await this.deps.service.embed(entry.content)
        this.writeVector(entry.id, vector, entry.workspace)
        processed++
      }
      this.deps.db.exec('COMMIT')
    } catch (error) {
      this.deps.db.exec('ROLLBACK')
      throw error
    }
    return processed
  }
}