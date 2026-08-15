/**
 * 共享测试辅助：内存假表（实现 KvTable 结构契约）。
 * 与领域层行为一致：update 对缺失键抛 **DomainError('missing-key')**（R2-2/B2：
 * store 只把该码转换为业务语义，其余异常上抛——假表必须抛同型错误才能测到
 * 精确转换；普通 Error 会让 store 误判为"真实异常"而上抛，测不出业务路径）。
 * R3-2：failNextWrite 钩子模拟持久化失败（真实异常传播路径的测试入口）。
 */

import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'

import type { MemoryEntry } from '../src/types.js'

/** 内存假表：同步内存语义 + 异步签名（对齐 KvTable 接口） */
export class FakeTable implements KvTable<string, MemoryEntry> {
  private readonly map = new Map<string, MemoryEntry>()
  /** 下一次写操作（put/update/delete）注入的失败（R3-2：失败注入钩子，一次即清除） */
  private nextWriteError: unknown = undefined

  /** 注入下一次写失败（传 Error/DomainError/任意值）；返回 this 便于链式 */
  failNextWrite(error: unknown): this {
    this.nextWriteError = error
    return this
  }

  /** 写前失败注入检查：有挂起错误则抛出并清除（一次性） */
  private throwIfInjected(): void {
    if (this.nextWriteError !== undefined) {
      const error = this.nextWriteError
      this.nextWriteError = undefined
      throw error
    }
  }

  get(key: string): MemoryEntry | undefined {
    return this.map.get(key)
  }

  /**
   * 快照迭代（对齐真实 KvTable 契约——已查证 dsh-storage-domain 的 entries()
   * 返回内存快照数组的迭代器；live Map 迭代会在迭代中写入时产生语义差异）。
   */
  entries(): IterableIterator<[string, MemoryEntry]> {
    return [...this.map.entries()][Symbol.iterator]() as IterableIterator<[string, MemoryEntry]>
  }

  keys(): IterableIterator<string> {
    return [...this.map.keys()][Symbol.iterator]() as IterableIterator<string>
  }

  get size(): number {
    return this.map.size
  }

  async put(key: string, value: MemoryEntry): Promise<void> {
    this.throwIfInjected()
    this.map.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    this.throwIfInjected()
    return this.map.delete(key)
  }

  async update(key: string, fn: (current: MemoryEntry) => MemoryEntry): Promise<MemoryEntry> {
    this.throwIfInjected()
    const current = this.map.get(key)
    if (current === undefined) throw new DomainError('missing-key', `记录不存在：${key}`)
    const next = fn(current)
    this.map.set(key, next)
    return next
  }
}

/** 等待微任务/宏任务队列清空（fire-and-forget 写回落地） */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
