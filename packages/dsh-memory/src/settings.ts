/**
 * @module @echocore/dsh-memory/settings
 *
 * 配置持久化 seam（DSH 官方用户设置通道：`ctx.settings` → `~/.dsh/settings.yaml`）。
 *
 * 根因一（2026-08-16 用户实测"面板保存提示成功，重启 dsh 后配置丢失"）：
 * 保存原走 `fiber.update(config, noSave=false)` → cordis-plugin-loader 的
 * `internal/update` 处理器把配置写进 `entry.options.config` 并调
 * `entry.parent.tree.write()` —— 写回目标是 profile 根 Include 树文件
 * `cordis.yml`。而 DSH 每次启动 `prepareProfile` 无条件把 `cordis.yml` 重写为
 * `[]`（组合基底文件，真实组合全在 patch 层）—— 保存进 cordis.yml 的配置在
 * 下次启动被清空。DSH 文档明确：用户可编辑设置属于 `settings.yaml` 命名空间
 * （内建插件配置页同款通道，官方 e2e 测试为契约）。
 *
 * 根因二（同日二次实测"保存即 fatal load failure"）：初版修复用内存重启
 * （fiber.update noSave=true）生效——但插件 apply 含秒级异步段（加载本地
 * ONNX 模型），进程内重启会让**陈旧续体竞态**：被中断的 apply 续体在重启后
 * 恢复，要么撞进 inactive 窗口抛 "cannot get required service"（harness 实测
 * 可杀进程），要么在 fiber 重新激活后二次注册 memory:snapshot / memory_recall
 * ——dsh-system-prompt 与 dsh-tools 都是 NamedEntries 严格重复检测，二次注册
 * 即抛 "already registered"（用户实测 fatal load failure）。
 *
 * 终版方案（用户拍板：实时生效，去掉插件重启）：配置变更经
 * `scope.watch → onChange → applier` **原位热换嵌入后端**（重建
 * EmbeddingService/EmbeddingIndex，注入器/工具改动态读持有者）——零重启、
 * 零陈旧续体、零重复注册。DSH 原生模式（dsh-base patch 注释：settings 段
 * 变更 "without a restart"，llm-pi-ai 同款）。
 *
 * 跨 apply 状态：模块级单例（宿主级插件每进程仅一个实例）。`active` 缓存
 * 上次生效的合并配置；applier 由装配层注入（index.ts mountMemory 挂接——
 * seam 不关心生效方式，只负责持久化与变更通知）。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  installSettingsSection,
  settingsNamespace,
  type SettingsNamespace,
  type SettingsSectionHooks,
} from '@deepseek-ai/dsh-settings'

import { Config, ConfigManager, DEFAULTS, sameConfig, type Config as ConfigType, type ResolvedConfig } from './config.js'
import { LlmFactory, memoryRuntime, type LiveApplier, type SettingsServiceLike } from './runtime.js'

/** settings 命名空间（settings.yaml 的 memory 段；kebab-case 短名） */
export const NS = settingsNamespace('memory')

/** 实时生效器（配置变更的应用方式——装配层注入：嵌入后端热换，不重启插件） */
// LiveApplier 统一收敛至 runtime（消除跨模块类型重复）
export type { LiveApplier } from './runtime.js'

/** settings 持久化通道（setConfig 落盘 settings.yaml；未接线时 update 拒绝） */
export interface SettingsChannel {
  update(patch: Record<string, unknown>): Promise<void>
}

/** settings seam 对外最小面（index.ts 装配与 RPC 共用） */
export interface SettingsSeam {
  /** 当前生效配置（entry base + settings.yaml 用户层合并；settings 未挂载时 = entry 配置） */
  effective: () => ResolvedConfig
  /** 持久化通道（面板 setConfig 用） */
  channel: SettingsChannel
  /** 应用新配置并等待生效（幂等：与当前生效配置一致则跳过） */
  applyChange: (next: ResolvedConfig) => Promise<void>
  /** 注入实时生效器（装配层挂接；未挂接时空操作——配置只落盘不生效，用于测试直连） */
  setApplier: (applier: LiveApplier) => void
}

// ── 运行时单例（显式化 holder/settings 单例，P1 任务 1） ────
// 模块级可变全局已收敛至 MemoryRuntime 单例（memoryRuntime.settings.*），
// 本文件不再持有独立 let 全局——消除模块级可变状态，统一经 runtime 实例管理。

