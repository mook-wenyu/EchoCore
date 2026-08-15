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

import { shortSessionId } from './constants.js'

export const name = 'memory-panel'
// 客户端运行时服务按 inject 声明绑定（未声明则 ctx.get 返回 undefined）：
// - slots：settings.section 注册（MemoryPanel）
// - connection：/memory RPC 通道（createMemoryApi）
export const inject = ['slots', 'connection']

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
  workspace: string
  source: { sessionId: string; eventSeqs: number[]; excerpt: string }
  accessCount: number
  audit: Array<{ action: string; at: string; by: string; detail?: string }>
  supersededBy?: string
  supersedes?: string
}

/** 统计展示形态（与宿主 MemoryStats 对齐，无 deleted 字段） */
export interface MemoryStatsView {
  total: number
  active: number
  archived: number
  byKind: Record<string, number>
  /**
   * O1 观测闭环扩展（可选项）：宿主 status 端点尚未下发这些字段时缺失，
   * 面板以可选访问展示——缺则整行不渲染（防旧宿主/防未来字段名漂移）。
   */
  writeFailures?: number
  embeddingState?: string
  lastMaintenanceAt?: string | null
}

/**
 * 配置视图（与宿主 configView 对齐）：当前生效配置字段 +
 * embeddingApiKeyResolved（apiKey 解析状态——字面 key 或 env:NAME 环境变量
 * 引用是否可用；面板展示用，不泄露解析后的 key 值）。
 * 配置面最小化（用户拍板）：仅远程嵌入 4 项，其余行为参数已固化为代码常量。
 */
export interface MemoryPanelConfigView {
  embeddingApiBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimension: number
  embeddingApiKeyResolved: boolean
}

/** 面板数据 API（apply 期从 ctx 装配，随组件 props 传递） */
export interface MemoryPanelApi {
  list(status?: string, limit?: number): Promise<MemorySummaryView[]>
  /** R3：workspace 可选——传则限定该工作区搜索；面板默认不传（跨项目管理浏览） */
  search(query: string, kind?: string, status?: string, workspace?: string): Promise<MemorySummaryView[]>
  get(id: string): Promise<MemoryDetailView | undefined>
  archive(id: string): Promise<boolean>
  status(): Promise<MemoryStatsView>
  /** 读取当前生效配置（含 apiKey 解析状态） */
  getConfig(): Promise<MemoryPanelConfigView>
  /** 更新配置（仅变更项；宿主校验并写回 cordis.patch.yml，插件重启生效） */
  setConfig(partial: Record<string, unknown>): Promise<MemoryPanelConfigView>
}

