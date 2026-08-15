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
 * @param jsonPath memory.json 绝对路径（不存在 = 无迁移）
 * @param table 目标 SqliteKvTable（须为空表）
 * @param isValid 记录校验（memoryEntrySchema.safeParse）
 * @returns 迁移数（坏记录计入 skipped）
 */
export async function migrateMemoryJson(
  jsonPath: string,
  table: SqliteKvTable<unknown>,
  isValid: (raw: unknown) => boolean,
): Promise<{ migrated: number; skipped: number }> {
  let raw: string
  try {
    raw = await readFile(jsonPath, 'utf8')
  } catch {
    return { migrated: 0, skipped: 0 } // 无旧文件 = 首次全新启动
  }
  const document = JSON.parse(raw) as { tables?: { entries?: Record<string, unknown> } }
  const entries = document.tables?.entries ?? {}
  let migrated = 0
  let skipped = 0
  for (const [id, record] of Object.entries(entries)) {
    if (!isValid(record)) {
      skipped++
      continue
    }
    await table.put(id, record)
    migrated++
  }
  return { migrated, skipped }
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
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly tableName = 'entries',
  ) {
    // WAL：写事务日志追加（~4MB checkpoint），主库不重写——O(1) 写的前提
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (id TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    this.upsertStmt = this.db.prepare(
      `INSERT INTO "${tableName}" (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
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
      this.upsertStmt.run(key, serialize(value))
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
      this.upsertStmt.run(key, serialize(next))
    }).then(() => next)
  }

  /** 写链入队（串行持久化；任务失败沿 promise 上抛——非吞错） */
  private enqueue(task: () => void): Promise<void> {
    this.chain = this.chain.then(task)
    return this.chain
  }
}
