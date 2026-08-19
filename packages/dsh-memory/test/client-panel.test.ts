/**
 * @module @echocore/dsh-memory/client-panel.test
 *
 * 记忆面板组件行为测试（R4 补盲，2026-08-16）——jsdom + @testing-library/react
 * （render/fireEvent/waitFor 内部处理 act 边界——React 19 手动 act 易脆）。
 * 行为断言优先（网络规范：快照是反模式——只断言用户可感知的输出）。
 *
 * 覆盖：初始加载渲染、搜索交互、详情打开、O1 写失败展示、竞态守卫。
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
    list: async () => [],
    search: async () => [],
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
  return { ...base, ...overrides }
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
    const list = vi.fn(async () => [summary('mem-1', 'fact', '记忆内容甲'), summary('mem-2', 'decision', '决策乙')])
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
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, status }), close: () => {} }))
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
    const search = vi.fn(async () => [summary('mem-9', 'fact', '搜索结果条目')])
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ search }), close: () => {} }))
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
    const list = vi.fn(async () => [summary('mem-1', 'fact', '记忆内容甲')])
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, get }), close: () => {} }))
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
    const list = vi.fn(async () => [summary('mem-1', 'fact', '记忆内容')])
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ status, list }), close: () => {} }))
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
    const list = vi.fn(async () => [summary('mem-1', 'fact', '记忆内容甲'), summary('mem-2', 'fact', '记忆内容乙')])
    const view = render(React.createElement(MemoryPanel, { api: fakeApi({ list, get }), close: () => {} }))
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
})
