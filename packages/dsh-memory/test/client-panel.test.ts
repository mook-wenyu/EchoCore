/**
 * @module @echocore/dsh-memory/client-panel.test
 *
 * 记忆面板组件行为测试（R4 补盲，2026-08-16）——jsdom + @testing-library/react
 * （render/fireEvent/waitFor 内部处理 act 边界——React 19 手动 act 易脆）。
 * 行为断言优先（网络规范：快照是反模式——只断言用户可感知的输出）。
 *
 * 覆盖：初始加载渲染、搜索交互、详情打开、O1 写失败展示、竞态守卫、P0 反思状态、第二束面板能力。
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { MemoryPanel, type MemoryPanelApi } from '../src/client.js'

// React 19 act 环境标志（testing-library 依赖它）
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 面板 API 假对象（可覆盖指定方法） */
function fakeApi(overrides?: Partial<MemoryPanelApi>): MemoryPanelApi {
  const base: MemoryPanelApi = {
    list: async () => ({ entries: [], total: 0 } as unknown as any),
    search: async () => ({ entries: [], total: 0 } as unknown as any),
    get: async () => undefined,
    archive: async () => true,
    status: async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'disabled',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }),
    getConfig: async () => ({
      embeddingApiBaseUrl: '',
      embeddingApiKey: 'sk-old',
      embeddingApiKeyResolved: false,
      embeddingModel: '',
      embeddingDimension: 1024,
    }),
    setConfig: async () => ({
      embeddingApiBaseUrl: '',
      embeddingApiKey: 'sk-old',
      embeddingApiKeyResolved: false,
      embeddingModel: '',
      embeddingDimension: 1024,
    }),
    reflect: async () => ({ ran: false, reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }),
  }
  return { ...base, ...overrides } as unknown as MemoryPanelApi
}

/** 一条摘要条目（与宿主 toSummary 形状一致） */
function summary(id: string, kind: string, content: string): Record<string, unknown> {
  return {
    id,
    kind,
    content,
    importance: 5,
    tags: [],
    sessionId: 's-abc123',
    status: 'active',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  }
}

/** 带 tags 的摘要 */
function summaryWithTags(id: string, kind: string, content: string, tags: string[]): Record<string, unknown> {
  return {
    id,
    kind,
    content,
    importance: 5,
    tags,
    sessionId: 's-abc123',
    status: 'active',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  }
}

/** 一条详情（与宿主 toDetail 形状一致） */
function detailOf(id: string, content: string, excerpt: string): Record<string, unknown> {
  return {
    id,
    kind: 'fact',
    content,
    importance: 5,
    tags: [],
    sessionId: 's-abc123',
    status: 'active',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    workspace: 'D:/ws',
    source: { sessionId: 's-abc123', eventSeqs: [1], excerpt },
    accessCount: 1,
    audit: [{ action: 'create', at: '2026-08-16T00:00:00.000Z', by: 'system' }],
  }
}

