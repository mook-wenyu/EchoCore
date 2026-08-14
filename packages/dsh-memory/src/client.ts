/**
 * @module @echocore/dsh-memory/client
 *
 * 记忆面板（浏览器半）：settings.section 注册"记忆"页面。
 * - 数据通道：ctx.connection.rpc.call('/memory', endpoint, payload)
 * - 界面：搜索框 + 分类过滤 + 记忆列表 + 详情（来源/审计）+ 归档按钮
 * - 构建：scripts/build-client.mjs 打包为 __ModuleLoader__ 懒 CJS 格式
 *   （external: react / react/jsx-runtime / @deepseek-ai/*）
 */

import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

export const name = 'memory-panel'
export const inject: string[] = []

/** 记忆条目展示形态（与宿主 toSummary 对齐） */
interface MemorySummaryView {
  id: string
  kind: string
  content: string
  importance: number
  tags: string[]
  sessionId: string
  status: string
  createdAt: string
}

/** 详情展示形态（与宿主 toDetail 对齐） */
interface MemoryDetailView extends MemorySummaryView {
  source: { sessionId: string; eventSeqs: number[]; excerpt: string }
  accessCount: number
  audit: Array<{ action: string; at: string; by: string; detail?: string }>
}

/** 面板数据 API（apply 期从 ctx 装配，随组件 props 传递） */
export interface MemoryPanelApi {
  list(status?: string, limit?: number): Promise<MemorySummaryView[]>
  search(query: string, kind?: string, status?: string): Promise<MemorySummaryView[]>
  get(id: string): Promise<MemoryDetailView | undefined>
  archive(id: string): Promise<boolean>
}

/** 从 ctx 装配面板 API（connection 缺失时所有调用返回空结果） */
export function createMemoryApi(ctx: Context): MemoryPanelApi {
  const connection = ctx.get('connection') as { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> } } | undefined
  const call = async (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
    if (connection === undefined) return { ok: false, error: { code: 'internal', message: 'connection 服务不可用', details: {} } }
    return connection.rpc.call('/memory', endpoint, payload)
  }
  const unwrap = (result: RpcResult<unknown>): unknown => {
    if (result.ok) return result.value
    throw new Error(result.error.message)
  }
  return {
    async list(status, limit) {
      const result = await call('list', { status, limit })
      const value = unwrap(result) as { entries: MemorySummaryView[] }
      return value.entries
    },
    async search(query, kind, status) {
      const result = await call('search', { query, kind, status, limit: 50 })
      const value = unwrap(result) as { entries: MemorySummaryView[] }
      return value.entries
    },
    async get(id) {
      const result = await call('get', { id })
      const value = unwrap(result) as { found: boolean; entry?: MemoryDetailView }
      return value.found ? value.entry : undefined
    },
    async archive(id) {
      const result = await call('archive', { id })
      const value = unwrap(result) as { archived: boolean }
      return value.archived
    },
  }
}

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
      React.createElement(MemoryPanel, { api, close: props.close }),
    ),
  )
}

// ── 面板组件（纯 React，无 JSX） ────────────────────────────────────────

interface MemoryPanelProps {
  api: MemoryPanelApi
  close: () => void
}

const KIND_LABELS: Array<[string, string]> = [
  ['', '全部分类'],
  ['fact', '事实'],
  ['preference', '偏好'],
  ['decision', '决策'],
  ['todo', '待办'],
  ['insight', '洞察'],
]