/** 从 ctx 装配面板 API（R2-3/B3：connection 为硬 inject，缺失则插件不加载，运行期必有） */
export function createMemoryApi(ctx: Context): MemoryPanelApi {
  // ctx.get 返回 unknown（Cordis 未在 Context 类型声明 connection 服务），
  // 类型强转保留；optional 守卫删除——守卫是防御性死代码（inject 语义保证存在）
  const connection = ctx.get('connection') as {
    rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> }
  }
  const call = (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> =>
    connection.rpc.call('/memory', endpoint, payload)
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
    async search(query, kind, status, workspace) {
      const result = await call('search', { query, kind, status, limit: 50, workspace })
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
    async status() {
      const result = await call('status', {})
      return unwrap(result) as MemoryStatsView
    },
    async getConfig() {
      const result = await call('getConfig', {})
      const value = unwrap(result) as { config: MemoryPanelConfigView }
      return value.config
    },
    async setConfig(partial) {
      const result = await call('setConfig', partial)
      const value = unwrap(result) as { config: MemoryPanelConfigView }
      return value.config
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
  const [workspace, setWorkspace] = React.useState('')
  const [workspaceOptions, setWorkspaceOptions] = React.useState<string[]>([])
  const [selected, setSelected] = React.useState<MemoryDetailView | undefined>(undefined)
  const [stats, setStats] = React.useState<MemoryStatsView | undefined>(undefined)
  const [error, setError] = React.useState('')
  // 详情请求序号：openDetail 竞态守卫——只采纳最新一次请求的响应
  const requestSeq = React.useRef(0)
  // 工作区下拉来源构建守卫：列表条目摘要（toSummary）不含 workspace 字段，
  // 只能从详情（get）取样推导；用 ref 保证只取样一次，避免每次 refresh 重访详情。
  const workspacesDerivedRef = React.useRef(false)

  /**
   * 从已装载的条目推导工作区下拉选项（union 到现有集合再升序）。
   * 摘要视图不携带 workspace（toSummary 丢弃字段，见 tools.ts），仅详情有；
   * 故对本次条目异步拉详情取样。取样上限固定，避免大库里 N 次 RPC 风暴——
   * 面板是跨项目管理浏览工具，覆盖"当前可见库"的工作区即足筛选项。
   */
  const deriveWorkspaces = React.useCallback(
    async (items: MemorySummaryView[]): Promise<void> => {
      if (workspacesDerivedRef.current || items.length === 0) return
      workspacesDerivedRef.current = true
      try {
        const sample = items.slice(0, 50)
        const details = await Promise.all(sample.map((item) => props.api.get(item.id).catch(() => undefined)))
        const set = new Set<string>()
        for (const d of details) if (d !== undefined && d.workspace !== undefined) set.add(d.workspace)
        // 详情类型带必选 workspace；跨版本 host 可能尚未下发（client/host 分开部署），缺则不进集合。
        setWorkspaceOptions((prev) => Array.from(new Set([...prev, ...set])).sort())
      } catch (err) {
        // 推导失败不阻断列表/搜索——重置守卫允许下次再试
        workspacesDerivedRef.current = false
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [props.api],
  )

  const refresh = React.useCallback(
    async (q: string, k: string, w: string): Promise<void> => {
      try {
        setError('')
        let items: MemorySummaryView[]
        // workspace 选中时走 search 路径传参（list API 无 workspace 参数）；
        // 未选且空查询回退 list()（按最近排序的大库浏览），否则 search。
        if (w !== '') {
          items = await props.api.search(q.trim() === '' ? '' : q, k === '' ? undefined : k, undefined, w)
        } else {
          items = q.trim() === '' ? await props.api.list() : await props.api.search(q, k === '' ? undefined : k)
        }
        setEntries(items)
        // 推导工作区下拉选项（守卫保证仅首次取样一次）
        void deriveWorkspaces(items)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [props.api, deriveWorkspaces],
  )

  React.useEffect(() => {
    void refresh('', '', '')
    void props.api.status().then(setStats).catch((err) => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      requestSeq.current++ // 卸载清理：作废未决请求
    }
  }, [refresh, props.api])

  const openDetail = async (id: string): Promise<void> => {
    const seq = ++requestSeq.current
    try {
      const detail = await props.api.get(id)
      // 竞态守卫：响应返回期间若又发起新一轮请求，丢弃过期响应
      if (seq !== requestSeq.current) return
      setSelected(detail)
    } catch (err) {
      if (seq !== requestSeq.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const doArchive = async (id: string): Promise<void> => {
    try {
      await props.api.archive(id)
      setSelected(undefined)
      await refresh(query, kind, workspace)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onSearch = (): void => {
    void refresh(query, kind, workspace)
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
        `重要度 ${entry.importance} · 记忆 #${entry.id.slice(0, 8)} · 来自会话 ${shortSessionId(entry.sessionId)} · ${entry.createdAt.slice(0, 10)}`,
      ),
    ),
  )

  return React.createElement(
    'div',
    { style: panelStyle },
    stats !== undefined
      ? React.createElement(
          'div',
          null,
          React.createElement('div', { style: statsStyle }, `共 ${stats.total} 条记忆（${stats.active} 条活跃）`),
          // O1 观测闭环扩展：宿主下发新字段则展示（可选访问，缺则不渲染）
          stats.writeFailures !== undefined && stats.writeFailures > 0
            ? React.createElement('div', { style: { ...statsStyle, ...warnStyle } }, `写失败 ${stats.writeFailures} 次`)
            : null,
          stats.embeddingState !== undefined
            ? React.createElement('div', { style: metaStyle }, `嵌入状态：${stats.embeddingState}`)
            : null,
          stats.lastMaintenanceAt !== undefined && stats.lastMaintenanceAt !== null
            ? React.createElement('div', { style: metaStyle }, `上次维护：${stats.lastMaintenanceAt}`)
            : null,
        )
      : null,
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
      React.createElement(
        'select',
        {
          value: workspace,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setWorkspace(event.target.value),
          style: selectStyle,
        },
        // O4 workspace 过滤：默认"全部工作区" + 从已装载条目详情推导的工作区集合
        React.createElement('option', { key: '', value: '' }, '全部工作区'),
        workspaceOptions.map((ws) => React.createElement('option', { key: ws, value: ws }, ws)),
      ),
      React.createElement('button', { onClick: onSearch, style: buttonStyle }, '搜索'),
    ),
    error !== '' ? React.createElement('div', { style: errorStyle }, error) : null,
    React.createElement('div', { style: listStyle }, rows.length > 0 ? rows : React.createElement('div', null, '（暂无记忆）')),
    selected !== undefined ? React.createElement(DetailPane, { entry: selected, onArchive: () => void doArchive(selected.id) }) : null,
    // 配置区块（面板底部）：当前生效配置表单 + 保存（写回配置源并重启插件生效）
    React.createElement(ConfigPane, { api: props.api }),
  )
}

// ── 配置区块 ────────────────────────────────────────────────────────────

/** 配置表单字段定义（驱动渲染，DRY：新增可改配置只需在此加一行） */
interface ConfigFieldDef {
  /** 配置键（必须与 MemoryPanelConfigView 字段一致） */
  key: keyof MemoryPanelConfigView
  label: string
  type: 'number' | 'boolean' | 'string'
  /** 输入框提示（可选） */
  hint?: string
}

/** 面板可编辑字段清单（配置面最小化——仅远程嵌入 4 项，用户拍板；apiKey 支持字面 key 或 env:NAME） */
const CONFIG_FIELDS: ConfigFieldDef[] = [
  { key: 'embeddingApiBaseUrl', label: '远程 API Base URL', type: 'string' },
  {
    key: 'embeddingApiKey',
    label: '远程 API Key',
    type: 'string',
    hint: '可直接写字面 key，或写 env:NAME 引用环境变量（如 env:SILICONFLOW_KEY）',
  },
  { key: 'embeddingModel', label: '远程模型名', type: 'string' },
  { key: 'embeddingDimension', label: '远程维度', type: 'number' },
]

/** 配置区块：草稿表单 + 保存（仅提交变更项） + 生效提示 */
function ConfigPane(props: { api: MemoryPanelApi }): React.ReactElement {
  // 草稿：字段 → 字符串（输入框统一字符串态，保存时按字段类型转换）
  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [resolved, setResolved] = React.useState(false)
  const [notice, setNotice] = React.useState('')

  React.useEffect(() => {
    void props.api
      .getConfig()
      .then((config) => {
        const initial: Record<string, string> = {}
        for (const field of CONFIG_FIELDS) {
          const value = config[field.key]
          initial[field.key] = String(value)
        }
        setDraft(initial)
        setResolved(config.embeddingApiKeyResolved)
      })
      .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
  }, [props.api])

  const setField = (key: string, value: string): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const save = async (): Promise<void> => {
    try {
      // 仅提交变更项（减少 payload 与校验面）；类型按字段定义转换
      const partial: Record<string, unknown> = {}
      for (const field of CONFIG_FIELDS) {
        const current = draft[field.key]
        if (current === undefined) continue
        const raw = (await props.api.getConfig())[field.key]
        const parsed = field.type === 'number' ? Number(current) : field.type === 'boolean' ? current === 'true' : current
        if (parsed !== raw) partial[field.key] = parsed
      }
      if (Object.keys(partial).length === 0) {
        setNotice('无变更项')
        return
      }
      const config = await props.api.setConfig(partial)
      // 保存成功 = 宿主已校验并写回配置源、插件重启生效
      setNotice('已保存并生效（插件已重启；注入/提取/嵌入按新配置运行）')
      setResolved(config.embeddingApiKeyResolved)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const rows = CONFIG_FIELDS.map((field) => {
    const control =
      field.type === 'boolean'
        ? React.createElement('input', {
            type: 'checkbox',
            checked: draft[field.key] === 'true',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setField(field.key, String(event.target.checked)),
            style: { marginRight: 8 },
          })
        : React.createElement('input', {
            type: 'text',
            value: draft[field.key] ?? '',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setField(field.key, event.target.value),
            style: { ...inputStyle, width: 220 },
          })
    return React.createElement(
      'div',
      { key: field.key, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' } },
      React.createElement('label', { style: { width: 200, flexShrink: 0 } }, field.label),
      control,
      field.hint !== undefined ? React.createElement('span', { style: metaStyle }, field.hint) : null,
    )
  })

  return React.createElement(
    'div',
    { style: { ...detailStyle, marginTop: 12 } },
    React.createElement('h4', null, '配置'),
    React.createElement(
      'div',
      { style: metaStyle },
      `远程 API Key 状态：${resolved ? '已解析可用' : '未配置或环境变量未设置（支持字面 key 或 env:NAME）'}`,
    ),
    rows,
    React.createElement(
      'div',
      { style: { marginTop: 8 } },
      React.createElement('button', { onClick: () => void save(), style: buttonStyle }, '保存'),
      notice !== '' ? React.createElement('span', { style: { ...metaStyle, marginLeft: 8 } }, notice) : null,
    ),
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

// ── 样式（最小内联，跟随官方主题 token --dsw-*） ─────────────────────
// DSH 主题系统：`--dsw-*` 前缀（primitive `--dsw-static-*` + 语义 alias
// `--dsw-alias-*`），声明于 body、明暗经 `body[data-ds-dark-theme]` 切换。
// 官方 UI 全部裸 `var(--dsw-*)` 零 fallback（369 处实证）——本面板同步该模式，
// 不再使用不存在的 `--dsh-*` 变量与硬编码 fallback（用户报告的风格不同步根因）。

const panelStyle: React.CSSProperties = { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }
const statsStyle: React.CSSProperties = { font: 'var(--dsw-font-xs-13)', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }
const listStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }
const detailStyle: React.CSSProperties = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 8 }
const metaStyle: React.CSSProperties = { font: 'var(--dsw-font-xxs-12)', color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0' }
/** 控件统一外观：官方输入/按钮形态（border-l2 边框 + layer-1 底 + primary 文字） */
const inputStyle: React.CSSProperties = {
  marginRight: 8,
  padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}
const selectStyle: React.CSSProperties = {
  marginRight: 8,
  padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}
const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}
const errorStyle: React.CSSProperties = { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }
/** O1 写失败警告：error 语义 tint + 轻微加粗，紧跟统计行 */
const warnStyle: React.CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

function rowStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 8px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 4,
    cursor: 'pointer',
    // 选中行背景：官方交互 hover 底色（settings 面板的通用选中/悬停语义）
    background: active ? 'var(--dsw-alias-interactive-bg-hover)' : undefined,
  }
}
