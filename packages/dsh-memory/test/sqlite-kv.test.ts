/**
 * SqliteKvTable 单元测试：KvTable 契约的 SQLite 实现。
 * - CRUD 契约（get/put/update/delete/entries/keys/size）；
 * - missing-key 语义（与 storage-domain 契约一致）；
 * - 持久化 round-trip（重开数据库数据仍在）；
 * - WAL 模式生效（写 O(1) 日志追加的结构前提）；
 * - 写链串行（update 原子读改写不交错）。
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import { DomainError } from '@deepseek-ai/dsh-storage-domain'

import { migrateMemoryJson, SqliteKvTable } from '../src/sqlite-kv.js'

// 全模块拦截（pass-through：默认走真实实现，测试按需覆写）——src 与测试共享同一
// mock 模块，避免"动态 import 命名空间 ≠ require 命名空间"导致 spy 失效（实测坑）。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

/** 临时数据库文件（每用例独立目录，防 WAL 残留互扰） */
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-kv-'))
  return join(dir, 'test.sqlite')
}

/** 组装：打开数据库 + 建表 + 返回 { table, db, cleanup } */
function setup(path: string): { table: SqliteKvTable<{ id: string; n: number }>; db: DatabaseSync } {
  const db = new DatabaseSync(path)
  return { table: new SqliteKvTable<{ id: string; n: number }>(db), db }
}

