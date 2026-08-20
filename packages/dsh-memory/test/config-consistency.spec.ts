/**
 * 一致性合约测试（TDD / 中文注释）
 * 约束：
 * - 单一信任源：config.ts 根 llm: {provider,model,api_base,temperature} 为唯一可信源
 * - 工厂单例：runtime.ts LlmFactory 单例
 * - 合并优先级：ConfigManager.mergeConfig 按 显式 > env: > 默认 合并
 * - 网关有序 Fallback：仅对 429/5xx/timeout 触发，400/401/403 直接失败
 * - 快照一致：reflect/causal/extract/compression 四处 model 一致且等于 runtime.getSnapshot().model
 * - 可观测：memory_status 暴露 llm.model / configHash
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// 显式校验：工厂与配置管理器必须存在（失败即红）
import * as configModule from '../src/config.js'
import * as runtimeModule from '../src/runtime.js'

describe('单一信任源工厂', () => {
  it('config.ts 导出 llm 根配置且为唯一可信源（不含硬编码 openai/gpt-4）', async () => {
    // 读取源码文本做硬编码扫描（独立真源校验，非同构计算）
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const configPath = path.join(process.cwd(), 'packages/dsh-memory/src/config.ts')
    let text: string
    try {
      text = await fs.readFile(configPath, 'utf8')
    } catch {
      // 回退：直接读 src/config.ts 相对本文件
      text = await fs.readFile(new URL('../src/config.ts', import.meta.url), 'utf8')
    }
    // 唯一可信源结构必须存在
    expect(configModule).toHaveProperty('LLM_DEFAULTS')
    const defaults = (configModule as unknown as { LLM_DEFAULTS: Record<string, unknown> }).LLM_DEFAULTS
    expect(defaults).toHaveProperty('provider')
    expect(defaults).toHaveProperty('model')
    expect(defaults).toHaveProperty('api_base')
    expect(defaults).toHaveProperty('temperature')
    // 子模块硬编码 openai/gpt-4 已删除（源码不应包含该字面量作为默认）
    // 允许注释中提及 openai-node，但默认 provider/model 不应为 openai/gpt-4
    expect(String(defaults.provider)).not.toBe('openai')
    expect(String(defaults.model)).not.toBe('gpt-4')
    expect(String(defaults.model)).not.toBe('gpt-4o')
    // 源码中不应出现 provider 默认赋值为 openai 的硬编码模式
    // 仅检查 llm 默认定义段
    const llmDefaultsSegment = text.slice(text.indexOf('LLM_DEFAULTS'), text.indexOf('LLM_DEFAULTS') + 800)
    expect(llmDefaultsSegment.toLowerCase()).not.toContain('"openai"')
    expect(llmDefaultsSegment.toLowerCase()).not.toContain("'openai'")
    expect(llmDefaultsSegment).not.toContain('gpt-4')
  })

  it('ConfigManager.mergeConfig 按 显式 > env: > 默认 合并', () => {
    const { ConfigManager, LLM_DEFAULTS } = configModule as unknown as {
      ConfigManager: { mergeConfig: (explicit: Record<string, unknown>, env?: Record<string, string>) => Record<string, unknown> }
      LLM_DEFAULTS: { provider: string; model: string; api_base: string; temperature: number }
    }
    expect(ConfigManager).toBeDefined()
    expect(typeof ConfigManager.mergeConfig).toBe('function')

    // 场景 1：显式缺省时取 env
    const env1: Record<string, string> = { LLM_PROVIDER: 'env-provider', LLM_MODEL: 'env-model' }
    const merged1 = ConfigManager.mergeConfig({}, env1) as { llm: { provider: string; model: string } }
    expect(merged1.llm.provider).toBe('env-provider')
    expect(merged1.llm.model).toBe('env-model')

    // 场景 2：显式优先于 env
    const merged2 = ConfigManager.mergeConfig({ llm: { provider: 'explicit-provider' } } as never, env1) as {
      llm: { provider: string }
    }
    expect(merged2.llm.provider).toBe('explicit-provider')

    // 场景 3：env: 前缀解析
    const env2: Record<string, string> = { MY_API_BASE: 'https://env.example.com' }
    const merged3 = ConfigManager.mergeConfig({ llm: { api_base: 'env:MY_API_BASE' } } as never, env2) as {
      llm: { api_base: string }
    }
    expect(merged3.llm.api_base).toBe('https://env.example.com')

    // 场景 4：全缺省回退 default
    const merged4 = ConfigManager.mergeConfig({}, {}) as { llm: { provider: string } }
    expect(merged4.llm.provider).toBe(LLM_DEFAULTS.provider)

    // 场景 5：env 不存在时回退 default（不抛）
    const merged5 = ConfigManager.mergeConfig({ llm: { api_base: 'env:NOT_EXIST' } } as never, {}) as {
      llm: { api_base: string }
    }
    expect(merged5.llm.api_base).toBe(LLM_DEFAULTS.api_base)
  })

  it('ConfigManager.mergeConfig 支持 temperature 的 env 覆盖与类型保持', () => {
    const { ConfigManager, LLM_DEFAULTS } = configModule as unknown as {
      ConfigManager: { mergeConfig: (e: Record<string, unknown>, env?: Record<string, string>) => Record<string, unknown> }
      LLM_DEFAULTS: { temperature: number }
    }
    const env = { LLM_TEMPERATURE: '0.9' }
    const merged = ConfigManager.mergeConfig({}, env) as { llm: { temperature: number } }
    expect(merged.llm.temperature).toBeCloseTo(0.9)
    // 显式 number 优先
    const merged2 = ConfigManager.mergeConfig({ llm: { temperature: 0.3 } } as never, env) as { llm: { temperature: number } }
    expect(merged2.llm.temperature).toBeCloseTo(0.3)
    // 默认兜底
    const merged3 = ConfigManager.mergeConfig({}, {}) as { llm: { temperature: number } }
    expect(merged3.llm.temperature).toBe(LLM_DEFAULTS.temperature)
  })
})

describe('LlmFactory 单例与信任源', () => {
  it('runtime.ts 导出 LlmFactory 单例且 getSnapshot 为唯一可信源', () => {
    const { LlmFactory, llmFactory, memoryRuntime } = runtimeModule as unknown as {
      LlmFactory: { getInstance: () => unknown }
      llmFactory: unknown
      memoryRuntime: { getSnapshot?: () => unknown }
    }
    expect(LlmFactory).toBeDefined()
    expect(typeof LlmFactory.getInstance).toBe('function')
    const a = (LlmFactory as unknown as { getInstance: () => unknown }).getInstance()
    const b = (LlmFactory as unknown as { getInstance: () => unknown }).getInstance()
    expect(a).toBe(b)
    // 导出的单例与 getInstance 归一
    if (llmFactory !== undefined) expect(llmFactory).toBe(a)
    // MemoryRuntime 也应暴露 getSnapshot（或通过 llmFactory 暴露）
    const snapshot = (a as unknown as { getSnapshot: () => { model: string } }).getSnapshot?.() ??
      (memoryRuntime?.getSnapshot?.() as { model: string } | undefined)
    expect(snapshot).toBeDefined()
    expect(typeof snapshot!.model).toBe('string')
  })

  it('子模块无硬编码 openai/gpt-4 默认（源码扫描）', async () => {
    const fs = await import('node:fs/promises')
    const targets = ['reflect.ts', 'causal.ts', 'extract.ts', 'stable-snapshot.ts', 'snapshot.ts', 'embedding.ts']
    for (const file of targets) {
      try {
        const text = await fs.readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
        // 仅检查默认赋值语境：如 provider = 'openai' 或 model = 'gpt-4'
        const lower = text.toLowerCase()
        // 若文件包含该字面量且作为默认，需告警；注释中提及 openai-node 允许，但默认不应是 openai/gpt-4
        // 使用严格模式：检查 LlmFactory/Config 以外的硬编码
        if (file !== 'embedding.ts') {
          expect(lower).not.toMatch(/provider\s*[:=]\s*['"]openai['"]/)
          expect(lower).not.toMatch(/model\s*[:=]\s*['"]gpt-4/)
        }
      } catch {
        // 文件不存在跳过（如 snapshot.ts）
      }
    }
  })
})

describe('网关有序 Fallback', () => {
  it('runtime LlmFactory 具备有序 fallback 与熔断参数', () => {
    const { LlmFactory } = runtimeModule as unknown as {
      LlmFactory: new () => {
        fallbacks: unknown
        num_retries: number
        timeout: number
        allowed_fails: number
        cooldown: number
        shouldRetry?: (e: unknown) => boolean
      }
    }
    const factory = new (LlmFactory as unknown as new () => {
      fallbacks: Array<Record<string, string[]>>
      num_retries: number
      timeout: number
      allowed_fails: number
      cooldown: number
    })()
    // 有序数组结构 [{primary:["fallback1"]}]
    expect(Array.isArray(factory.fallbacks)).toBe(true)
    expect(factory.fallbacks.length).toBeGreaterThan(0)
    const first = factory.fallbacks[0] as Record<string, string[]>
    const key = Object.keys(first)[0]!
    expect(Array.isArray(first[key])).toBe(true)
    expect(first[key]![0]).toBeDefined()
    // 固定参数
    expect(factory.num_retries).toBe(2)
    expect(factory.timeout).toBe(10_000)
    expect(factory.allowed_fails).toBe(3)
    expect(factory.cooldown).toBe(60_000)
  })

  it('仅对 429/5xx/timeout 触发重试，400/401/403 直接失败', () => {
    const { LlmFactory } = runtimeModule as unknown as {
      LlmFactory: new () => { shouldRetry: (e: { status?: number; code?: string; message?: string }) => boolean }
    }
    const factory = new (LlmFactory as unknown as new () => { shouldRetry: (e: unknown) => boolean })()
    expect(typeof factory.shouldRetry).toBe('function')
    // 可重试
    expect(factory.shouldRetry({ status: 429 })).toBe(true)
    expect(factory.shouldRetry({ status: 500 })).toBe(true)
    expect(factory.shouldRetry({ status: 502 })).toBe(true)
    expect(factory.shouldRetry({ status: 503 })).toBe(true)
    expect(factory.shouldRetry({ code: 'ETIMEDOUT' })).toBe(true)
    expect(factory.shouldRetry({ code: 'TIMEOUT' })).toBe(true)
    expect(factory.shouldRetry({ message: 'timeout' })).toBe(true)
    // 不可重试
    expect(factory.shouldRetry({ status: 400 })).toBe(false)
    expect(factory.shouldRetry({ status: 401 })).toBe(false)
    expect(factory.shouldRetry({ status: 403 })).toBe(false)
  })

  it('熔断：allowed_fails 阈值与 cooldown 语义', () => {
    const { LlmFactory } = runtimeModule as unknown as {
      LlmFactory: new () => {
        allowed_fails: number
        cooldown: number
        recordFail: (k: string) => void
        isCircuitOpen: (k: string) => boolean
        recordSuccess: (k: string) => void
      }
    }
    const factory = new (LlmFactory as unknown as new () => {
      allowed_fails: number
      cooldown: number
      recordFail: (k: string) => void
      isCircuitOpen: (k: string) => boolean
      recordSuccess: (k: string) => void
    })()
    const key = 'test-model'
    // 连续失败小于阈值不应熔断
    factory.recordFail(key)
    factory.recordFail(key)
    expect(factory.isCircuitOpen(key)).toBe(false)
    // 达到阈值熔断
    factory.recordFail(key)
    expect(factory.isCircuitOpen(key)).toBe(true)
    // 成功后重置
    factory.recordSuccess(key)
    expect(factory.isCircuitOpen(key)).toBe(false)
  })
})

describe('一致性合约：四处 model 快照一致', () => {
  it('reflect/causal/extract/compression 四处 model 一致且等于 runtime.getSnapshot().model', async () => {
    const { LlmFactory } = runtimeModule as unknown as {
      LlmFactory: { getInstance: () => { getSnapshot: () => { model: string } } }
    }
    const factory = LlmFactory.getInstance()
    const runtimeModel = factory.getSnapshot().model

    // 四处快照均通过工厂获取（单一信任源验证）：工厂应对不同任务返回相同 model
    const tasks = ['reflect', 'causal', 'extract', 'compression'] as const
    const snapshots = tasks.map((task) => {
      const inst = factory as unknown as { getSnapshotFor?: (t: string) => { model: string }; getSnapshot: () => { model: string } }
      if (typeof inst.getSnapshotFor === 'function') return inst.getSnapshotFor(task).model
      return inst.getSnapshot().model
    })
    for (const model of snapshots) {
      expect(model).toBe(runtimeModel)
    }
    // 额外校验 config 侧单一源
    const { ConfigManager } = configModule as unknown as {
      ConfigManager: { mergeConfig: (e: Record<string, unknown>) => { llm: { model: string } } }
    }
    const merged = ConfigManager.mergeConfig({})
    expect(merged.llm.model).toBe(runtimeModel)
  })
})

describe('memory_status 可观测', () => {
  it('memory_status 暴露 llm.model 与 configHash', async () => {
    const { FakeTable, FakeCtx } = await import('./helpers.js')
    const { MemoryStore } = await import('../src/store.js')
    const { registerMemoryTools } = await import('../src/tools.js')
    const { LlmFactory } = runtimeModule as unknown as {
      LlmFactory: { getInstance: () => { getSnapshot: () => { model: string; configHash: string } } }
    }
    const factory = LlmFactory.getInstance()
    const snap = factory.getSnapshot()

    const table = new FakeTable()
    const store = new MemoryStore(table as never)
    // 构造最小 snapshot 存根
    const snapshotStub = { snapshotIds: () => new Set<string>() } as unknown as import('../src/stable-snapshot.js').MemoryStableSnapshot
    const ctx = new FakeCtx() as unknown as import('@deepseek-ai/cordis').Context
    // 运行时健康由 factory 快照提供 llm 信息
    registerMemoryTools(ctx as never, {
      store,
      snapshot: snapshotStub,
      runtime: {
        writeFailures: 0,
        embeddingState: 'ready',
        lastMaintenanceAt: null,
        // 扩展字段：llm 可观测（独立于原有 embedding 健康字段）
        llm: { model: snap.model, configHash: snap.configHash },
      } as unknown as never,
    } as never)
    const def = (ctx as unknown as { toolDefs: Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }> }).toolDefs.get(
      'memory_status',
    )
    expect(def).toBeDefined()
    const result = (await def!.execute({}, { agent: { session: { header: { cwd: '/tmp' } }, id: 'agent-1' } } as never)) as {
      llm?: { model: string; configHash: string }
      // 兼容顶层平铺形态
      llmModel?: string
      configHash?: string
    }
    // 允许两种形态：嵌套 llm 或顶层平铺，但必须可观测到 model 与 hash
    const model = (result as unknown as { llm?: { model: string } }).llm?.model ?? (result as unknown as { llmModel: string }).llmModel
    const hash = (result as unknown as { llm?: { configHash: string } }).llm?.configHash ?? (result as unknown as { configHash: string }).configHash
    // 若工具采用顶层附加字段，也接受
    const altModel = (result as unknown as Record<string, unknown>).llm_model ?? (result as unknown as Record<string, unknown>).model
    const altHash = (result as unknown as Record<string, unknown>).configHash ?? (result as unknown as Record<string, unknown>).config_hash
    const observedModel = model ?? altModel
    const observedHash = hash ?? altHash
    expect(observedModel).toBe(snap.model)
    expect(typeof observedHash).toBe('string')
    expect((observedHash as string).length).toBeGreaterThan(0)
  })
})
