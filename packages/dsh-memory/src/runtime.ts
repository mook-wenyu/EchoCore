/**
 * @module @echocore/dsh-memory/runtime
 *
 * 运行时单例：收敛 index.ts 与 settings.ts 的模块级可变全局。
 * - index.ts: embeddingEpoch / holder / storeRef（嵌入后端持有与并发纪元）
 * - settings.ts: active / applier / currentSource / settingsService（配置持久化与热换）
 * 收敛为 class MemoryRuntime { holder; epoch; settings }，消除模块级可变全局。
 * 单例每进程一个（宿主级插件每进程仅一个实例），测试经实例方法重置隔离。
 */

import { ConfigManager, DEFAULTS, LLM_DEFAULTS, configHashOf, type LlmConfig, type ResolvedConfig } from './config.js'
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
 * LLM 工厂单例（单一信任源网关，中文注释）
 * - 唯一可信源：config.ts 根 llm: {provider,model,api_base,temperature}（ConfigManager.mergeConfig 显式>env:>默认）
 * - 有序 Fallback：fallbacks: [{primary:["fallback1"]}] 有序数组，仅对 429/5xx/timeout 触发
 * - 网关参数：num_retries=2 timeout=10s allowed_fails=3 cooldown=60s
 * 子模块禁止硬编码 openai/gpt-4 默认，统一经此工厂获取
 */
export class LlmFactory {
  /** 单例持有 */
  private static _instance: LlmFactory | undefined
  /** 获取单例（进程级唯一） */
  static getInstance(): LlmFactory {
    if (LlmFactory._instance === undefined) LlmFactory._instance = new LlmFactory()
    return LlmFactory._instance
  }
  /** 测试隔离：重置单例 */
  static resetForTest(): void {
    LlmFactory._instance = undefined
  }

  /** 有序 Fallback 数组（仅此一处定义有序，网关按序尝试） */
  fallbacks: Array<Record<string, string[]>> = [{ primary: ['fallback1'] }]

  /** 网关重试次数（固定 2） */
  num_retries = 2
  /** 单次请求超时 ms（固定 10s） */
  timeout = 10_000
  /** 熔断阈值：允许失败次数（固定 3） */
  allowed_fails = 3
  /** 熔断冷却 ms（固定 60s） */
  cooldown = 60_000

  /** 当前 LLM 配置（单一信任源快照） */
  private config: LlmConfig
  /** 熔断计数器：key -> {count, lastFail} */
  private fails = new Map<string, { count: number; lastFail: number }>()
  /** 时钟注入（便于测试） */
  private now: () => number

  constructor(config?: LlmConfig, now?: () => number) {
    // 显式传入则直接使用；否则经 ConfigManager 单一源合并（显式>env:>默认）
    if (config !== undefined) {
      this.config = { ...config }
    } else {
      try {
        const merged = ConfigManager.mergeConfig({}, process.env as Record<string, string | undefined>)
        this.config = { ...merged.llm }
      } catch {
        this.config = { ...LLM_DEFAULTS }
      }
    }
    this.now = now ?? (() => Date.now())
  }

  /** 更新配置（配置热换时调用，重置熔断） */
  updateConfig(next: LlmConfig): void {
    this.config = { ...next }
    this.fails.clear()
  }

  /** 获取当前配置（拷贝） */
  getConfig(): LlmConfig {
    return { ...this.config }
  }

  /** 快照（唯一可信源，供四处任务一致性校验） */
  getSnapshot(): { provider: string; model: string; api_base: string; temperature: number; configHash: string } {
    const hash = configHashOf({ ...DEFAULTS, llm: this.config } as ResolvedConfig)
    return { ...this.config, configHash: hash }
  }

  /** 按任务获取快照（reflect/causal/extract/compression 均同源，显式一致性合约） */
  getSnapshotFor(_task: string): { provider: string; model: string; api_base: string; temperature: number; configHash: string } {
    const snap = this.getSnapshot()
    return { ...snap }
  }

  /**
   * 是否可重试（仅对 429/5xx/timeout 触发，400/401/403 直接失败）
   * 中文注释：网关有序 Fallback 的重试门控
   */
  shouldRetry(error: { status?: number; code?: string; message?: string }): boolean {
    if (error.status !== undefined) {
      if (error.status === 429) return true
      if (error.status >= 500 && error.status <= 599) return true
      if (error.status === 400 || error.status === 401 || error.status === 403) return false
      return false
    }
    if (error.code !== undefined) {
      const c = error.code.toUpperCase()
      if (c.includes('TIMEOUT') || c.includes('ETIMEDOUT') || c === 'ECONNABORTED') return true
    }
    if (error.message !== undefined && error.message.toLowerCase().includes('timeout')) return true
    return false
  }

  /** 获取主模型的有序 fallback 链（按 fallbacks 数组顺序） */
  getFallbackChain(primary: string): string[] {
    for (const entry of this.fallbacks) {
      if (primary in entry) return [...(entry[primary] ?? [])]
    }
    return []
  }

  /** 记录失败（熔断计数） */
  recordFail(key: string): void {
    const prev = this.fails.get(key)
    const now = this.now()
    if (prev === undefined) {
      this.fails.set(key, { count: 1, lastFail: now })
    } else {
      // 若已过冷却期则重置计数
      if (now - prev.lastFail >= this.cooldown) {
        this.fails.set(key, { count: 1, lastFail: now })
      } else {
        this.fails.set(key, { count: prev.count + 1, lastFail: now })
      }
    }
  }

  /** 记录成功（清除熔断） */
  recordSuccess(key: string): void {
    this.fails.delete(key)
  }

  /** 是否熔断打开（达到 allowed_fails 且在 cooldown 窗口内） */
  isCircuitOpen(key: string): boolean {
    const entry = this.fails.get(key)
    if (entry === undefined) return false
    if (entry.count < this.allowed_fails) return false
    const now = this.now()
    if (now - entry.lastFail >= this.cooldown) {
      // 冷却期已过，自动半开（清除旧计数）
      this.fails.delete(key)
      return false
    }
    return true
  }
}

/** 进程级 LLM 工厂单例 */
export const llmFactory = LlmFactory.getInstance()

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
   * 快照代理（唯一可信源透出，供一致性合约测试与 memory_status）
   * 委托至 LlmFactory 单例，保证与工厂同源
   */
  getSnapshot(): { provider: string; model: string; api_base: string; temperature: number; configHash: string } {
    return LlmFactory.getInstance().getSnapshot()
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
    // 同步重置 LLM 工厂（保证测试隔离）
    LlmFactory.resetForTest()
  }

  /** 别名：与 resetSeamForTest 同义（任务要求实例方法，兼容不同命名） */
  resetForTest(): void {
    this.resetSeamForTest()
  }
}

/** 进程级单例（宿主每进程一个插件实例，全局共享） */
export const memoryRuntime = new MemoryRuntime()
