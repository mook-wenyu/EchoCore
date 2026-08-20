/**
 * @module @echocore/dsh-memory/client
 *
 * 记忆面板（浏览器半）薄壳：仅负责模块装配与 re-export，职责已拆至子模块。
 * - 数据层：./client/api.ts（纯 RPC，无 React，可 node 单测）
 * - 视图层：./client/panel.tsx（MemoryPanel + DetailPane）
 * - 配置层：./client/config-pane.tsx（ConfigPane）
 * - 容错层：./client/error-boundary.tsx（PanelErrorBoundary）
 * 本文件保留对外契约（name/inject/apply）与构建入口，行为与拆分前完全一致。
 * 构建：scripts/build-client.mjs 打包本文件为 __ModuleLoader__ 懒 CJS 格式
 *   （external: react / react/jsx-runtime / @deepseek-ai/*）
 */

import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'

import { createMemoryApi } from './client/api.js'
import { PanelErrorBoundary } from './client/error-boundary.js'
import { MemoryPanel } from './client/panel.js'

export const name = 'memory-panel'
// 客户端运行时服务按 inject 声明绑定（未声明则 ctx.get 返回 undefined）：
 // - slots：settings.section 注册（MemoryPanel）
 // - connection：/memory RPC 通道（createMemoryApi）
export const inject = ['slots', 'connection']

/** 面板入口：注册 settings.section "记忆" 页面 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as
    | {
        inject(name: string, callback: () => unknown): void
        register(options: { name: string; id: string; order?: number; label?: string }, render: (props: { close: () => void }) => unknown): unknown
      }
    | undefined
  if (slots === undefined) return
  const api = createMemoryApi(ctx)
  slots.inject('settings.section', () =>
    slots.register({ name: 'settings.section', id: 'memory', order: 30, label: '记忆' }, (props) =>
      React.createElement(PanelErrorBoundary, null, React.createElement(MemoryPanel, { api, close: props.close })),
    ),
  )
}

// ── 对外 re-export（保持旧 import 路径兼容） ──────────────────────────────

// API 层（纯 RPC，可 node 单测）
export { createMemoryApi } from './client/api.js'
export type {
  MemoryDetailView,
  MemoryPanelApi,
  MemoryPanelConfigView,
  MemoryStatsView,
  MemorySummaryView,
  ReflectResultView,
} from './client/api.js'

// 视图层
export { MemoryPanel } from './client/panel.js'
export { ConfigPane } from './client/config-pane.js'
export { PanelErrorBoundary } from './client/error-boundary.js'
