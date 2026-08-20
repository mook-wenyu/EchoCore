/**
 * runtime 单例 TDD（P1 任务 1）：
 * - 显式化 holder/settings 单例：将 index.ts 的 embeddingEpoch/holder/storeRef 与
 *   settings.ts 的 active/applier 四全局收敛为 class MemoryRuntime { holder; epoch; settings }
 * - resetSeamForTest 改实例方法，消除模块级可变全局
 * 中文注释 + 失败先行
 */
import { describe, expect, it } from 'vitest'

import { MemoryRuntime, memoryRuntime } from '../src/runtime.js'
import { DEFAULTS } from '../src/config.js'

describe('MemoryRuntime 单例（holders/settings 收敛）', () => {
  it('导出 MemoryRuntime 类与 memoryRuntime 单例', () => {
    expect(MemoryRuntime).toBeDefined()
    expect(memoryRuntime).toBeInstanceOf(MemoryRuntime)
  })

  it('单例包含 holder/epoch/settings 三收敛域', () => {
    // holder 域（index.ts → holder + storeRef 隐含在 holder/epoch 旁）
    expect(memoryRuntime.holder).toBeDefined()
    expect(memoryRuntime.holder.service).toBeUndefined()
    expect(memoryRuntime.holder.index).toBeUndefined()
    expect(typeof memoryRuntime.epoch).toBe('number')
    // storeRef 延迟引用（mount 前 undefined）
    expect('storeRef' in memoryRuntime).toBe(true)
    // settings 域（settings.ts → active/applier/currentSource/service）
    expect(memoryRuntime.settings).toBeDefined()
    expect('active' in memoryRuntime.settings).toBe(true)
    expect('applier' in memoryRuntime.settings).toBe(true)
    expect('currentSource' in memoryRuntime.settings).toBe(true)
    expect('service' in memoryRuntime.settings).toBe(true)
  })

  it('resetSeamForTest 为实例方法（消除模块级可变全局）', () => {
    // 任务约束：resetSeamForTest 改实例方法（非模块级函数）
    expect(typeof memoryRuntime.resetSeamForTest).toBe('function')
    // 实例方法可重置状态：先污染再重置
    memoryRuntime.epoch = 99
    memoryRuntime.holder.service = {} as never
    memoryRuntime.settings.active = { ...DEFAULTS, embeddingModel: 'polluted' } as never
    memoryRuntime.settings.applier = async () => { throw new Error('polluted') }
    memoryRuntime.resetSeamForTest()
    expect(memoryRuntime.epoch).toBe(0)
    expect(memoryRuntime.holder.service).toBeUndefined()
    expect(memoryRuntime.holder.index).toBeUndefined()
    expect(memoryRuntime.settings.active).toBeUndefined()
    expect(typeof memoryRuntime.settings.applier).toBe('function')
    // storeRef 也应重置
    expect(memoryRuntime.storeRef).toBeUndefined()
  })

  it('单例全局唯一：两次导入拿到同一对象', async () => {
    const mod = await import('../src/runtime.js')
    expect(mod.memoryRuntime).toBe(memoryRuntime)
  })
})
