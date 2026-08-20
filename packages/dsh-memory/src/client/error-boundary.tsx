/**
 * @module @echocore/dsh-memory/client/error-boundary
 *
 * 面板错误边界：捕获同步渲染异常，展示可重试的错误视图而非空白。
 * 职责单一：仅处理 React 渲染阶段抛错，不触 RPC/slots。
 */

import * as React from 'react'

// ── 错误边界（面板白屏兜底）：捕获同步渲染异常，展示可重试的错误视图而非空白 ──
export class PanelErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 仅日志，不抛；面板可通过"重试"重置
    console.error('[dsh-memory] 面板渲染异常：', error, info)
  }
  override render(): React.ReactNode {
    if (this.state.error !== null) {
      return React.createElement(
        'div',
        { style: { padding: 12, color: 'var(--dsw-alias-state-error-primary)' } },
        React.createElement('div', null, `面板加载失败：${this.state.error.message}`),
        React.createElement(
          'button',
          { style: { marginTop: 8, padding: '4px 10px' }, onClick: () => this.setState({ error: null }) },
          '重试',
        ),
      )
    }
    return this.props.children
  }
}
