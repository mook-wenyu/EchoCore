/**
 * O5a 常量轻量断言：核对 src/constants.ts 的纯导出常量——类型与正值，
 * 防止误改/误删导致跨模块契约漂移。
 * SNAPSHOT_PER_SESSION_CAP 定义于 src/stable-snapshot.ts（快照浅聚），一并核对。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WORKSPACE,
  EXCERPT_MAX_CHARS,
  MEMORY_INJECTION_HEADER,
  MEMORY_PLUGIN_ID,
  shortSessionId,
} from '../src/constants.js'
import { SNAPSHOT_PER_SESSION_CAP } from '../src/stable-snapshot.js'

describe('constants.ts 纯导出常量', () => {
  it('MEMORY_PLUGIN_ID 为非空字符串（消息来源标记与注入自检键）', () => {
    expect(typeof MEMORY_PLUGIN_ID).toBe('string')
    expect(MEMORY_PLUGIN_ID.length).toBeGreaterThan(0)
  })

  it('EXCERPT_MAX_CHARS 为正整数（来源摘录上限）', () => {
    expect(Number.isInteger(EXCERPT_MAX_CHARS)).toBe(true)
    expect(EXCERPT_MAX_CHARS).toBeGreaterThan(0)
  })

  it('DEFAULT_WORKSPACE 为非空字符串（workspace 缺失回退键）', () => {
    expect(typeof DEFAULT_WORKSPACE).toBe('string')
    expect(DEFAULT_WORKSPACE.length).toBeGreaterThan(0)
  })

  it('MEMORY_INJECTION_HEADER 为非空字符串（注入声明头）', () => {
    expect(typeof MEMORY_INJECTION_HEADER).toBe('string')
    expect(MEMORY_INJECTION_HEADER.length).toBeGreaterThan(0)
  })

  it('SNAPSHOT_PER_SESSION_CAP 为正整数（每会话快照浅聚上限）', () => {
    expect(Number.isInteger(SNAPSHOT_PER_SESSION_CAP)).toBe(true)
    expect(SNAPSHOT_PER_SESSION_CAP).toBeGreaterThan(0)
  })

  it('shortSessionId 去前缀取 8 位（纯函数给定输入确定）', () => {
    expect(shortSessionId('session-63bbf845-9e8d')).toBe('63bbf845')
    expect(shortSessionId('63bbf845-9e8d')).toBe('63bbf845')
    expect(shortSessionId('session-abc')).toBe('abc')
  })
})
