/**
 * @module @echocore/dsh-memory/runtime
 *
 * 运行时单例：收敛 index.ts 与 settings.ts 的模块级可变全局。
 * - index.ts: embeddingEpoch / holder / storeRef（嵌入后端持有与并发纪元）
 * - settings.ts: active / applier / currentSource / settingsService（配置持久化与热换）
 * 收敛为 class MemoryRuntime { holder; epoch; settings }，消除模块级可变全局。
 * 单例每进程一个（宿主级插件每进程仅一个实例），测试经实例方法重置隔离。
 */

import { DEFAULTS, type ResolvedConfig } from './config.js'
import type { EmbeddingHolder } from './embedding.js'
import type { MemoryStore } from './store.js'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** 实时生效器（配置变更的应用方式——装配层注入：嵌入后端热换，不重启插件） */
export type LiveApplier = (next: ResolvedConfig) => Promise<void>

/** settings 服务形状（ctx.inject 捕获的最小面） */
export interface SettingsServiceLike {
  update(ns: SettingsNamespace, patch: object): Promise<void>
}

/**
 * 运行时单例（显式化 holder/settings 单例，P1 任务 1）。
 * - holder: 嵌入后端持有者（service/index 成对，热换原位生效）
 * - epoch: 嵌入初始化并发纪元（并发 init 只保留最后一次）
 * - storeRef: store 延迟引用（seam applier 在迁移前挂接）
 * - settings: 配置持久化域（active/applier/currentSource/service）
 */
export class MemoryRuntime {
  /** 嵌入后端持有者（面板热换原位生效，调用时读 holder 字段） */
  holder: EmbeddingHolder = { service: undefined, index: undefined }

  /** 嵌入初始化并发纪元（epoch 守卫：并发初始化只保留最后一次） */
  epoch = 0

  /** store 延迟引用（seam applier 在 store 构造前挂接，迁移窗口内可能为 undefined） */
  storeRef: MemoryStore | undefined = undefined

  /** 配置持久化与热换域（收敛 settings.ts 四全局） */
  settings: {
    /** 上次生效的合并配置（幂等守卫基线） */
    active: ResolvedConfig | undefined
    /** 实时生效器（index.ts mountMemory 挂接；默认空操作） */
    applier: LiveApplier
    /** settings 权威配置源（setSource 注入：注册后 = scope.get()，注销后 = entry 配置） */
    currentSource: () => ResolvedConfig
    /** settings 服务引用（面板持久化通道） */
    service: SettingsServiceLike | undefined
  } = {
    active: undefined,
    applier: () => Promise.resolve(),
    currentSource: () => ({ ...DEFAULTS }) as ResolvedConfig,
    service: undefined,
  }

  /**
   * 测试隔离：重置进程级单例（仅测试调用）。
   * 重置所有收敛域到初始状态，等价于历史 resetSeamForTest 的实例方法形态。
   */
  resetSeamForTest(): void {
    // index.ts 域
    this.holder = { service: undefined, index: undefined }
    this.epoch = 0
    this.storeRef = undefined
    // settings.ts 域
    this.settings.active = undefined
    this.settings.applier = () => Promise.resolve()
    this.settings.service = undefined
    this.settings.currentSource = () => ({ ...DEFAULTS }) as ResolvedConfig
  }

  /** 别名：与 resetSeamForTest 同义（任务要求实例方法，兼容不同命名） */
  resetForTest(): void {
    this.resetSeamForTest()
  }
}

/** 进程级单例（宿主每进程一个插件实例，全局共享） */
export const memoryRuntime = new MemoryRuntime()