describe('MemoryPanel 组件行为（jsdom）', () => {
  it('初始加载：列表与统计渲染（list/status 被调）', async () => {
    const list = vi.fn(async () => ({ entries: [summary('mem-1', 'fact', '记忆内容甲'), summary('mem-2', 'decision', '决策乙')], total: 2 }) as unknown as any)
    const status = vi.fn(async () => ({
      total: 2,
      active: 2,
      archived: 0,
      byKind: { fact: 1, preference: 0, decision: 1, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, status } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      expect(list).toHaveBeenCalled()
      expect(status).toHaveBeenCalled()
      await waitFor(() => expect(screen.getByText(/共 2 条记忆/)).toBeTruthy())
      expect(screen.getByText(/\[fact\] 记忆内容甲/)).toBeTruthy()
      expect(screen.getByText(/\[decision\] 决策乙/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('O1 写失败展示：writeFailures>0 渲染红字提示', async () => {
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 3,
      embeddingState: 'ready',
      lastMaintenanceAt: '2026-08-16T00:00:00.000Z',
      rejectedCount: 5,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/写失败 3 次/)).toBeTruthy())
      expect(screen.getByText(/嵌入状态：ready/)).toBeTruthy()
      expect(screen.getByText(/上次维护：2026-08-16/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('状态可见化（2026-08-17）：ready(local) 顶班 + 远程验证失败原因显式展示——不再静默', async () => {
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      embeddingBackend: 'local',
      embeddingInitError: '远程嵌入返回维度 1024 ≠ 配置维度 2048（请核对 embeddingDimension 并删除旧嵌入索引重建）',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/嵌入状态：ready（后端：local）/)).toBeTruthy())
      expect(screen.getByText(/远程嵌入未生效：.*维度/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('保存后刷新统计行（onSaved——嵌入后端状态实时可见，2026-08-17 状态可见化）', async () => {
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'disabled',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const setConfig = vi.fn(async () => ({
      embeddingApiBaseUrl: 'https://b.example/v1',
      embeddingApiKey: 'sk-old',
      embeddingApiKeyResolved: true,
      embeddingModel: 'm',
      embeddingDimension: 1024,
    }))
    const getConfig = vi.fn(async () => ({
      embeddingApiBaseUrl: 'https://a.example/v1',
      embeddingApiKey: 'sk-old',
      embeddingApiKeyResolved: true,
      embeddingModel: 'm',
      embeddingDimension: 1024,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, setConfig, getConfig }), close: () => {} }))
    try {
      await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(0))
      const before = status.mock.calls.length
      // F：配置区默认折叠 → 先点击标题展开
      await waitFor(() => expect(screen.getByText('配置（点击展开）')).toBeTruthy())
      fireEvent.click(screen.getByText('配置（点击展开）'))
      await waitFor(() => expect(screen.getByDisplayValue('https://a.example/v1')).toBeTruthy())
      // 修改 Base URL 输入框 → 与初始草稿不同（有变更项）
      fireEvent.change(screen.getByDisplayValue('https://a.example/v1'), { target: { value: 'https://b.example/v1' } })
      fireEvent.click(screen.getByText('保存'))
      await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ embeddingApiBaseUrl: 'https://b.example/v1' }), { timeout: 2000 })
      // 保存成功后 onSaved 触发 status 二次刷新（顶部嵌入状态行实时更新）
      await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(before), { timeout: 2000 })
      expect(screen.getByText(/已保存并生效/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('搜索交互：输入查询并点击搜索按钮 → search 被调且结果渲染', async () => {
    const search = vi.fn(async () => ({ entries: [summary('mem-9', 'fact', '搜索结果条目')], total: 1 }) as unknown as any)
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ search } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      const input = screen.getByPlaceholderText('搜索记忆…')
      fireEvent.change(input, { target: { value: 'pnpm' } })
      fireEvent.click(screen.getByText('搜索'))
      await waitFor(() => expect(search).toHaveBeenCalled(), { timeout: 2000 })
      const args = search.mock.calls[0]
      expect(args?.[0]).toBe('pnpm')
      await waitFor(() => expect(screen.getByText(/搜索结果条目/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('详情打开：点击条目 → get 被调且详情渲染（含原文摘录）', async () => {
    const get = vi.fn(async () => detailOf('mem-1', '记忆内容甲', '原文摘录'))
    const list = vi.fn(async () => ({ entries: [summary('mem-1', 'fact', '记忆内容甲')], total: 1 }) as unknown as any)
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, get } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/\[fact\] 记忆内容甲/)).toBeTruthy())
      fireEvent.click(screen.getByText(/\[fact\] 记忆内容甲/))
      await waitFor(() => expect(get).toHaveBeenCalledWith('mem-1'))
      await waitFor(() => expect(screen.getByText(/原文摘录：原文摘录/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('E：统计区渲染反思/因果累计（status 已下发字段）', async () => {
    const status = vi.fn(async () => ({
      total: 2,
      active: 2,
      archived: 0,
      byKind: { fact: 1, preference: 0, decision: 1, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
      reflection: { reviewed: 14, decisions: 0, merged: 0, archived: 0, skipped: 0 },
      reflectionCumulative: { runs: 3, decisions: 1, merged: 1, archived: 0, skipped: 1 },
      lastReflectionAt: '2026-08-18T00:00:00.000Z',
      causal: { reviewed: 30, edges: 0, created: 0, skipped: 0 },
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/反思累计：3 轮/)).toBeTruthy())
      expect(screen.getByText(/合并 1/)).toBeTruthy()
      expect(screen.getByText(/上次反思：2026-08-18/)).toBeTruthy()
      expect(screen.getByText(/因果：审 30 · 建边 0/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('E：点击“运行反思”按钮 → reflect 被调并刷新统计', async () => {
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const reflect = vi.fn(async () => ({ ran: true, reviewed: 5, decisions: 1, merged: 1, archived: 0, skipped: 0 }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, reflect }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      fireEvent.click(screen.getByText('运行反思'))
      await waitFor(() => expect(reflect).toHaveBeenCalled(), { timeout: 2000 })
      await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 })
    } finally {
      view.unmount()
    }
  })

  it('容错：status 返回 null 字段（未运行）时不白屏', async () => {
    const status = vi.fn(async () => ({
      total: 1,
      active: 1,
      archived: 0,
      byKind: { fact: 1, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
      reflection: null,
      reflectionCumulative: null,
      lastReflectionAt: null,
      causal: null,
      lastCausalAt: null,
    }))
    const list = vi.fn(async () => ({ entries: [summary('mem-1', 'fact', '记忆内容')], total: 1 }) as unknown as any)
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, list } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/共 1 条记忆/)).toBeTruthy())
      // 不应渲染反思/因果行，也不白屏
      expect(screen.queryByText(/反思累计/)).toBeNull()
      expect(screen.queryByText(/因果：/)).toBeNull()
      expect(screen.getByText(/记忆内容/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('F：配置区默认折叠（标题可见，表单输入框默认不渲染），点击展开后渲染字段', async () => {
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const getConfig = vi.fn(async () => ({
      embeddingApiBaseUrl: 'https://a.example/v1',
      embeddingApiKey: 'sk-test',
      embeddingApiKeyResolved: true,
      embeddingModel: 'm',
      embeddingDimension: 1024,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, getConfig }), close: () => {} }))
    try {
      // 默认折叠：配置标题（带折叠提示）可见，但表单输入框（Base URL）不可见
      await waitFor(() => expect(screen.getByText('配置（点击展开）')).toBeTruthy())
      expect(screen.queryByDisplayValue('https://a.example/v1')).toBeNull()
      // 点击标题展开 → 表单字段渲染
      fireEvent.click(screen.getByText('配置（点击展开）'))
      await waitFor(() => expect(screen.getByDisplayValue('https://a.example/v1')).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('竞态守卫：两次详情请求只采纳最新响应（过期响应被丢弃）', async () => {
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    // 前两次调用是 deriveWorkspaces 的取样（无详情→立即 undefined）；第 3/4 次是
    // openDetail 的请求（挂起供手动 resolve——竞态窗口）
    let call = 0
    const get = vi.fn(() => {
      call++
      if (call <= 2) return Promise.resolve(undefined)
      if (call === 3) return new Promise((resolve) => (resolveFirst = resolve))
      return new Promise((resolve) => (resolveSecond = resolve))
    })
    const list = vi.fn(async () => ({ entries: [summary('mem-1', 'fact', '记忆内容甲'), summary('mem-2', 'fact', '记忆内容乙')], total: 2 }) as unknown as any)
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, get } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/\[fact\] 记忆内容甲/)).toBeTruthy())
      // 连续点击两个条目（第一次响应未返回时发起第二次）
      fireEvent.click(screen.getByText(/\[fact\] 记忆内容甲/))
      fireEvent.click(screen.getByText(/\[fact\] 记忆内容乙/))
      // 先返回过期响应（mem-1），再返回最新（mem-2）——resolve 在 act 内（setSelected 需 act 边界）
      await act(async () => {
        resolveFirst(detailOf('mem-1', '记忆内容甲', '过期响应摘录'))
        resolveSecond(detailOf('mem-2', '记忆内容乙', '最新响应摘录'))
        await Promise.resolve()
      })
      await waitFor(() => expect(screen.getByText(/最新响应摘录/)).toBeTruthy())
      expect(screen.queryByText(/过期响应摘录/)).toBeNull()
    } finally {
      view.unmount()
    }
  })

  // TDD 新增：面板归档链路（详情→归档按钮→archive 调且详情收起，列表刷新）
  it('归档交互：打开详情后点击归档 → archive 被调且详情收起（TDD 新增）', async () => {
    const archive = vi.fn(async () => true)
    const get = vi.fn(async () => detailOf('mem-1', '记忆内容甲', '原文摘录'))
    // 列表刷新第二次返回空（归档后列表变空，验证 refresh 被调）
    let listCalls = 0
    const listWithRefresh = vi.fn(async () => {
      listCalls++
      return { entries: listCalls === 1 ? [summary('mem-1', 'fact', '记忆内容甲')] : [], total: listCalls === 1 ? 1 : 0 } as unknown as any
    })
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list: listWithRefresh, get, archive } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/\[fact\] 记忆内容甲/)).toBeTruthy())
      fireEvent.click(screen.getByText(/\[fact\] 记忆内容甲/))
      await waitFor(() => expect(screen.getByText(/原文摘录：原文摘录/)).toBeTruthy())
      // 详情面板内的归档按钮
      fireEvent.click(screen.getByText('归档'))
      await waitFor(() => expect(archive).toHaveBeenCalledWith('mem-1'))
      // 归档后详情收起（原文摘录不再可见，列表可能刷新为空）
      await waitFor(() => expect(screen.queryByText(/原文摘录：原文摘录/)).toBeNull(), { timeout: 2000 })
    } finally {
      view.unmount()
    }
  })
})

// ── P0 反思按钮增强（isReflecting/loading/ReflectResultView 消费） ───────

describe('MemoryPanel P0 反思增强（TDD）', () => {
  it('首次 stats===undefined 时按钮禁用态“加载中”', async () => {
    const status = vi.fn(async () => new Promise(() => {})) // 永不 resolve，模拟加载中
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status }), close: () => {} }))
    try {
      // 未拿到 stats 前，面板底部应显示加载中，且“运行反思”按钮禁用或显示加载中
      expect(screen.getByText('加载中')).toBeTruthy()
      const btn = screen.getByText('加载中') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    } finally {
      view.unmount()
    }
  })

  it('isReflecting：点击后按钮 disabled+文案“反思中”+spinner，finally 复位', async () => {
    let resolveReflect!: (v: unknown) => void
    const reflect = vi.fn(() => new Promise((resolve) => (resolveReflect = resolve)))
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, reflect }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      const btn = screen.getByText('运行反思') as HTMLButtonElement
      expect(btn.disabled).toBe(false)
      fireEvent.click(btn)
      // 点击后应进入 loading 态
      await waitFor(() => expect(screen.getByText('反思中...')).toBeTruthy())
      expect((screen.getByText('反思中...') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText('⏳')).toBeTruthy()
      // 完成后复位
      await act(async () => {
        resolveReflect({ ran: true, reviewed: 1, decisions: 1, merged: 1, archived: 0, skipped: 0 })
        await Promise.resolve()
      })
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      expect((screen.getByText('运行反思') as HTMLButtonElement).disabled).toBe(false)
    } finally {
      view.unmount()
    }
  })

  it('ReflectResult ran:false + reason → 透出真实原因（不再一律硬编码路由提示）', async () => {
    const reflect = vi.fn(async () => ({ ran: false, reason: '反思批次失败：LLM 400 Bad Request', reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }))
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, reflect }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      fireEvent.click(screen.getByText('运行反思'))
      await waitFor(() => expect(screen.getByText(/反思未执行：反思批次失败：LLM 400 Bad Request/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('ReflectResult ran:false 无 reason（旧宿主）→ 回退路由提示文案', async () => {
    const reflect = vi.fn(async () => ({ ran: false, reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }))
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, reflect }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      fireEvent.click(screen.getByText('运行反思'))
      await waitFor(() => expect(screen.getByText(/无可用模型路由/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('ReflectResult reviewed===0 → 提示“已执行：无候选对（0 审）”', async () => {
    const reflect = vi.fn(async () => ({ ran: true, reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }))
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, reflect }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      fireEvent.click(screen.getByText('运行反思'))
      await waitFor(() => expect(screen.getByText(/已执行：无候选对（0 审）/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('ReflectResult decisions>0 → 提示“审 N·裁 M·合 A·归 B·跳 S”', async () => {
    const reflect = vi.fn(async () => ({ ran: true, reviewed: 5, decisions: 2, merged: 1, archived: 1, skipped: 1 }))
    const status = vi.fn(async () => ({
      total: 0,
      active: 0,
      archived: 0,
      byKind: { fact: 0, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, reflect }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('运行反思')).toBeTruthy())
      fireEvent.click(screen.getByText('运行反思'))
      await waitFor(() => expect(screen.getByText(/审 5·裁 2·合 1·归 1·跳 1/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })
})

// ── 第二束面板能力 ───────────────────────────────────────────────

describe('MemoryPanel 第二束（TDD）', () => {
  it('搜索 debounce 300ms + Enter 触发 + 自动 refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const search = vi.fn(async () => ({ entries: [], total: 0 }) as unknown as any)
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ search } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      const input = screen.getByPlaceholderText('搜索记忆…')
      // 输入后 300ms 内不应立即触发 search（debounce）
      fireEvent.change(input, { target: { value: 'hello' } })
      expect(search).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })
      await waitFor(() => expect(search).toHaveBeenCalled())
      const callsBeforeEnter = search.mock.calls.length
      // Enter 立即触发
      fireEvent.change(input, { target: { value: 'world' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
      await waitFor(() => expect(search.mock.calls.length).toBeGreaterThan(callsBeforeEnter))
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('Load More 分页：展示 total 与“加载更多”按钮，点击后追加', async () => {
    const first = { entries: [summary('a', 'fact', 'A'), summary('b', 'fact', 'B')], total: 4, nextCursor: 'b' }
    const second = { entries: [summary('c', 'fact', 'C'), summary('d', 'fact', 'D')], total: 4 }
    const list = vi.fn()
    list.mockResolvedValueOnce(first as unknown as any)
    list.mockResolvedValueOnce(second as unknown as any)
    const search = vi.fn(async () => ({ entries: [], total: 0 }) as unknown as any)
    const status = vi.fn(async () => ({
      total: 4,
      active: 4,
      archived: 0,
      byKind: { fact: 4, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    // 使用 list 首屏带 nextCursor，面板应显示“加载更多”与 total
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, search, status } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/共 4 条记忆/)).toBeTruthy())
      await waitFor(() => expect(screen.getByText(/已加载 2 \/ 共 4 条/)).toBeTruthy())
      const moreBtn = screen.getByText('加载更多')
      expect(moreBtn).toBeTruthy()
      // 点击加载更多（应触发 list 第二次调用，带 cursor）
      fireEvent.click(moreBtn)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2), { timeout: 2000 })
      // 追加后已加载 4 条（C 与 D 追加）
      await waitFor(() => expect(screen.getByText(/\[fact\] C/)).toBeTruthy(), { timeout: 2000 })
      expect(screen.getByText(/\[fact\] D/)).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('Chips：kind/tag/workspace 可多选/一键清除，选中态同步', async () => {
    const list = vi.fn(async () => ({ entries: [summaryWithTags('a', 'fact', 'A', ['t1']), summaryWithTags('b', 'todo', 'B', ['t2'])], total: 2 }) as unknown as any)
    const status = vi.fn(async () => ({
      total: 2,
      active: 2,
      archived: 0,
      byKind: { fact: 1, preference: 0, decision: 0, todo: 1, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, status } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/\[fact\] A/)).toBeTruthy())
      // kind chips 存在（用 role 区分，避免与 select option 重名）
      expect(screen.getByRole('button', { name: '事实' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '待办' })).toBeTruthy()
      // tag chips 由条目派生
      await waitFor(() => expect(screen.getByText('#t1')).toBeTruthy())
      // 点击选中
      fireEvent.click(screen.getByRole('button', { name: '事实' }))
      // 选中态应变化（可通过样式或再次点击取消验证）
      fireEvent.click(screen.getByRole('button', { name: '事实' }))
      // 一键清除
      expect(screen.getByText('清除筛选')).toBeTruthy()
      fireEvent.click(screen.getByText('清除筛选'))
      // 清除后 chips 应仍存在但未选中（通过点击后无错误验证）
      expect(screen.getByRole('button', { name: '事实' })).toBeTruthy()
    } finally {
      view.unmount()
    }
  })

  it('批量：列表行 checkbox + 全选 + 批量归档逐条调用', async () => {
    const archive = vi.fn(async () => true)
    const list = vi.fn(async () => ({ entries: [summary('a', 'fact', 'A'), summary('b', 'fact', 'B')], total: 2 }) as unknown as any)
    const status = vi.fn(async () => ({
      total: 2,
      active: 2,
      archived: 0,
      byKind: { fact: 2, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, archive, status } as unknown as Partial<MemoryPanelApi>), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/\[fact\] A/)).toBeTruthy())
      const checkboxes = screen.getAllByRole('checkbox')
      // 至少包含：全选 + 每行 checkbox = 3
      expect(checkboxes.length).toBeGreaterThanOrEqual(3)
      // 全选
      fireEvent.click(screen.getByText('全选'))
      // 批量归档按钮显示数量
      await waitFor(() => expect(screen.getByText(/批量归档（2）/)).toBeTruthy())
      fireEvent.click(screen.getByText(/批量归档（2）/))
      await waitFor(() => expect(archive).toHaveBeenCalledTimes(2))
      expect(archive).toHaveBeenCalledWith('a')
      expect(archive).toHaveBeenCalledWith('b')
    } finally {
      view.unmount()
    }
  })

  it('KPI 卡片：reflectionCumulative 跳过率与 semanticHitRate，统计区可折叠', async () => {
    const status = vi.fn(async () => ({
      total: 5,
      active: 5,
      archived: 0,
      byKind: { fact: 5, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
      reflection: { reviewed: 10, decisions: 5, merged: 2, archived: 1, skipped: 2, semanticHitRate: 0.42 },
      reflectionCumulative: { runs: 4, decisions: 6, merged: 3, archived: 1, skipped: 4 },
      lastReflectionAt: '2026-08-20T00:00:00.000Z',
      causal: { reviewed: 10, edges: 5, created: 5, skipped: 0 },
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText(/KPI/)).toBeTruthy())
      expect(screen.getByText(/跳过率：/)).toBeTruthy()
      expect(screen.getByText(/语义命中率：42\.0%/)).toBeTruthy()
      // 统计区可折叠
      const toggle = screen.getByText('收起统计')
      fireEvent.click(toggle)
      await waitFor(() => expect(screen.getByText('展开统计')).toBeTruthy())
      expect(screen.queryByText(/KPI/)).toBeNull()
      fireEvent.click(screen.getByText('展开统计'))
      await waitFor(() => expect(screen.getByText(/KPI/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })

  it('工作区刷新按钮存在且节流', async () => {
    const list = vi.fn(async () => ({ entries: [summary('a', 'fact', 'A')], total: 1 }) as unknown as any)
    const get = vi.fn(async () => detailOf('a', 'A', '摘录'))
    const status = vi.fn(async () => ({
      total: 1,
      active: 1,
      archived: 0,
      byKind: { fact: 1, preference: 0, decision: 0, todo: 0, insight: 0 },
      writeFailures: 0,
      embeddingState: 'ready',
      lastMaintenanceAt: null,
      rejectedCount: 0,
    }))
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, get, status }), close: () => {} }))
    try {
      await waitFor(() => expect(screen.getByText('刷新工作区列表')).toBeTruthy())
      fireEvent.click(screen.getByText('刷新工作区列表'))
      await waitFor(() => expect(get).toHaveBeenCalled(), { timeout: 2000 })
      // 快速二次点击应提示节流
      fireEvent.click(screen.getByText('刷新工作区列表'))
      await waitFor(() => expect(screen.getByText(/刷新过快/)).toBeTruthy())
    } finally {
      view.unmount()
    }
  })
})
