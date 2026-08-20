/**
 * @module @echocore/dsh-memory/client/config-pane
 *
 * 配置区块：远程嵌入 4 项的草稿表单 + 保存（仅提交变更项）。
 * 职责：纯展示/交互，不直接触 slots，仅通过 props.api 与宿主 RPC 交互。
 * 解耦：与 MemoryPanel 无循环依赖，经 props 注入 api 与 onSaved 回调。
 */

import * as React from 'react'

import type { MemoryPanelApi, MemoryPanelConfigView } from './api.js'

// ── 配置表单字段定义（驱动渲染，DRY：新增可改配置只需在此加一行） ────────

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

// ── 内联样式（与 panel 对齐，零外部依赖；复刻自原 client.ts） ───────────────

const detailStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  padding: 8,
  flex: '0 1 420px',
  minWidth: 260,
}
const metaStyle: React.CSSProperties = { font: 'var(--dsw-font-xxs-12)', color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0' }
const inputStyle: React.CSSProperties = {
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

/** 配置区块：草稿表单 + 保存（仅提交变更项） + 生效提示。
 * F（2026-08-18 拍板）：默认折叠——低频配置渐进披露；标题可点击展开/收起。 */
export function ConfigPane(props: { api: MemoryPanelApi; onSaved?: () => void }): React.ReactElement {
  // 草稿：字段 → 字符串（输入框统一字符串态，保存时按字段类型转换）
  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [resolved, setResolved] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  // F：折叠态（默认收起）
  const [open, setOpen] = React.useState(false)

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
      // 保存成功 = 宿主已校验、已持久化到 settings.yaml（~/.dsh/settings.yaml——
      // 原写回 cordis.patch.yml 的链路在重启后被 prepareProfile 重置清空，
      // 2026-08-16 实测根因）并实时热换嵌入后端生效（不重启插件——重启与
      // apply 秒级异步段竞态，二次实测 fatal load failure 根因）。
      // 生效结果以顶部「嵌入状态」行为准（状态可见化：ready(local)=本地顶班、
      // 远程未生效原因显式展示）——文案不写死"已热切换"
      setNotice('已保存并生效（已持久化到 settings.yaml；嵌入后端状态见上方「嵌入状态」行）')
      setResolved(config.embeddingApiKeyResolved)
      // 保存后刷新顶部统计行（嵌入后端/失败原因实时可见——状态可见化）
      props.onSaved?.()
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
    // F：标题即折叠开关（渐进披露——低频配置默认收起，避免与数据视图混排）
    React.createElement(
      'h4',
      { style: { cursor: 'pointer', margin: 0 }, onClick: () => setOpen((prev) => !prev) },
      `配置${open ? '（点击收起）' : '（点击展开）'}`,
    ),
    // 默认折叠：仅展开时渲染表单（getConfig 仍在挂载时拉取一次——草稿在展开前就绪，
    // 避免展开后闪空；RPC 单次成本可忽略）
    open
      ? React.createElement(
          'div',
          null,
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
      : null,
  )
}
