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
})

void DomainError
