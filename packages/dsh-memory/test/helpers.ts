/**
 * 共享测试辅助：内存假表 + 统一假 ctx（R3-1/T1）。
 * 此前 injector/extractor/tools/snapshot/maintenance 各自实现 FakeCtx，
 * 能力子集互相漂移（有的缺 effect/get/logger，有的单监听覆盖）——统一为
 * 本类：多监听者 Set、服务注册表、effect disposer 收集、tools.register 捕获。
 */

import { DomainError, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

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

/**
 * 统一假 ctx（R3-1/T1）：覆盖各模块消费的 Cordis 能力子集。
 * - on/emit：多监听者语义（Set 追加，对齐 Cordis；旧的 Map 单监听会覆盖丢监听）；
 * - provide/get：服务注册表（storageDomain/llm/connection/agents 等按需注入）；
 * - effect：收集 disposer（插件卸载路径可驱动）；
 * - tools.register：捕获工具定义表（供 toolOf 查定义）。
 */
export class FakeCtx {
  /** 监听器注册表：type → 监听器集合（多监听者语义） */
  readonly listeners = new Map<string, Set<Function>>()
  /** get 服务注册表 */
  readonly services = new Map<string, unknown>()
  /** effect 收集的 disposer（按注册顺序） */
  readonly disposers: Array<() => void> = []
  /** tools.register 捕获的工具定义表 */
  readonly toolDefs = new Map<string, ToolDefinition>()

  on(type: string, listener: Function): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  /** 触发某类型全部监听器（测试驱动入口） */
  emit(type: string, ...args: unknown[]): void {
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const listener of set) {
      ;(listener as (...callArgs: unknown[]) => void)(...args)
    }
  }

  /** 取某类型第一个监听器（waterfall 场景需直接调用以获取返回值时用；emit 不返回） */
  listener(type: string): Function | undefined {
    return this.listeners.get(type)?.values().next().value
  }

  /** 注册服务（get 语义） */
  provide(name: string, service: unknown): void {
    this.services.set(name, service)
  }

  /** 读取服务（先查注册表，再回退实例属性——Cordis 服务既可 get 也可属性访问） */
  get(name: string): unknown {
    if (this.services.has(name)) return this.services.get(name)
    return (this as unknown as Record<string, unknown>)[name]
  }

  /** 收集 disposer（随插件卸载调用；测试可驱动 ctx.disposers） */
  effect(fn: () => () => void): void {
    this.disposers.push(fn())
  }

  /** tools 服务形状（register 捕获定义） */
  readonly tools = {
    register: (def: ToolDefinition): void => {
      this.toolDefs.set(def.name, def)
    },
  }

  /** logger 收集器（index.ts 装配用 ctx.logger('memory')；按 level 分类记录） */
  readonly logRecords: Array<{ level: string; args: unknown[] }> = []

  /** logger 服务形状（返回收集器，测试可断言告警/错误） */
  readonly logger = (_name: string): { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void; error: (...args: unknown[]) => void } => ({
    warn: (...args: unknown[]) => this.logRecords.push({ level: 'warn', args }),
    info: (...args: unknown[]) => this.logRecords.push({ level: 'info', args }),
    error: (...args: unknown[]) => this.logRecords.push({ level: 'error', args }),
  })
}
