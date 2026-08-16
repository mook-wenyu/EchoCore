/**
 * @module @echocore/dsh-memory/settings
 *
 * 配置持久化 seam（DSH 官方用户设置通道：`ctx.settings` → `~/.dsh/settings.yaml`）。
 *
 * 根因（2026-08-16 用户实测"面板保存提示成功，重启 dsh 后配置丢失"）：
 * 保存原走 `fiber.update(config, noSave=false)` → cordis-plugin-loader 的
 * `internal/update` 处理器把配置写进 `entry.options.config` 并调
 * `entry.parent.tree.write()` —— 写回目标是 profile 根 Include 树文件
 * `cordis.yml`。而 DSH 每次启动 `prepareProfile` 无条件把 `cordis.yml` 重写为
 * `[]`（组合基底文件，真实组合全在 patch 层）—— 保存进 cordis.yml 的配置在
 * 下次启动被清空。DSH 文档明确：用户可编辑设置属于 `settings.yaml` 命名空间
 * （内建插件配置页同款通道，官方 e2e 测试为契约）。
 *
 * 修复：面板保存改经 settings 命名空间 `memory` 持久化到 settings.yaml；
 * 生效仍用内存重启插件（`fiber.update(next, true)`：noSave=true 不触发 loader
 * 写回 cordis.yml）。settings 变更（面板保存 / 手工编辑 settings.yaml）经
 * `scope.watch → onChange` 走同一重启路径。
 *
 * 跨重启状态：模块级单例（宿主级插件每进程仅一个实例）。`active` 缓存上次
 * 生效的合并配置：插件重启后装配直接沿用，避免 settings 注册期初始 onChange
 * （合并配置 ≠ entry 配置时）触发"重启 → 再注册 → 再重启"环。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  installSettingsSection,
  settingsNamespace,
  type SettingsNamespace,
  type SettingsSectionHooks,
} from '@deepseek-ai/dsh-settings'

import { Config, DEFAULTS, sameConfig, type Config as ConfigType, type ResolvedConfig } from './config.js'

/** settings 命名空间（settings.yaml 的 memory 段；kebab-case 短名） */
export const NS = settingsNamespace('memory')

/** 插件 fiber 配置更新面（内存重启；noSave=true 不触碰配置源） */
export interface FiberLike {
  update(config: Record<string, unknown>, noSave?: boolean): Promise<void>
}

/** settings 持久化通道（setConfig 落盘 settings.yaml；未接线时 update 拒绝） */
export interface SettingsChannel {
  update(patch: Record<string, unknown>): Promise<void>
}

/** settings 服务形状（ctx.inject 捕获的最小面；命名空间注册由 installSettingsSection 完成） */
interface SettingsServiceLike {
  update(ns: SettingsNamespace, patch: object): Promise<void>
}

/** settings seam 对外最小面（index.ts 装配与 RPC 共用） */
export interface SettingsSeam {
  /** 当前生效配置（entry base + settings.yaml 用户层合并；settings 未挂载时 = entry 配置） */
  effective: () => ResolvedConfig
  /** 持久化通道（面板 setConfig 用） */
  channel: SettingsChannel
  /** 应用新配置并等待生效（幂等：与当前生效配置一致则跳过） */
  applyChange: (next: ResolvedConfig) => Promise<void>
}

// ── 模块级单例状态（进程内一个宿主实例；resetSeamForTest 供测试隔离） ────

/** 上次生效的合并配置（跨重启缓存——防注册期重启环，见文件头） */
let active: ResolvedConfig | undefined
/** 进行中的内存重启（并发变更共用同一重启，防双重启竞争） */
let restarting: Promise<void> | undefined
/** 当前插件 fiber（apply 时刷新；内存重启用） */
let fiber: FiberLike | undefined
/** settings 权威配置源（setSource 注入：注册后 = scope.get()，注销后 = entry 配置） */
let currentSource: () => ResolvedConfig = () => ({ ...DEFAULTS }) as ResolvedConfig
/** settings 服务引用（inject 后置；面板持久化通道） */
let settingsService: SettingsServiceLike | undefined

/**
 * 安装 settings seam（apply 时调用一次）：
 * 注册命名空间 `memory`（entry 配置为 base 层）、接入生效配置源与变更回调、
 * 捕获 settings 服务供面板持久化。settings 服务未挂载时静默跳过（插件以 entry
 * 配置运行；面板保存会经 channel.update 明确报错，不静默降级）。
 */
export function installSettingsSeam(ctx: Context, entry: ConfigType): SettingsSeam {
  const entryConfig: ResolvedConfig = { ...DEFAULTS, ...entry }
  fiber = (ctx as unknown as { fiber: FiberLike }).fiber
  currentSource = () => entryConfig
  // 跨重启沿用上次生效配置（settings 层合并结果）；进程首启用 entry 配置
  active = active ?? entryConfig

  const hooks: SettingsSectionHooks<ConfigType> = {
    setSource: (source) => {
      currentSource = () => source() as ResolvedConfig
    },
    onChange: () => {
      void applyConfigChange(currentSource())
    },
  }
  installSettingsSection(ctx, NS, Config, entry, hooks)

  // 面板持久化通道：settings 服务 update（命名空间注册在 installSettingsSection
  // 内部完成；本 inject 仅捕获服务引用，调用发生在用户保存时——彼时必已注册）
  ctx.inject(['settings'], (sctx) => {
    settingsService = {
      update: (ns, patch) =>
        (sctx as unknown as { settings: SettingsServiceLike }).settings.update(ns, patch),
    }
  })

  return {
    effective: () => active ?? entryConfig,
    channel: {
      update: (patch) => {
        const service = settingsService
        if (service === undefined) {
          return Promise.reject(new Error('settings 服务不可用：配置无法持久化（当前部署未挂载 settings provider）'))
        }
        return service.update(NS, patch)
      },
    },
    applyChange: applyConfigChange,
  }
}

/**
 * 应用一次配置变更（幂等）：
 * - 与当前生效配置相同 → 返回进行中的重启（若有），否则空（无变更即无动作）；
 * - 不同 → 记录新生效配置并以 noSave=true 内存重启插件（不写 cordis.yml——
 *   该文件每次启动被 prepareProfile 重置，写回即丢失）。
 * 并发/重复调用共享同一重启：settings 注册期初始 onChange 与面板 setConfig
 * 显式调用都走此门，先到者启动重启，后到者复用其 promise。
 */
export function applyConfigChange(next: ResolvedConfig): Promise<void> {
  if (active !== undefined && sameConfig(next, active)) return restarting ?? Promise.resolve()
  active = next
  if (fiber === undefined) return Promise.resolve()
  restarting = fiber.update(next, true).finally(() => {
    restarting = undefined
  })
  return restarting
}

/** 测试隔离：重置进程级单例（仅测试调用；运行期不导出语义变化） */
export function resetSeamForTest(): void {
  active = undefined
  restarting = undefined
  fiber = undefined
  settingsService = undefined
  currentSource = () => ({ ...DEFAULTS }) as ResolvedConfig
}


