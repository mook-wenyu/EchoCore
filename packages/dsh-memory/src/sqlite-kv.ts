/**
 * @module @echocore/dsh-memory/sqlite-kv
 *
 * SqliteKvTable：KvTable 契约的 SQLite 实现（结构性解决存储写放大与检索退化，
 * 用户拍板 2026-08-15：自建 SQLite 适配层，替代 storage-json 整文件原子写）。
 *
 * 问题：storage-json 每次写一条记忆都全量序列化+重写整个 memory.json
 * （实测 7.8MB/3667 条单写 11ms，线性退化——10 万条时 ~300ms/次）。
 *
 * 方案（架构与 storage-json 同构：内存权威态 + 持久化写链）：
 * - 内存 Map 为同步读权威态（KvTable 契约：get/entries 同步）；
 * - SQLite WAL 单条 upsert 持久化——写从 O(n) 整文件重写降为 O(1) 单页
 *   追加（WAL ~4MB 才 checkpoint）；
 * - 写链串行（update 原子读改写不交错，与 storage-domain 契约一致）；
 * - 值 JSON 序列化存储（value TEXT），键为条目 id（TEXT PRIMARY KEY）。
 *
 * 契约对齐：missing-key 语义（update 缺失键拒绝 DomainError('missing-key')）
 * 与 storage-domain 一致——store.ts 依赖此判别符，零改动接入。
 *
 * 表结构：`entries(id TEXT PRIMARY KEY, value TEXT NOT NULL)`——KvTable 语义
 * 的扁表；后续如需 WHERE kind=? 级索引可加列（当前 store 全表扫描语义不变，
 * 索引优化是未来可选增量，不改变契约）。
 */

import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'

import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * 首启迁移：把旧 storage-json 的 memory.json（tables.entries 字典）导入
 * SQLite 表。幂等语义：由调用方保证"表为空才迁移"；坏记录（校验失败）
 * 跳过并计数——绝不因单条坏数据中断整体迁移（迁移是一次性启动路径，
 * 坏条目保留在 .bak 原文件中可追溯）。
 * D2（2026-08-16 风险修复）：**整个文件 JSON 损坏**（SyntaxError）不阻断
 * 插件启动——返回 corrupt 标记，调用方记录告警并把坏文件改名 .bak 保留，
 * 插件以空库启动（与 embed-index 损坏降级语义对齐；坏文件可人工恢复）。
 * @param jsonPath memory.json 绝对路径（不存在 = 无迁移）
 * @param table 目标 SqliteKvTable（须为空表）
 * @param isValid 记录校验（memoryEntrySchema.safeParse）
 * @returns 迁移数（坏记录计入 skipped；文件损坏 corrupt=true）
 */
export async function migrateMemoryJson<V>(
  jsonPath: string,
  table: SqliteKvTable<V>,
  isValid: (raw: unknown) => boolean,
): Promise<{ migrated: number; skipped: number; corrupt: boolean }> {
  let raw: string
  try {
    raw = await readFile(jsonPath, 'utf8')
  } catch {
    return { migrated: 0, skipped: 0, corrupt: false } // 无旧文件 = 首次全新启动
  }
  let document: { tables?: { entries?: Record<string, unknown> } }
  try {
    document = JSON.parse(raw) as { tables?: { entries?: Record<string, unknown> } }
  } catch {
    return { migrated: 0, skipped: 0, corrupt: true } // 整文件损坏：调用方降级处理
  }
  const entries = document.tables?.entries ?? {}
  let migrated = 0
  let skipped = 0
  for (const [id, record] of Object.entries(entries)) {
    if (!isValid(record)) {
      skipped++
      continue
    }
    await table.put(id, record as V)
    migrated++
  }
  return { migrated, skipped, corrupt: false }
}

/** 值 JSON 序列化（SQLite 存 TEXT；对象形态仅存在于内存权威态） */
function serialize(value: unknown): string {
  return JSON.stringify(value)
}

/** 值 JSON 反序列化（加载/读取时还原对象形态） */
function deserialize(text: string): unknown {
  return JSON.parse(text) as unknown
}

/**
 * KvTable 契约的 SQLite 适配层（V = 记录对象形态，与 storage-domain 同语义）。
 * 注意：KvTable 的 entries()/keys() 要求快照迭代——内存 Map 天然满足
 * （迭代期间写只改 Map 不破坏迭代器快照语义）。
 *
 * J2（2026-08-15 预分词列）：可选 `deriveTokens` 回调——装配层注入领域分词
 * （jieba 词空格分隔），put/update 时同步写入 `content_tokens` 列。该列是
 * **未来 FTS5 索引的数据源**（unicode61 对空格分隔中文词天然可索引）——当前
 * 只写不读（5 万条规模才建 FTS 索引，YAGNI）；KvTable 通用性保持（回调注入
 * 领域逻辑，本类不感知记录结构）。
 */
export class SqliteKvTable<V> implements KvTable<string, V> {
  /** 内存权威态（同步读；KvTable 契约要求 get/entries 同步） */
  private readonly cache = new Map<string, V>()
  /** 持久化写链（串行：update 原子读改写不交错；与 storage-json 同构） */
  private chain: Promise<void> = Promise.resolve()
  /** upsert 语句（预编译复用） */
  private readonly upsertStmt
  /** delete 语句（预编译复用） */
  private readonly deleteStmt