describe('SqliteKvTable', () => {
  it('put/get 往返 + size/keys/entries 快照', async () => {
    const path = tmpDbPath()
    const { table, db } = setup(path)
    await table.put('a', { id: 'a', n: 1 })
    await table.put('b', { id: 'b', n: 2 })
    expect(table.get('a')).toEqual({ id: 'a', n: 1 })
    expect(table.get('missing')).toBeUndefined()
    expect(table.size).toBe(2)
    expect([...table.keys()].sort()).toEqual(['a', 'b'])
    const entries = [...table.entries()].sort(([k1], [k2]) => k1.localeCompare(k2))
    expect(entries[0]?.[1]).toEqual({ id: 'a', n: 1 })
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('update：原子读改写；missing-key 拒绝（DomainError）', async () => {
    const path = tmpDbPath()
    const { table, db } = setup(path)
    await table.put('a', { id: 'a', n: 1 })
    const next = await table.update('a', (current) => ({ ...current, n: current.n + 10 }))
    expect(next).toEqual({ id: 'a', n: 11 })
    expect(table.get('a')).toEqual({ id: 'a', n: 11 })
    await expect(table.update('missing', (current) => current)).rejects.toMatchObject({
      code: 'missing-key',
    })
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('delete：存在返回 true 并移除；不存在返回 false', async () => {
    const path = tmpDbPath()
    const { table, db } = setup(path)
    await table.put('a', { id: 'a', n: 1 })
    expect(await table.delete('a')).toBe(true)
    expect(table.get('a')).toBeUndefined()
    expect(await table.delete('a')).toBe(false)
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('持久化 round-trip：重开数据库数据仍在（含 WAL）', async () => {
    const path = tmpDbPath()
    const first = new DatabaseSync(path)
    const t1 = new SqliteKvTable<{ id: string; n: number }>(first)
    await t1.put('a', { id: 'a', n: 42 })
    first.close()
    // 重开（同一文件）：数据应从 SQLite 恢复
    const second = new DatabaseSync(path)
    const t2 = new SqliteKvTable<{ id: string; n: number }>(second)
    expect(t2.get('a')).toEqual({ id: 'a', n: 42 })
    expect(t2.size).toBe(1)
    second.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('WAL 模式生效（journal_mode = wal）', () => {
    const path = tmpDbPath()
    const { db } = setup(path)
    const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
    expect(mode.toLowerCase()).toBe('wal')
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('写链串行：并发 update 不交错（原子读改写语义）', async () => {
    const path = tmpDbPath()
    const { table, db } = setup(path)
    await table.put('a', { id: 'a', n: 0 })
    // 10 个并发 update：每个 +1——串行链保证最终 = 10（无交错丢失）
    await Promise.all(Array.from({ length: 10 }, () => table.update('a', (c) => ({ ...c, n: c.n + 1 }))))
    expect(table.get('a')).toEqual({ id: 'a', n: 10 })
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('J2 预分词列：deriveTokens 回调写入 content_tokens（未来 FTS5 数据源）', async () => {
    const path = tmpDbPath()
    const db = new DatabaseSync(path)
    const table = new SqliteKvTable<{ id: string; content: string }>(db, 'entries', (value) =>
      value.content
        .split(' ')
        .filter((w) => w.length > 0)
        .join(' '),
    )
    await table.put('a', { id: 'a', content: '记忆系统 架构设计' })
    await table.update('a', (c) => ({ ...c, content: '记忆系统 覆盖机制' }))
    const row = db.prepare('SELECT content_tokens FROM entries WHERE id = ?').get('a') as { content_tokens: string }
    expect(row.content_tokens).toBe('记忆系统 覆盖机制')
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('J2 无 deriveTokens 时 content_tokens 为 NULL（通用 KvTable 语义保持）', async () => {
    const path = tmpDbPath()
    const { table, db } = setup(path)
    await table.put('a', { id: 'a', n: 1 })
    const row = db.prepare('SELECT content_tokens FROM entries WHERE id = ?').get('a') as { content_tokens: string | null }
    expect(row.content_tokens).toBeNull()
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('D1 写链失败自恢复：单条写失败不卡死后续链，且计数可观测', async () => {
    const path = tmpDbPath()
    const db = new DatabaseSync(path)
    const table = new SqliteKvTable<{ id: string; n: number }>(db)
    await table.put('a', { id: 'a', n: 1 })
    // 破坏链：注入一次失败（直接改内部——通过删除表使 upsert 抛错）
    // 更可控的方式：用坏表名构造？——这里用「关闭 db 后写」模拟 I/O 失败
    const before = table.writeFailures
    // 注入失败：对已删除的数据库连接操作（db.close 后 put → run 抛错）
    // 但 close 后无法恢复——改用「删除表」触发 run 抛错
    db.exec('DROP TABLE entries')
    await expect(table.put('b', { id: 'b', n: 2 })).rejects.toThrow()
    // 计数已累加
    expect(table.writeFailures).toBe(before + 1)
    // 链未卡死：重建表后后续写仍落盘
    db.exec('CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, value TEXT NOT NULL, content_tokens TEXT)')
    await table.put('c', { id: 'c', n: 3 })
    const row = db.prepare('SELECT value FROM entries WHERE id = ?').get('c') as { value: string }
    expect(JSON.parse(row.value)).toEqual({ id: 'c', n: 3 })
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('M1 busy_timeout 显式 5000（多进程并发写有重试窗口）', () => {
    const path = tmpDbPath()
    const { db } = setup(path)
    const timeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
    expect(timeout).toBe(5000)
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('R5 wal_autocheckpoint 显式 256（256 页≈1MB，更频繁控 WAL 增长）', () => {
    const path = tmpDbPath()
    const { db } = setup(path)
    const pages = (db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint
    expect(pages).toBe(256)
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('R5 checkpoint()：显式 TRUNCATE 回截 WAL 文件（busy=0 全部完成）', async () => {
    const path = tmpDbPath()
    const { table, db } = setup(path)
    // 产生 WAL 帧（当前只有两次小写，远低于自动阈值——WAL 文件应非空未截断）
    await table.put('a', { id: 'a', n: 1 })
    await table.put('b', { id: 'b', n: 2 })
    const walPath = `${path}-wal`
    expect(existsSync(walPath)).toBe(true)
    const before = statSync(walPath).size
    expect(before).toBeGreaterThan(0) // 尚未被自动 checkpoint 回截
    // 显式 TRUNCATE checkpoint：WAL 帧回写主库并回截文件
    table.checkpoint()
    const after = statSync(walPath).size
    expect(after).toBeLessThanOrEqual(before)
    // 数据完好（checkpoint 只是落盘，不回退内存态）
    expect(table.get('b')).toEqual({ id: 'b', n: 2 })
    // 方法发出 TRUNCATE：随后 PRAGMA 复查 busy=0（无写者挤压，全部完成）
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number }
    expect(r.busy).toBe(0)
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })

  it('Q4/A 加载容错：坏 value 行跳过、其余行正常加载、loadFailures≥1', () => {
    const path = tmpDbPath()
    const db = new DatabaseSync(path)
    // 预置一张表：一行 value 是非法 JSON（外部数据损坏），一行是合法 JSON
    db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL, content_tokens TEXT)')
    db.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run('bad', '这不是JSON{')
    db.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run('good', JSON.stringify({ id: 'good', n: 1 }))
    // 构造不应因坏行而 throw（对称降级：坏行不影响其余行加载）
    const table = new SqliteKvTable<{ id: string; n: number }>(db)
    expect(table.get('good')).toEqual({ id: 'good', n: 1 })
    expect(table.get('bad')).toBeUndefined()
    expect(table.loadFailures).toBeGreaterThanOrEqual(1)
    db.close()
    rmSync(join(path, '..'), { recursive: true, force: true })
  })
})

/** 临时 memory.json 路径（每用例独立目录） */
function tmpJsonPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-kv-json-'))
  return join(dir, 'memory.json')
}

describe('migrateMemoryJson', () => {
  /** 组装：空白 SQLite + 空 SqliteKvTable + 临时 json 路径；迁移语义测试用 */
  function make(): {
    jsonPath: string
    table: SqliteKvTable<{ id: string; n: number }>
    db: DatabaseSync
    dir: string
  } {
    const dbPath = tmpDbPath()
    const jsonPath = tmpJsonPath()
    const db = new DatabaseSync(dbPath)
    return { jsonPath, table: new SqliteKvTable<{ id: string; n: number }>(db), db, dir: join(dbPath, '..') }
  }

  it('正常迁移：合法记录导入成功，count/size 正确', async () => {
    const { jsonPath, table, db, dir } = make()
    writeFileSync(
      jsonPath,
      JSON.stringify({ tables: { entries: { a: { id: 'a', n: 1 }, b: { id: 'b', n: 2 } } } }),
      'utf8',
    )
    const result = await migrateMemoryJson(jsonPath, table, () => true)
    expect(result).toEqual({ migrated: 2, skipped: 0, corrupt: false })
    expect(table.size).toBe(2)
    expect(table.get('a')).toEqual({ id: 'a', n: 1 })
    expect(table.get('b')).toEqual({ id: 'b', n: 2 })
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('坏记录跳过：isValid=false 的记录 skipped，其余正常导入', async () => {
    const { jsonPath, table, db, dir } = make()
    writeFileSync(
      jsonPath,
      JSON.stringify({
        tables: {
          entries: {
            good: { id: 'good', n: 1 },
            bad: { id: 'bad', n: 'not-a-number' },
          },
        },
      }),
      'utf8',
    )
    // isValid 只认可 n 为数字——bad 记录校验失败被跳过
    const result = await migrateMemoryJson(jsonPath, table, (raw) => {
      const r = raw as { n?: unknown }
      return typeof r?.n === 'number'
    })
    expect(result).toEqual({ migrated: 1, skipped: 1, corrupt: false })
    expect(table.size).toBe(1)
    expect(table.get('good')).toEqual({ id: 'good', n: 1 })
    expect(table.get('bad')).toBeUndefined()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('整文件 JSON 损坏：corrupt=true，不写入任何行', async () => {
    const { jsonPath, table, db, dir } = make()
    writeFileSync(jsonPath, '这不是合法 JSON{', 'utf8')
    const result = await migrateMemoryJson(jsonPath, table, () => true)
    expect(result).toEqual({ migrated: 0, skipped: 0, corrupt: true })
    expect(table.size).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在：返回 0/0/false（首次全新启动）', async () => {
    const { jsonPath, table, db, dir } = make()
    const result = await migrateMemoryJson(jsonPath, table, () => true)
    expect(result).toEqual({ migrated: 0, skipped: 0, corrupt: false })
    expect(table.size).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('非 ENOENT 的 IO 错误（EACCES 等）→ 上抛，不静默当作"无旧文件"（Q6⑨ 补全项 1a）', async () => {
    const { jsonPath, table, db, dir } = make()
    try {
      // 注入 EACCES（文件存在但不可读）——旧记忆库迁移被跳过会静默丢迁移源
      vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      await expect(migrateMemoryJson(jsonPath, table, () => true)).rejects.toThrow('permission denied')
    } finally {
      vi.mocked(readFile).mockClear()
    }
    expect(table.size).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('事务性：中间某条写入抛错 → 先行记录被回滚（目标表保持为空）', async () => {
    const { jsonPath, db, dir } = make()
    // 注入故障：deriveTokens 在第二条（n===2）抛错——模拟持久化过程中途失败。
    // 第一条已写入但仍在未提交事务内，第二条抛错应触发 ROLLBACK，两行都不落库。
    const table = new SqliteKvTable<{ id: string; n: number }>(db, 'entries', (v) => {
      if (v.n === 2) throw new Error('deriveTokens 故障')
      return ''
    })
    writeFileSync(
      jsonPath,
      JSON.stringify({ tables: { entries: { a: { id: 'a', n: 1 }, b: { id: 'b', n: 2 } } } }),
      'utf8',
    )
    await expect(migrateMemoryJson(jsonPath, table, () => true)).rejects.toThrow('deriveTokens 故障')
    // 先行记录 a 被回滚：目标表为空 + 内存 cache 为空（可安全重试）
    const cnt = (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c
    expect(cnt).toBe(0)
    expect(table.size).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

void DomainError