/**
 * 安装 settings seam（apply 时调用一次）：
 * 注册命名空间 `memory`（entry 配置为 base 层）、接入生效配置源与变更回调、
 * 捕获 settings 服务供面板持久化。settings 服务未挂载时静默跳过（插件以 entry
 * 配置运行；面板保存会经 channel.update 明确报错，不静默降级）。
 */
export function installSettingsSeam(ctx: Context, entry: ConfigType): SettingsSeam {
  // 单一信任源合并（显式 > env: > 默认），llm 字段深合并保证完整 LlmConfig
  const entryConfig: ResolvedConfig = ConfigManager.mergeConfig(entry as Record<string, unknown> as Partial<ConfigType>)
  // 同步 LLM 工厂（保证工厂与配置同源，满足一致性合约）
  try {
    LlmFactory.getInstance().updateConfig(entryConfig.llm)
  } catch {}
  memoryRuntime.settings.currentSource = () => entryConfig
  // 幂等守卫基线：进程首启用 entry 配置（后续变更与之比较）
  memoryRuntime.settings.active = memoryRuntime.settings.active ?? entryConfig

  const hooks: SettingsSectionHooks<ConfigType> = {
    setSource: (source) => {
      memoryRuntime.settings.currentSource = () => source() as ResolvedConfig
    },
    onChange: () => {
      // 注册期初始值 / settings.yaml 热重载 / 面板保存后 commit——统一走
      // 幂等生效门（同配置跳过），生效方式由装配层 applier 决定（实时热换）
      void applyConfigChange(memoryRuntime.settings.currentSource())
    },
  }
  installSettingsSection(ctx, NS, Config, entry, hooks)

  // 面板持久化通道：settings 服务 update（命名空间注册在 installSettingsSection
  // 内部完成；本 inject 仅捕获服务引用，调用发生在用户保存时——彼时必已注册）
  ctx.inject(['settings'], (sctx) => {
    memoryRuntime.settings.service = {
      update: (ns, patch) =>
        (sctx as unknown as { settings: SettingsServiceLike }).settings.update(ns, patch),
    }
  })

  return {
    effective: () => memoryRuntime.settings.active ?? entryConfig,
    channel: {
      update: (patch) => {
        const service = memoryRuntime.settings.service
        if (service === undefined) {
          return Promise.reject(new Error('settings 服务不可用：配置无法持久化（当前部署未挂载 settings provider）'))
        }
        return service.update(NS, patch)
      },
    },
    applyChange: applyConfigChange,
    setApplier: (next) => {
      memoryRuntime.settings.applier = next
    },
  }
}

/**
 * 应用一次配置变更（幂等生效门）：
 * - 与当前生效配置相同 → 无动作（防注册期初始 onChange 与面板保存重复生效）；
 * - 不同 → 记录新生效配置并委托装配层 applier 实时生效（不重启插件——
 *   重启与 apply 的秒级异步段竞态，2026-08-16 实测 fatal load failure 根因）。
 * 并发调用各自进入 applier（装配层以 epoch 守卫丢弃过期结果）。
 */
export function applyConfigChange(next: ResolvedConfig): Promise<void> {
  const prev = memoryRuntime.settings.active
  if (prev !== undefined && sameConfig(next, prev)) return Promise.resolve()
  memoryRuntime.settings.active = next
  // 单一信任源同步：LLM 工厂随配置热换（保证四处任务快照一致）
  try {
    LlmFactory.getInstance().updateConfig(next.llm)
  } catch {}
  return memoryRuntime.settings.applier(next).catch((error) => {
    // 热换失败（applier 抛错，运行态未切换，仍保留旧后端）：回滚 active 到旧值。
    // 若不回滚，active 已指向新配置而运行态仍是旧后端——配置态与运行态漂移，
    // 且后续同配置变更会被 sameConfig 幂等门拦下，无法重试/自愈（Q6 拍板修复）。
    // 回滚后 effective() 返回旧配置，下次 applyChange 新配置可再次触发生效。
    memoryRuntime.settings.active = prev
    throw error
  })
}

/**
 * 测试隔离：重置进程级单例（仅测试调用；运行期不导出语义变化）
 * 显式化后为实例方法委托（P1 任务 1：消除模块级可变全局，统一经 MemoryRuntime 实例管理）
 */
export function resetSeamForTest(): void {
  memoryRuntime.resetSeamForTest()
}
