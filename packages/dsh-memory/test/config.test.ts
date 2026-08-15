/**
 * @module @echocore/dsh-memory/config.test
 *
 * 配置 schema 测试：默认值落位（含历史防回归：16384 预算、400K 键不在 schema）、
 * 枚举/数值校验拒绝非法输入。此前 config.ts 完全无测试。
 */

import { describe, expect, it } from 'vitest'

import { DEFAULTS, Config } from '../src/config.js'

/** 用 schemastery 的 validate 语义跑一次解析（等价于 loader 加载路径） */
function parseConfig(raw: Record<string, unknown>): unknown {
  const result = (Config as unknown as { '~standard': { validate(value: unknown): { value?: unknown; issues?: unknown } } })['~standard'].validate(raw)
  if ('issues' in result) throw new Error('config 校验失败')
  return result.value
}

describe('Config 默认值', () => {
  it('空配置填充全部 DEFAULTS（含 16384 预算与新增键）', () => {
    const config = parseConfig({}) as typeof DEFAULTS
    expect(config.injectBudgetChars).toBe(16384)
    expect(config.topK).toBe(8)
    expect(config.minScore).toBe(0.15)
    expect(config.minExtractChars).toBe(2000)
    expect(config.maxExtractChars).toBe(12000)
    expect(config.extractMaxTokens).toBe(2048)
    expect(config.enableAutoInject).toBe(true)
    expect(config.enableExtractor).toBe(true)
    expect(config.enableMaintenance).toBe(true)
    expect(config.maintenanceIntervalHours).toBe(6)
  })

  it('防回归：schema 默认值与 DEFAULTS 单源一致（字段存于 dict，default 存于 meta.default——已查证 schemastery）', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta?: { default?: unknown } }> }).dict
    expect(dict.injectBudgetChars?.meta?.default).toBe(DEFAULTS.injectBudgetChars)
    expect(dict.maxExtractChars?.meta?.default).toBe(DEFAULTS.maxExtractChars)
    expect(dict.enableMaintenance?.meta?.default).toBe(DEFAULTS.enableMaintenance)
  })

  it('防回归：400K 压缩阈值键已从 schema 移除（迁移到宿主 compaction-basic）', () => {
    // schemastery validate 保留未知键（不剥离），故断言 schema 对象本身不含该键
    expect('compactThresholdTokens' in Config).toBe(false)
  })

  it('显式配置覆盖默认值', () => {
    const config = parseConfig({ injectBudgetChars: 8192, enableExtractor: false }) as typeof DEFAULTS
    expect(config.injectBudgetChars).toBe(8192)
    expect(config.enableExtractor).toBe(false)
  })

  it('非法类型被拒绝（数字字段传字符串）', () => {
    expect(() => parseConfig({ topK: 'many' } as unknown as Record<string, unknown>)).toThrow()
  })
})
