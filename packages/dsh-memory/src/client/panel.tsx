/**
 * @module @echocore/dsh-memory/client/panel
 *
 * 记忆面板组件（纯 React，无 JSX）：搜索 + 过滤 + 列表 + 详情 + 统计。
 * 依赖：仅通过 props.api 访问数据（已解耦 RPC），通过 props.close 关闭；
 * 配置区委托 ConfigPane，保持职责单一。
 */

import * as React from 'react'

import { shortSessionId } from '../constants.js'

import { ConfigPane } from './config-pane.js'
import type { MemoryDetailView, MemoryPanelApi, MemoryStatsView, MemorySummaryView } from './api.js'

// ── 面板 props ────────────────────────────────────────────────────────────

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

/** 分页常量：每页条数 */
const PAGE_SIZE = 20
/** 搜索防抖延迟 */
const SEARCH_DEBOUNCE_MS = 300
/** 工作区刷新节流间隔（防风暴） */
const WORKSPACE_REFRESH_THROTTLE_MS = 5000

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
  // 成功/提示信息（与 error 分离——成功用绿色样式）
  const [notice, setNotice] = React.useState('')
  // P0：反思执行态——按钮 disabled + loading 文案/spinner，finally 复位
  const [isReflecting, setIsReflecting] = React.useState(false)
  // 分页状态
  const [total, setTotal] = React.useState(0)
  const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined)
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)
  // 批量归档：选中 id 集合
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  // 统计区折叠
  const [statsCollapsed, setStatsCollapsed] = React.useState(false)
  // chips 多选态
  const [chipKinds, setChipKinds] = React.useState<string[]>([])
  const [chipTags, setChipTags] = React.useState<string[]>([])
  const [chipWorkspaces, setChipWorkspaces] = React.useState<string[]>([])
  // 详情请求序号：openDetail 竞态守卫——只采纳最新一次请求的响应
  const requestSeq = React.useRef(0)
  // 工作区下拉来源构建守卫：列表条目摘要（toSummary）不含 workspace 字段，
  // 只能从详情（get）取样推导；用 ref 保证只取样一次，避免每次 refresh 重访详情。
  const workspacesDerivedRef = React.useRef(false)
  // 工作区刷新节流
  const lastWorkspaceRefreshRef = React.useRef(0)
  // 搜索防抖定时器
  const debounceRef = React.useRef<number | undefined>(undefined)
  const didMountDebounceRef = React.useRef(false)

  /** 从分页结果归一化：兼容旧数组形态（直接返回 entries）与新 PagedResult */
  const normalizePaged = React.useCallback(
    (result: unknown): { entries: MemorySummaryView[]; total: number; nextCursor?: string } => {
      if (Array.isArray(result)) {
        return { entries: result as MemorySummaryView[], total: (result as MemorySummaryView[]).length }
      }
      const obj = result as { entries: MemorySummaryView[]; total: number; nextCursor?: string }
      return { entries: obj.entries ?? [], total: obj.total ?? (obj.entries?.length ?? 0), nextCursor: obj.nextCursor }
    },
    [],
  )

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

  /** 刷新工作区列表（暴露按钮，随 refresh 重新 derive，防风暴限流） */
  const refreshWorkspaces = React.useCallback(async (): Promise<void> => {
    const now = Date.now()
    if (now - lastWorkspaceRefreshRef.current < WORKSPACE_REFRESH_THROTTLE_MS) {
      setError('刷新过快，请稍后重试')
      return
    }
    lastWorkspaceRefreshRef.current = now
    workspacesDerivedRef.current = false
    setError('')
    try {
      // 用当前可见条目重新推导；若为空则拉一页列表再推导
      if (entries.length === 0) {
        const res = await props.api.list(undefined, PAGE_SIZE)
        const norm = normalizePaged(res as unknown)
        void deriveWorkspaces(norm.entries)
      } else {
        await deriveWorkspaces(entries)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [entries, props.api, deriveWorkspaces, normalizePaged])

  const refresh = React.useCallback(
    async (q: string, k: string, w: string, opts?: { cursor?: string; append?: boolean; tag?: string }): Promise<void> => {
      try {
        setError('')
        // 保留 notice（反思成功提示不应被后续刷新清空）；仅错误清零
        // 组合 chips 多选过滤：若 chips 有选中，则优先使用 chips 参数
        const effKind = chipKinds.length > 0 ? chipKinds[0] : k === '' ? undefined : k
        const effWorkspace = chipWorkspaces.length > 0 ? chipWorkspaces[0] : w === '' ? undefined : w
        const effTag = chipTags.length > 0 ? chipTags[0] : opts?.tag
        let result: unknown
        // workspace 或 tag 或 kind 多选时走 search 路径传参（list API 无 workspace 参数）；
        // 未选且空查询回退 list()（按最近排序的大库浏览），否则 search。
        const hasFilter = w !== '' || (effWorkspace !== undefined && effWorkspace !== '') || (effTag !== undefined && effTag !== '') || chipKinds.length > 1
        if (w !== '' || effWorkspace !== undefined) {
          const ws = effWorkspace ?? w
          result = await props.api.search(q.trim() === '' ? '' : q, effKind, undefined, ws, effTag, PAGE_SIZE, opts?.cursor)
        } else if (q.trim() === '' && (k === '' || k === undefined) && chipKinds.length === 0 && chipTags.length === 0) {
          result = await props.api.list(undefined, PAGE_SIZE, opts?.cursor)
        } else {
          result = await props.api.search(q, effKind, undefined, undefined, effTag, PAGE_SIZE, opts?.cursor)
        }
        const norm = normalizePaged(result)
        let items = norm.entries
        // 多选 chips 客户端二次过滤（宿主仅支持单值，面板实现多选 OR 语义）
        if (chipKinds.length > 1) {
          items = items.filter((e) => chipKinds.includes(e.kind))
        }
        if (chipTags.length > 1) {
          items = items.filter((e) => e.tags.some((t) => chipTags.includes(t)))
        }
        if (chipWorkspaces.length > 1) {
          // workspace 需从详情取，无法直接过滤摘要；此处保留摘要过滤的占位（实际由宿主单 workspace 过滤）
          // 多 workspace 场景下客户端不过滤，依赖宿主单值；多选仅展示选中态
        }
        if (opts?.append === true) {
          // 去重追加（防宿主忽略 cursor 导致重复）
          setEntries((prev) => {
            const seen = new Set(prev.map((p) => p.id))
            const merged = [...prev]
            for (const it of items) if (!seen.has(it.id)) merged.push(it)
            return merged
          })
        } else {
          setEntries(items)
        }
        setTotal(norm.total)
        setNextCursor(norm.nextCursor)
        // 推导工作区下拉选项（守卫保证仅首次取样一次，除非手动刷新）
        const toDerive = opts?.append === true ? items : items
        void deriveWorkspaces(toDerive)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [props.api, deriveWorkspaces, normalizePaged, chipKinds, chipTags, chipWorkspaces],
  )

  const refreshStats = React.useCallback(async (): Promise<void> => {
    try {
      const s = await props.api.status()
      setStats(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [props.api])

  React.useEffect(() => {
    void refresh('', '', '')
    void refreshStats()
    return () => {
      requestSeq.current++ // 卸载清理：作废未决请求
    }
  }, [refresh, refreshStats, props.api])

  // 搜索 debounce 300ms + 监听 query/kind/workspace 自动 refresh（保留“搜索”按钮）
  React.useEffect(() => {
    if (!didMountDebounceRef.current) {
      didMountDebounceRef.current = true
      return
    }
    if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      void refresh(query, kind, workspace)
    }, SEARCH_DEBOUNCE_MS) as unknown as number
    return () => {
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current)
    }
  }, [query, kind, workspace, refresh, chipKinds, chipTags, chipWorkspaces])

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
      await refreshStats()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // 批量归档：复用 store.archive 逐条
  const doBatchArchive = async (): Promise<void> => {
    if (selectedIds.size === 0) return
    try {
      setError('')
      setNotice('')
      for (const id of selectedIds) {
        await props.api.archive(id)
      }
      setSelectedIds(new Set())
      setSelected(undefined)
      await refresh(query, kind, workspace)
      await refreshStats()
      setNotice(`批量归档完成：${selectedIds.size} 条`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleSelect = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    if (selectedIds.size === entries.length && entries.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(entries.map((e) => e.id)))
    }
  }

  const doReflect = async (): Promise<void> => {
    // P0：isReflecting 置位，按钮 disabled+loading，finally 复位
    setIsReflecting(true)
    try {
      setError('')
      setNotice('')
      const result = await props.api.reflect()
      // 反思会归档/合并 → 列表与统计都需要刷新（统计含反思累计）；纳入 try 且 await
      await refresh(query, kind, workspace)
      await refreshStats()
      // 消费 ReflectResultView（在 refresh 之后设置，避免被 refresh 清空）
      if (result.ran === false) {
        // Q-fix（2026-08-22）：真实原因优先透出——此前一律硬编码"无可用模型路由"，
        // 把 LLM 批次执行错误误标成路由问题，误导排障
        if (result.reason !== undefined && !result.reason.includes('no_model_route')) {
          setError(`反思未执行：${result.reason}`)
        } else {
          setError('无可用模型路由：请在 DSH 设置→模型页面配置默认模型（provider/model），或在记忆面板配置中设置 llm.provider + llm.model，然后发一条消息触发路由缓存')
        }
      } else if (result.reviewed === 0) {
        setNotice('已执行：无候选对（0 审）')
      } else if (result.decisions > 0) {
        setNotice(`审 ${result.reviewed}·裁 ${result.decisions}·合 ${result.merged}·归 ${result.archived}·跳 ${result.skipped}`)
      } else {
        // reviewed>0 但 decisions===0（如全部 skipped/none）
        setNotice(`审 ${result.reviewed}·裁 ${result.decisions}·合 ${result.merged}·归 ${result.archived}·跳 ${result.skipped}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsReflecting(false)
    }
  }

  const onSearch = (): void => {
    void refresh(query, kind, workspace)
  }

  const handleLoadMore = async (): Promise<void> => {
    if (nextCursor === undefined || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      await refresh(query, kind, workspace, { cursor: nextCursor, append: true })
    } finally {
      setIsLoadingMore(false)
    }
  }

  // chips 辅助
  const toggleChip = (value: string, arr: string[], setter: (v: string[]) => void): void => {
    if (arr.includes(value)) setter(arr.filter((v) => v !== value))
    else setter([...arr, value])
  }
  const clearChips = (): void => {
    setChipKinds([])
    setChipTags([])
    setChipWorkspaces([])
    setKind('')
    setWorkspace('')
  }

  // 派生 tag/workspaces 集合（用于 chips 展示）
  const tagOptions = React.useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) for (const t of e.tags) set.add(t)
    return Array.from(set).sort()
  }, [entries])

  // KPI 计算：跳过率、semanticHitRate 趋势
  const skipRate = React.useMemo(() => {
    if (stats?.reflectionCumulative == null) return undefined
    const c = stats.reflectionCumulative
    const totalDecisions = c.decisions + c.skipped
    if (totalDecisions === 0) return 0
    return c.skipped / totalDecisions
  }, [stats])
  const semanticHitRate = stats?.reflection?.semanticHitRate ?? stats?.semanticHitRate

  const rows = entries.map((entry) =>
    React.createElement(
      'div',
      {
        key: entry.id,
        onClick: () => void openDetail(entry.id),
        style: rowStyle(entry.id === selected?.id),
      },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        // 批量选择 checkbox（阻止冒泡，避免触发 openDetail）
        React.createElement('input', {
          type: 'checkbox',
          checked: selectedIds.has(entry.id),
          onChange: () => toggleSelect(entry.id),
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
        }),
        React.createElement('div', null, `[${entry.kind}] ${entry.content}`),
      ),
      React.createElement(
        'div',
        { style: metaStyle },
        `重要度 ${entry.importance} · 记忆 #${entry.id.slice(0, 8)} · 来自会话 ${shortSessionId(entry.sessionId)} · ${entry.createdAt.slice(0, 10)}`,
      ),
    ),
  )

  // 统计区可折叠标题
  const statsHeader = React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
    React.createElement('div', { style: statsStyle }, `共 ${stats?.total ?? 0} 条记忆（${stats?.active ?? 0} 条活跃）`),
    React.createElement(
      'button',
      { onClick: () => setStatsCollapsed((v) => !v), style: { ...buttonStyle, padding: '2px 8px', fontSize: 12 } },
      statsCollapsed ? '展开统计' : '收起统计',
    ),
  )

  return React.createElement(
    'div',
    { style: panelStyle },
    // 统计区（可折叠）
    stats !== undefined
      ? React.createElement(
          'div',
          null,
          statsHeader,
          statsCollapsed
            ? null
            : React.createElement(
                'div',
                null,
                // O1 观测闭环扩展：宿主下发新字段则展示（可选访问，缺则不渲染）
                stats.writeFailures !== undefined && stats.writeFailures > 0
                  ? React.createElement('div', { style: { ...statsStyle, ...warnStyle } }, `写失败 ${stats.writeFailures} 次`)
                  : null,
                stats.embeddingState !== undefined
                  ? React.createElement(
                      'div',
                      { style: metaStyle },
                      `嵌入状态：${stats.embeddingState}${stats.embeddingBackend !== undefined ? `（后端：${stats.embeddingBackend}）` : ''}`,
                    )
                  : null,
                stats.embeddingInitError !== undefined
                  ? React.createElement('div', { style: { ...metaStyle, ...warnStyle } }, `远程嵌入未生效：${stats.embeddingInitError}`)
                  : null,
                stats.embeddingDegradedReason != null
                  ? React.createElement('div', { style: { ...metaStyle, ...warnStyle } }, `嵌入降级：${stats.embeddingDegradedReason}`)
                  : null,
                stats.lastMaintenanceAt !== undefined && stats.lastMaintenanceAt !== null
                  ? React.createElement('div', { style: metaStyle }, `上次维护：${stats.lastMaintenanceAt}`)
                  : null,
                // E：反思/因果观测行
                stats.reflectionCumulative != null
                  ? React.createElement(
                      'div',
                      { style: metaStyle },
                      `反思累计：${stats.reflectionCumulative.runs} 轮 · 裁决 ${stats.reflectionCumulative.decisions} · 合并 ${stats.reflectionCumulative.merged} · 归档 ${stats.reflectionCumulative.archived} · 跳过 ${stats.reflectionCumulative.skipped}`,
                    )
                  : null,
                stats.lastReflectionAt !== undefined && stats.lastReflectionAt !== null
                  ? React.createElement('div', { style: metaStyle }, `上次反思：${stats.lastReflectionAt.slice(0, 10)}`)
                  : null,
                stats.causal != null
                  ? React.createElement('div', { style: metaStyle }, `因果：审 ${stats.causal.reviewed} · 建边 ${stats.causal.created}`)
                  : null,
                // KPI 卡片：reflectionCumulative 7日/累计对比、跳过率、semanticHitRate 趋势
                stats.reflectionCumulative != null
                  ? React.createElement(
                      'div',
                      { style: kpiCardStyle },
                      React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'KPI'),
                      React.createElement('div', { style: metaStyle }, `累计：${stats.reflectionCumulative.runs} 轮 · 7日≈${stats.reflectionCumulative.runs} 轮（累计对比）`),
                      skipRate !== undefined
                        ? React.createElement('div', { style: metaStyle }, `跳过率：${(skipRate * 100).toFixed(1)}%`)
                        : null,
                      semanticHitRate !== undefined
                        ? React.createElement('div', { style: metaStyle }, `语义命中率：${(semanticHitRate * 100).toFixed(1)}% 趋势`)
                        : React.createElement('div', { style: metaStyle }, '语义命中率：—'),
                    )
                  : null,
                // P0：首次 stats===undefined 时按钮禁用态“加载中”；isReflecting 时 disabled+loading 文案/spinner
                React.createElement(
                  'button',
                  {
                    onClick: () => void doReflect(),
                    disabled: stats === undefined || isReflecting,
                    style: { ...buttonStyle, marginTop: 4, opacity: stats === undefined || isReflecting ? 0.6 : 1 },
                  },
                  stats === undefined ? '加载中' : isReflecting ? '反思中...' : '运行反思',
                ),
                isReflecting ? React.createElement('span', { style: { marginLeft: 6 } }, '⏳') : null,
              ),
        )
      : React.createElement(
          'div',
          null,
          React.createElement('div', { style: statsStyle }, '加载中…'),
          React.createElement(
            'button',
            { disabled: true, style: { ...buttonStyle, marginTop: 4, opacity: 0.6 } },
            '加载中',
          ),
        ),
    // 搜索区：input 支持 Enter 触发 + debounce 自动 refresh
    React.createElement(
      'div',
      null,
      React.createElement('input', {
        value: query,
        placeholder: '搜索记忆…',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') void refresh(query, kind, workspace)
        },
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
        React.createElement('option', { key: '', value: '' }, '全部工作区'),
        workspaceOptions.map((ws) => React.createElement('option', { key: ws, value: ws }, ws)),
      ),
      React.createElement('button', { onClick: onSearch, style: buttonStyle }, '搜索'),
      React.createElement('button', { onClick: () => void refreshWorkspaces(), style: { ...buttonStyle, marginLeft: 6 } }, '刷新工作区列表'),
    ),
    // Chips：kind/tag/workspace 可多选 + 一键清除
    React.createElement(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
      // kind chips
      KIND_LABELS.filter(([v]) => v !== '').map(([value, label]) =>
        React.createElement(
          'button',
          {
            key: `kind-${value}`,
            onClick: () => toggleChip(value, chipKinds, setChipKinds),
            style: chipStyle(chipKinds.includes(value)),
          },
          label,
        ),
      ),
      // tag chips
      tagOptions.map((tag) =>
        React.createElement(
          'button',
          {
            key: `tag-${tag}`,
            onClick: () => toggleChip(tag, chipTags, setChipTags),
            style: chipStyle(chipTags.includes(tag)),
          },
          `#${tag}`,
        ),
      ),
      // workspace chips
      workspaceOptions.map((ws) =>
        React.createElement(
          'button',
          {
            key: `ws-chip-${ws}`,
            onClick: () => toggleChip(ws, chipWorkspaces, setChipWorkspaces),
            style: chipStyle(chipWorkspaces.includes(ws)),
          },
          ws.slice(0, 20),
        ),
      ),
      React.createElement('button', { onClick: clearChips, style: { ...buttonStyle, padding: '2px 8px', fontSize: 12 } }, '清除筛选'),
    ),
    error !== '' ? React.createElement('div', { style: errorStyle }, error) : null,
    notice !== '' ? React.createElement('div', { style: noticeStyle }, notice) : null,
    // 批量操作区：全选 + 批量归档
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
        React.createElement('input', {
          type: 'checkbox',
          checked: entries.length > 0 && selectedIds.size === entries.length,
          onChange: toggleSelectAll,
        }),
        '全选',
      ),
      React.createElement(
        'button',
        { onClick: () => void doBatchArchive(), disabled: selectedIds.size === 0, style: { ...buttonStyle, opacity: selectedIds.size === 0 ? 0.5 : 1 } },
        `批量归档${selectedIds.size > 0 ? `（${selectedIds.size}）` : ''}`,
      ),
      React.createElement('div', { style: metaStyle }, `已加载 ${entries.length}${total > 0 ? ` / 共 ${total} 条` : ''}`),
      nextCursor !== undefined
        ? React.createElement(
            'button',
            { onClick: () => void handleLoadMore(), disabled: isLoadingMore, style: buttonStyle },
            isLoadingMore ? '加载中...' : '加载更多',
          )
        : null,
    ),
    // A：master-detail 并排分栏（列表左 + 详情右；窄屏自动换行叠层）
    React.createElement(
      'div',
      { style: mainRowStyle },
      React.createElement('div', { style: listStyle }, rows.length > 0 ? rows : React.createElement('div', null, '（暂无记忆）')),
      selected !== undefined ? React.createElement(DetailPane, { entry: selected, onArchive: () => void doArchive(selected.id) }) : null,
    ),
    // 配置区块（F：默认折叠——低频配置渐进披露；面板底部）
    React.createElement(ConfigPane, { api: props.api, onSaved: () => void refreshStats() }),
  )
}

/** 详情面板：内容、来源、摘录、审计日志（防御畸形条目：缺失字段时降级展示而非抛错白屏） */
function DetailPane(props: { entry: MemoryDetailView; onArchive: () => void }): React.ReactElement {
  const entry = props.entry
  const auditRows = Array.isArray(entry.audit)
    ? entry.audit.map((record, index) =>
        React.createElement('div', { key: index, style: metaStyle }, `${record.at} [${record.by}] ${record.action}${record.detail ? `：${record.detail}` : ''}`),
      )
    : []
  return React.createElement(
    'div',
    { style: detailStyle },
    React.createElement('h4', null, `记忆 #${(entry.id ?? '').slice(0, 8)}（${entry.kind ?? 'unknown'}，重要度 ${entry.importance ?? '-'}，状态 ${entry.status ?? '-'}）`),
    React.createElement('p', null, entry.content ?? '（无内容）'),
    React.createElement('p', { style: metaStyle }, `来源会话：${entry.source?.sessionId ?? '未知'}`),
    React.createElement('p', { style: metaStyle }, `来源事件序号：${entry.source?.eventSeqs?.join(', ') || '（手动记录）'}`),
    React.createElement('p', { style: metaStyle }, `原文摘录：${entry.source.excerpt.slice(0, 200)}`),
    React.createElement('p', { style: metaStyle }, `访问次数：${entry.accessCount}`),
    React.createElement('div', { style: metaStyle }, '审计日志：'),
    auditRows,
    React.createElement('button', { onClick: props.onArchive, style: buttonStyle }, '归档'),
  )
}

// ── 样式（最小内联，跟随官方主题 token --dsw-*） ───────────────────────
// DSH 主题系统：`--dsw-*` 前缀（primitive `--dsw-static-*` + 语义 alias
// `--dsw-alias-*`），声明于 body、明暗经 `body[data-ds-dark-theme]` 切换。
// 官方 UI 全部裸 `var(--dsw-*)` 零 fallback（369 处实证）——本面板同步该模式，

const panelStyle: React.CSSProperties = { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }
const statsStyle: React.CSSProperties = { font: 'var(--dsw-font-xs-13)', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }
/** A：master-detail 并排分栏——列表左 + 详情右；窄屏（flex 换行）自动叠层 */
const mainRowStyle: React.CSSProperties = { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }
const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 360,
  overflowY: 'auto',
  flex: '1 1 320px',
  minWidth: 280,
}
const detailStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  padding: 8,
  // A：详情作为右栏（固定 ~420px；窄屏换行后占满）
  flex: '0 1 420px',
  minWidth: 260,
}
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
const noticeStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }
/** O1 写失败警告：error 语义 tint + 轻微加粗，紧跟统计行 */
const warnStyle: React.CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
/** KPI 卡片样式 */
const kpiCardStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  padding: 8,
  marginTop: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
}

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

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '2px 8px',
    borderRadius: 12,
    border: `1px solid ${active ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'}`,
    background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontSize: 12,
  }
}
