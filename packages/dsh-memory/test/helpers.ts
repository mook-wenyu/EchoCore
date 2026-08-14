/**
 * 共享测试辅助：内存假表（实现 KvTable 结构契约）。
 * 与领域层行为一致：update 对缺失键抛 missing-key；写操作即时生效。
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import type { MemoryEntry } from '../src/types.js'

/** 内存假表：同步内存语义 + 异步签名（对齐 KvTable 接口） */
export class FakeTable implements KvTable<string, MemoryEntry> {
  private readonly map = new Map<string, MemoryEntry>()

  get(key: string): MemoryEntry | undefined {
    return this.map.get(key)
  }

  entries(): IterableIterator<[string, MemoryEntry]> {
    return this.map.entries()
  }

  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  get size(): number {
    return this.map.size
  }

  async put(key: string, value: MemoryEntry): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }

  async update(key: string, fn: (current: MemoryEntry) => MemoryEntry): Promise<MemoryEntry> {
    const current = this.map.get(key)
    if (current === undefined) throw new Error('missing-key')
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

/** 等待微任务/宏任务队列清空（fire-and-forget 写回落地） */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
