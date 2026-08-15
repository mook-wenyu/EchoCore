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
    // 嵌入默认（删除 embeddingEnabled 与 embeddingApiKey 后：无开关，apiKey 走环境变量）
    expect('embeddingEnabled' in config).toBe(false)
    expect('embeddingApiKey' in config).toBe(false)
    expect(config.embeddingApiBaseUrl).toBe('')
    expect(config.embeddingModel).toBe('')
    expect(config.embeddingDimension).toBe(1024)
    expect(config.embeddingModelDir).toBe('')
  })

  it('防回归：schema 默认值与 DEFAULTS 单源一致（字段存于 dict，default 存于 meta.default——已查证 schemastery）', () => {
    // P1-1 后 Config 是 transform 包装（跨字段互斥校验），object 字段在 inner 上
    const dict = ((Config as unknown as { inner: { dict: Record<string, { meta?: { default?: unknown } }> } }).inner).dict
    expect(dict.injectBudgetChars?.meta?.default).toBe(DEFAULTS.injectBudgetChars)
    expect(dict.maxExtractChars?.meta?.default).toBe(DEFAULTS.maxExtractChars)
    expect(dict.enableMaintenance?.meta?.default).toBe(DEFAULTS.enableMaintenance)
  })

  it('防回归：400K 压缩阈值键已从 schema 移除（迁移到宿主 compaction-basic）', () => {
    // schemastery validate 保留未知键（不剥离），故断言 schema 对象本身不含该键
    const inner = (Config as unknown as { inner: Record<string, unknown> }).inner
    expect('compactThresholdTokens' in inner).toBe(false)
  })

  it('显式配置覆盖默认值', () => {
    const config = parseConfig({ injectBudgetChars: 8192, enableExtractor: false }) as typeof DEFAULTS
    expect(config.injectBudgetChars).toBe(8192)
    expect(config.enableExtractor).toBe(false)
  })

  it('非法类型被拒绝（数字字段传字符串）', () => {
    expect(() => parseConfig({ topK: 'many' } as unknown as Record<string, unknown>)).toThrow()
  })

  it('数值越界被拒绝（P1-1：minScore 0..1）', () => {
    expect(() => parseConfig({ minScore: -0.1 })).toThrow()
    expect(() => parseConfig({ minScore: 1.1 })).toThrow()
  })

  it('非正数值被拒绝（P1-1：topK/预算/提取上限 ≥1）', () => {
    expect(() => parseConfig({ topK: 0 })).toThrow()
    expect(() => parseConfig({ injectBudgetChars: 0 })).toThrow()
    expect(() => parseConfig({ minExtractChars: 0 })).toThrow()
    expect(() => parseConfig({ maxExtractChars: 0 })).toThrow()
    expect(() => parseConfig({ extractMaxTokens: 0 })).toThrow()
  })

  it('跨字段互斥被拒绝（P1-1：minExtractChars > maxExtractChars 会致早期消息永久丢失）', () => {
    expect(() => parseConfig({ minExtractChars: 13000, maxExtractChars: 12000 })).toThrow()
    // 边界合法：相等时语义为"全量摘录"
    expect(() => parseConfig({ minExtractChars: 12000, maxExtractChars: 12000 })).not.toThrow()
  })
})