  /**
   * @param db 已打开的 SQLite 连接（调用方负责生命周期；测试用 :memory:）
   * @param tableName 表名（默认 entries；多域隔离时传不同表名）
   * @param deriveTokens J2 可选分词派生（value → 空格分隔 token 文本；无则不写列）
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly tableName = 'entries',
    private readonly deriveTokens?: (value: V) => string,
  ) {
    // WAL：写事务日志追加（~4MB checkpoint），主库不重写——O(1) 写的前提
    this.db.exec('PRAGMA journal_mode = WAL')
    // M1（2026-08-16 风险修复）：busy_timeout 默认 0——多进程/并发写立即
    // SQLITE_BUSY 无重试窗口（SQLite 官方论坛确认 fair 默认 20 年未改）。
    // 显式 5s 等待窗口：单实例不触发（无竞争），多实例/维护撞车时有重试余地。
    this.db.exec('PRAGMA busy_timeout = 5000')
    // R5（2026-08-16 WAL 显式 checkpoint）：默认 wal_autocheckpoint=1000 页
    // （≈4MB）才触发内部 AUTO_CHECKPOINT，WAL 可在两次 checkpoint 间增长到
    // 数 MB。显式压到 256 页（256×4KB≈1MB）——更频繁自动 checkpoint 控 WAL
    // 增长；仍由 SQLite 自行调度，非阻塞（发生写才推进）。
    this.db.exec('PRAGMA wal_autocheckpoint = 256')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (id TEXT PRIMARY KEY, value TEXT NOT NULL, content_tokens TEXT)`,
    )
    this.upsertStmt = this.db.prepare(
      `INSERT INTO "${tableName}" (id, value, content_tokens) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, content_tokens = excluded.content_tokens`,
    )
    this.deleteStmt = this.db.prepare(`DELETE FROM "${tableName}" WHERE id = ?`)
    // 启动加载：SQLite → 内存权威态（与 storage-json loadAll 同语义）
    const loadStmt = this.db.prepare(`SELECT id, value FROM "${tableName}"`)
    for (const row of loadStmt.all() as Array<{ id: string; value: string }>) {
      this.cache.set(row.id, deserialize(row.value) as V)
    }
  }

  /** 读一条（同步内存） */
  get(key: string): V | undefined {
    return this.cache.get(key)
  }

  /** 快照迭代 [key, record]（内存 Map 迭代；写入排队落盘不破坏快照） */
  entries(): IterableIterator<[string, V]> {
    return this.cache.entries()
  }

  /** 快照迭代 keys */
  keys(): IterableIterator<string> {
    return this.cache.keys()
  }

  /** 当前记录数 */
  get size(): number {
    return this.cache.size
  }

  /** 插入或覆盖一条（完整覆盖写；持久化入写链） */
  put(key: string, value: V): Promise<void> {
    this.cache.set(key, value)
    return this.enqueue(() => {
      this.upsertStmt.run(key, serialize(value), this.deriveTokens?.(value) ?? null)
    })
  }

  /** 删除一条；返回是否存在（不存在无写） */
  delete(key: string): Promise<boolean> {
    const existed = this.cache.delete(key)
    return this.enqueue(() => {
      this.deleteStmt.run(key)
    }).then(() => existed)
  }

  /**
   * R5：显式 WAL checkpoint（TRUNCATE 模式）——把 WAL 中已完成事务的帧回写
   * 主库并回截 WAL 文件至 0 字节。供卸载/维护周期在空闲时主动调（控 WAL 增长，
   * 不依赖 wal_autocheckpoint=256 的内部自动调度）。TRUNCATE 返回
   * { busy, log, checkpointed } 行——busy=0 表示无其他写者挤压、全部完成；
   * 本方法只触发（返回 void），busy 语义交由调用方在需要时用 PRAGMA 自读。
   */
  checkpoint(): void {
    this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  }

  /**
   * 原子读改写：fn 看到写链槽位上的当前值（串行保证并发不交错）。
   * 缺失键拒绝 DomainError('missing-key')（与 storage-domain 契约一致，
   * store.ts 依赖该判别符做业务转换）。
   */
  update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.cache.get(key)
    if (current === undefined) {
      return Promise.reject(new DomainError('missing-key', `记录不存在：${key}`))
    }
    const next = fn(current)
    this.cache.set(key, next)
    return this.enqueue(() => {
      this.upsertStmt.run(key, serialize(next), this.deriveTokens?.(next) ?? null)
    }).then(() => next)
  }

  /**
   * 写链入队（串行持久化）。
   * D1（2026-08-16 风险修复）：任务失败**不卡死后续链**——失败当刻计数并
   * 重新上抛（本次调用方可感知），下一次 enqueue 经 rejection 分支接续执行
   * 后续任务。否则一次 I/O 失败（磁盘满/锁）会让链永久 rejected、后续持久化
   * 全部丢失（内存权威 Map 已更新——重启回滚断点前数据的隐蔽数据丢失路径）。
   */
  private enqueue(task: () => void): Promise<void> {
    const run = () => {
      try {
        task()
      } catch (error) {
        this.writeFailuresValue++
        throw error
      }
    }
    this.chain = this.chain.then(run, run)
    return this.chain
  }

  /** D1：写链累计失败次数（调用方/状态工具可观测；计数单调不归零） */
  get writeFailures(): number {
    return this.writeFailuresValue
  }

  private writeFailuresValue = 0
}
