/**
 * settings seam 单元测试（2026-08-16 配置持久化修复——"保存成功但重启丢失"根因
 * + 二次实测"保存即 fatal load failure"根因）。
 *
 * 覆盖本插件与宿主 settings 服务的接线契约（终版：实时生效，去掉插件重启）：
 * - 注册期初始 onChange：合并配置 ≠ entry 配置 → 委托实时生效器一次（无重启）；
 * - 防环守卫：再次安装（模拟 apply 重跑）不再生效（active 缓存幂等基线）；
 * - 合并配置 = entry 配置（空设置段）→ 不生效；
 * - applyChange 幂等：watcher 重复触发与面板显式调用不重复生效；
 * - setApplier 挂接：装配层注入实时生效器（嵌入后端热换）；
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
  type SettingsSeam,
} from '../src/settings.js'

/** 合并配置假件：entry base + 用户段覆盖（非默认字段便于断言差异） */
function mergedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULTS, embeddingApiBaseUrl: 'http://embed.example/v1', ...overrides }
}

/** 组装假宿主：settings 服务（scope 假件）+ 插件 ctx（inject 捕获）+ 实时生效器假件 */
function setup(options: { section?: Partial<ResolvedConfig> | undefined } = {}) {
  const { section } = options
  const entry: ResolvedConfig = { ...DEFAULTS }
  const merged = section === undefined ? { ...entry } : mergedConfig(section)
  const applied: ResolvedConfig[] = []
  const applier = vi.fn(async (next: ResolvedConfig) => {
    applied.push(next)
  })
  const injectCallbacks: Array<(sctx: unknown) => void> = []
  const scope = {
    get: () => merged,
    watch: vi.fn(() => () => {}),
  }
  const settings = { register: vi.fn(() => scope), update: vi.fn(async () => {}) }
  const sctx = { settings, effect: vi.fn() }
  const ctx = {
    inject: vi.fn((_services: string[], callback: (sctx: unknown) => void) => {
      injectCallbacks.push(callback)
    }),
    effect: vi.fn(),
  } as never
  return {
    ctx,
    entry,
    merged,
    applier,
    applied,
    settings,
    scope,
    /** 模拟 settings 服务就绪：触发注入回调（注册 + 初始 onChange） */
    fireInject: () => {
      for (const callback of injectCallbacks) callback(sctx)
    },
  }
}

describe('settings seam（配置持久化 settings.yaml + 实时生效）', () => {
  beforeEach(() => {
    resetSeamForTest()
  })

  it('注册期初始 onChange：合并配置 ≠ entry → 实时生效器调用一次（目标为合并配置）', () => {
    const { ctx, entry, merged, applier, fireInject } = setup({ section: { embeddingModel: 'BAAI/bge-m3' } })
    const seam = installSettingsSeam(ctx, entry)
    seam.setApplier(applier)
    fireInject()
    expect(applier).toHaveBeenCalledTimes(1)
    expect(applier).toHaveBeenCalledWith(merged)
    expect(seam.effective()).toEqual(merged)
  })

  it('防环守卫：再次安装（模拟 apply 重跑）不再生效（active 缓存幂等基线）', () => {
    const { ctx, entry, applier, fireInject } = setup({ section: { embeddingModel: 'BAAI/bge-m3' } })
    const seam = installSettingsSeam(ctx, entry)
    seam.setApplier(applier)
    fireInject()
    expect(applier).toHaveBeenCalledTimes(1)
    // 第二次安装：active 缓存上次生效配置 → 注册期 onChange 幂等跳过（防"重启环"）
    installSettingsSeam(ctx, entry)
    fireInject()
    expect(applier).toHaveBeenCalledTimes(1)
  })

  it('合并配置 = entry 配置（空设置段）→ 不生效', () => {
    const { ctx, entry, applier, fireInject } = setup({ section: undefined })
    const seam = installSettingsSeam(ctx, entry)
    seam.setApplier(applier)
    fireInject()
    expect(applier).not.toHaveBeenCalled()
  })

  it('applyChange 幂等：同一配置的重复调用不重复生效（watcher 与显式保存并发安全）', async () => {
    const { ctx, entry, merged, applier, fireInject } = setup({ section: { embeddingModel: 'm1' } })
    const seam: SettingsSeam = installSettingsSeam(ctx, entry)
    seam.setApplier(applier)
    fireInject()
    // 注册期初始 onChange 已生效一次；后续重复调用全部幂等跳过
    await Promise.all([seam.applyChange(merged), seam.applyChange(merged)])
    expect(applier).toHaveBeenCalledTimes(1)
  })

  it('applyChange：新配置委托实时生效器并更新生效配置', async () => {
    const { ctx, entry, applier, fireInject } = setup({ section: undefined })
    const seam: SettingsSeam = installSettingsSeam(ctx, entry)
    seam.setApplier(applier)
    fireInject()
    const next = mergedConfig({ embeddingApiBaseUrl: '', embeddingModel: 'BAAI/bge-m3' })
    await seam.applyChange(next)
    expect(applier).toHaveBeenCalledTimes(1)
    expect(applier).toHaveBeenCalledWith(next)
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

  it('applyConfigChange：未挂接生效器（setApplier 未调用）时静默空操作', async () => {
    const next = mergedConfig({ embeddingModel: 'm' })
    await expect(applyConfigChange(next)).resolves.toBeUndefined()
    // active 基线已更新（幂等门仍工作）
    await expect(applyConfigChange(next)).resolves.toBeUndefined()
  })

  it('setApplier 挂接后：applyConfigChange 委托生效器且幂等门不变', async () => {
    const { ctx, entry, applier } = setup({ section: undefined })
    const seam = installSettingsSeam(ctx, entry)
    seam.setApplier(applier)
    const next = mergedConfig({ embeddingModel: 'BAAI/bge-m3' })
    await applyConfigChange(next)
    expect(applier).toHaveBeenCalledTimes(1)
    expect(applier).toHaveBeenCalledWith(next)
  })

  // Q6（2026-08-16 拍板）：热换失败必须回滚 active——修复"幂等门拦死自愈"漂移。
  // 旧实现 active = next 在 applier 完成前提交：热换失败（保留旧后端）后 active
  // 已指向新配置，后续同配置变更被 sameConfig 幂等门拦下，配置态与运行态漂移。
  it('applier 抛错 → active 回滚到旧值，后续新配置变更不被幂等门拦下（可重试/自愈）', async () => {
    const { ctx, entry, fireInject } = setup({ section: undefined })
    const seam: SettingsSeam = installSettingsSeam(ctx, entry)
    // 失败的生效器：模拟热换抛错（运行态未切换，仍为旧后端）
    const failApplier = vi.fn(async () => Promise.reject(new Error('热换失败')))
    seam.setApplier(failApplier)
    fireInject()
    const next = mergedConfig({ embeddingModel: 'BAAI/bge-m3' })
    // 首次应用失败：错误透传
    await expect(seam.applyChange(next)).rejects.toThrow('热换失败')
    // active 已回滚 → effective() 仍是旧配置（entry），非新配置
    expect(seam.effective()).toEqual(entry)
    // 幂等门未被污染：active 已回滚，再次应用同一新配置仍可触发（不被 sameConfig 拦下）
    await expect(seam.applyChange(next)).rejects.toThrow('热换失败')
    expect(failApplier).toHaveBeenCalledTimes(2)
  })
})
