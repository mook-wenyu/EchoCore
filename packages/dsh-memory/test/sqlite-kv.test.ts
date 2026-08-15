/**
 * SqliteKvTable 单元测试：KvTable 契约的 SQLite 实现。
 * - CRUD 契约（get/put/update/delete/entries/keys/size）；
 * - missing-key 语义（与 storage-domain 契约一致）；
 * - 持久化 round-trip（重开数据库数据仍在）；
 * - WAL 模式生效（写 O(1) 日志追加的结构前提）；
 * - 写链串行（update 原子读改写不交错）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { DomainError } from '@deepseek-ai/dsh-storage-domain'

import { SqliteKvTable } from '../src/sqlite-kv.js'

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
})

void DomainError