/** 记忆面板：搜索 + 过滤 + 列表 + 详情 */
export function MemoryPanel(props: MemoryPanelProps): React.ReactElement {
  const [entries, setEntries] = React.useState<MemorySummaryView[]>([])
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState('')
  const [selected, setSelected] = React.useState<MemoryDetailView | undefined>(undefined)
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(
    async (q: string, k: string): Promise<void> => {
      try {
        setError('')
        const items = q.trim() === '' ? await props.api.list() : await props.api.search(q, k === '' ? undefined : k)
        setEntries(items)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [props.api],
  )

  React.useEffect(() => {
    void refresh('', '')
  }, [refresh])

  const openDetail = async (id: string): Promise<void> => {
    try {
      setSelected(await props.api.get(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const doArchive = async (id: string): Promise<void> => {
    try {
      await props.api.archive(id)
      setSelected(undefined)
      await refresh(query, kind)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onSearch = (): void => {
    void refresh(query, kind)
  }

  const rows = entries.map((entry) =>
    React.createElement(
      'div',
      {
        key: entry.id,
        onClick: () => void openDetail(entry.id),
        style: rowStyle(entry.id === selected?.id),
      },
      React.createElement('div', null, `[${entry.kind}] ${entry.content}`),
      React.createElement(
        'div',
        { style: metaStyle },
        `重要度 ${entry.importance} · 记忆 #${entry.id.slice(0, 8)} · 来自会话 ${entry.sessionId.slice(0, 8)} · ${entry.createdAt.slice(0, 10)}`,
      ),
    ),
  )

  return React.createElement(
    'div',
    { style: panelStyle },
    React.createElement(
      'div',
      null,
      React.createElement('input', {
        value: query,
        placeholder: '搜索记忆…',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        style: inputStyle,
      }),
      React.createElement(
        'select',
        { value: kind, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setKind(event.target.value), style: selectStyle },
        KIND_LABELS.map(([value, label]) => React.createElement('option', { key: value, value }, label)),
      ),
      React.createElement('button', { onClick: onSearch, style: buttonStyle }, '搜索'),
    ),
    error !== '' ? React.createElement('div', { style: errorStyle }, error) : null,
    React.createElement('div', { style: listStyle }, rows.length > 0 ? rows : React.createElement('div', null, '（暂无记忆）')),
    selected !== undefined ? React.createElement(DetailPane, { entry: selected, onArchive: () => void doArchive(selected.id) }) : null,
  )
}

/** 详情面板：内容、来源、摘录、审计日志 */
function DetailPane(props: { entry: MemoryDetailView; onArchive: () => void }): React.ReactElement {
  const entry = props.entry
  const auditRows = entry.audit.map((record, index) =>
    React.createElement('div', { key: index, style: metaStyle }, `${record.at} [${record.by}] ${record.action}${record.detail ? `：${record.detail}` : ''}`),
  )
  return React.createElement(
    'div',
    { style: detailStyle },
    React.createElement('h4', null, `记忆 #${entry.id.slice(0, 8)}（${entry.kind}，重要度 ${entry.importance}，状态 ${entry.status}）`),
    React.createElement('p', null, entry.content),
    React.createElement('p', { style: metaStyle }, `来源会话：${entry.source.sessionId}`),
    React.createElement('p', { style: metaStyle }, `来源事件序号：${entry.source.eventSeqs.join(', ') || '（手动记录）'}`),
    React.createElement('p', { style: metaStyle }, `原文摘录：${entry.source.excerpt.slice(0, 200)}`),
    React.createElement('p', { style: metaStyle }, `访问次数：${entry.accessCount}`),
    React.createElement('div', { style: metaStyle }, '审计日志：'),
    auditRows,
    React.createElement('button', { onClick: props.onArchive, style: buttonStyle }, '归档'),
  )
}

// ── 样式（最小内联，跟随主题变量） ─────────────────────────────────────

const panelStyle: React.CSSProperties = { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }
const listStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }
const detailStyle: React.CSSProperties = { border: '1px solid var(--dsh-border, #ccc)', borderRadius: 6, padding: 8 }
const metaStyle: React.CSSProperties = { fontSize: 12, opacity: 0.75, margin: '2px 0' }
const inputStyle: React.CSSProperties = { marginRight: 8, padding: '4px 8px' }
const selectStyle: React.CSSProperties = { marginRight: 8, padding: '4px 8px' }
const buttonStyle: React.CSSProperties = { padding: '4px 10px', cursor: 'pointer' }
const errorStyle: React.CSSProperties = { color: 'var(--dsh-danger, #c0392b)', fontSize: 13 }

function rowStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 8px',
    border: '1px solid var(--dsh-border, #ddd)',
    borderRadius: 4,
    cursor: 'pointer',
    background: active ? 'var(--dsh-accent-soft, #eef4ff)' : undefined,
  }
}
