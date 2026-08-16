/**
 * settings seam 单元测试（2026-08-16 配置持久化修复——"保存成功但重启丢失"根因）。
 *
 * 覆盖本插件与宿主 settings 服务的接线契约：
 * - 注册期初始 onChange：合并配置 ≠ entry 配置 → 内存重启一次（noSave=true）；
 * - 防环守卫：重启后再次安装（模拟 apply 重跑）不再触发重启；
 * - 合并配置 = entry 配置（空设置段）→ 不重启；
 * - applyChange 幂等：watcher 重复触发与面板显式调用共用同一重启；
 * - settings 服务未挂载：effective = entry 配置，channel.update 明确拒绝（不静默降级）；
 * - channel.update 转发到命名空间 memory。
 *
 * 宿主（installSettingsSection / settings 服务）以最小面假件代替——本测试验证
 * 插件侧契约（调用顺序/幂等守卫/拒绝语义），宿主实现由 DSH 自身测试覆盖。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULTS, type ResolvedConfig } from '../src/config.js'
import {
  applyConfigChange,
  installSettingsSeam,
  NS,
  resetSeamForTest,
  type FiberLike,
  type SettingsSeam,
} from '../src/settings.js'

/** 合并配置假件：entry base + 用户段覆盖（非默认字段便于断言差异） */
function mergedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULTS, embeddingApiBaseUrl: 'http://embed.example/v1', ...overrides }
}

/** 组装假宿主：settings 服务（scope 假件）+ 插件 ctx（fiber 假件 + inject 捕获） */
function setup(options: { section?: Partial<ResolvedConfig> | undefined } = {}) {
  const { section } = options
  const entry: ResolvedConfig = { ...DEFAULTS }
  const merged = section === undefined ? { ...entry } : mergedConfig(section)
  const fiberUpdates: Array<{ config: Record<string, unknown>; noSave?: boolean }> = []
  const fiber: FiberLike = {
    update: async (config, noSave) => {
      fiberUpdates.push({ config, noSave })
    },
  }
  const injectCallbacks: Array<(sctx: unknown) => void> = []
  const scope = {
    get: () => merged,
    watch: vi.fn(() => () => {}),
  }
  const settings = { register: vi.fn(() => scope), update: vi.fn(async () => {}) }
  const sctx = { settings, effect: vi.fn() }
  const ctx = {
    fiber,
    inject: vi.fn((_services: string[], callback: (sctx: unknown) => void) => {
      injectCallbacks.push(callback)
    }),
    effect: vi.fn(),
  } as never
  return {
    ctx,
    entry,
    merged,
    fiberUpdates,
    settings,
    scope,
    /** 模拟 settings 服务就绪：触发注入回调（注册 + 初始 onChange） */
    fireInject: () => {
      for (const callback of injectCallbacks) callback(sctx)
    },
  }
}

describe('settings seam（配置持久化 settings.yaml）', () => {
  beforeEach(() => {
    resetSeamForTest()
  })

  it('注册期初始 onChange：合并配置 ≠ entry → 内存重启一次（noSave=true，目标为合并配置）', () => {
    const { ctx, entry, merged, fiberUpdates, fireInject } = setup({ section: { embeddingModel: 'BAAI/bge-m3' } })
    const seam = installSettingsSeam(ctx, entry)
    fireInject()
    expect(fiberUpdates).toHaveLength(1)
    expect(fiberUpdates[0]?.noSave).toBe(true)
    expect(fiberUpdates[0]?.config).toEqual(merged)
    expect(seam.effective()).toEqual(merged)
  })

  it('防环守卫：重启后再次安装（模拟 apply 重跑）不再触发重启', () => {
    const { ctx, entry, fiberUpdates, fireInject } = setup({ section: { embeddingModel: 'BAAI/bge-m3' } })
    installSettingsSeam(ctx, entry)
    fireInject()
    expect(fiberUpdates).toHaveLength(1)
    // 第二次安装 = 重启后的新 apply：active 缓存上次生效配置 → 注册期 onChange 幂等跳过
    installSettingsSeam(ctx, entry)
    fireInject()
    expect(fiberUpdates).toHaveLength(1)
  })

  it('合并配置 = entry 配置（空设置段）→ 不重启', () => {
    const { ctx, entry, fiberUpdates, fireInject } = setup({ section: undefined })
    installSettingsSeam(ctx, entry)
    fireInject()
    expect(fiberUpdates).toHaveLength(0)
  })

  it('applyChange 幂等：同一配置的重复调用共用一次重启（watcher 与显式保存并发安全）', async () => {
    const { ctx, entry, merged, fiberUpdates, fireInject } = setup({ section: { embeddingModel: 'm1' } })
    const seam: SettingsSeam = installSettingsSeam(ctx, entry)
    fireInject()
    // 注册期初始 onChange 已启动一次重启（合并配置已生效）；后续重复调用全部复用/跳过
    await Promise.all([seam.applyChange(merged), seam.applyChange(merged)])
    expect(fiberUpdates).toHaveLength(1)
  })

  it('applyChange：新配置触发重启并更新生效配置', async () => {
    const { ctx, entry, fiberUpdates, fireInject } = setup({ section: undefined })
    const seam: SettingsSeam = installSettingsSeam(ctx, entry)
    fireInject()
    const next = mergedConfig({ embeddingApiBaseUrl: '', embeddingModel: 'BAAI/bge-m3' })
    await seam.applyChange(next)
    expect(fiberUpdates).toHaveLength(1)
    expect(fiberUpdates[0]?.noSave).toBe(true)
    expect(fiberUpdates[0]?.config).toEqual(next)
    expect(seam.effective()).toEqual(next)
  })

  it('settings 服务未挂载：effective = entry 配置；channel.update 明确拒绝（不静默降级）', async () => {
    const { ctx, entry } = setup({ section: undefined })
    const seam = installSettingsSeam(ctx, entry)
    expect(seam.effective()).toEqual(entry)
    await expect(seam.channel.update({ embeddingModel: 'm' })).rejects.toThrow('settings 服务不可用')
  })

  it('channel.update 经 settings 服务转发到命名空间 memory', async () => {
    const { ctx, entry, fireInject, settings } = setup({ section: undefined })
    const seam = installSettingsSeam(ctx, entry)
    fireInject()
    await seam.channel.update({ embeddingModel: 'BAAI/bge-m3' })
    expect(settings.update).toHaveBeenCalledWith(NS, { embeddingModel: 'BAAI/bge-m3' })
  })

  it('applyConfigChange：fiber 未就绪（settings 未接线）时静默空操作', async () => {
    const next = mergedConfig({ embeddingModel: 'm' })
    await expect(applyConfigChange(next)).resolves.toBeUndefined()
  })
})