/**
 * @module @echocore/dsh-memory/config.test
 *
 * 配置 schema 测试：默认值落位（配置面最小化后仅远程嵌入 4 项）、
 * 数值/类型校验拒绝非法输入。
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
  it('空配置填充远程嵌入 4 项 DEFAULTS（其余行为参数已删除为常量）', () => {
    const config = parseConfig({}) as typeof DEFAULTS
    expect(config.embeddingApiBaseUrl).toBe('')
    expect(config.embeddingApiKey).toBe('')
    expect(config.embeddingModel).toBe('')
    expect(config.embeddingDimension).toBe(1024)
    // 已删除键（配置面最小化防回归：行为参数/开关/本地目录均不在 schema）
    for (const removed of [
      'embeddingEnabled',
      'embeddingModelDir',
      'topK',
      'minScore',
      'injectBudgetChars',
      'enableAutoInject',
      'enableSnapshot',
      'snapshotTtlMs',
      'snapshotBudgetChars',
      'snapshotTopK',
      'enableExtractor',
      'minExtractChars',
      'maxExtractChars',
      'extractMaxTokens',
      'enableMaintenance',
      'maintenanceIntervalHours',
    ]) {
      expect(removed in config, `${removed} 应已从配置删除`).toBe(false)
    }
  })

  it('显式配置覆盖默认值', () => {
    const config = parseConfig({ embeddingApiBaseUrl: 'https://api.example.com/v1', embeddingDimension: 512 }) as typeof DEFAULTS
    expect(config.embeddingApiBaseUrl).toBe('https://api.example.com/v1')
    expect(config.embeddingDimension).toBe(512)
  })

  it('非法类型被拒绝（数字字段传字符串）', () => {
    expect(() => parseConfig({ embeddingDimension: 'many' } as unknown as Record<string, unknown>)).toThrow()
  })

  it('非正数值被拒绝（embeddingDimension ≥1）', () => {
    expect(() => parseConfig({ embeddingDimension: 0 })).toThrow()
  })
})
