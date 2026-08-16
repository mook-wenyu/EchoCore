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

  it('宿主 loader 契约：Config["simplify"] 裸调用不崩（this 绑定）', () => {
    // cordis-plugin-loader 的 internal/update 写回路径以裸引用调用：
    //   const unparse = this.runtime?.Config?.["simplify"];
    //   this.entry.options.config = unparse ? unparse(config) : config;
    // schemastery 的 simplify 是原型方法依赖 this——裸调用 this=undefined →
    // `this.meta` 读 undefined 崩 "Cannot read properties of undefined (reading 'meta')"
    // （用户实测：面板保存配置报错；本测试钉住该契约防回归）。
    const unparse = (Config as unknown as { simplify?: (value: Record<string, unknown>) => unknown }).simplify
    expect(unparse).toBeTypeOf('function')
    const merged = { embeddingApiBaseUrl: 'http://x', embeddingApiKey: 'k', embeddingModel: 'm', embeddingDimension: 1024 }
    const result = unparse!(merged) as Record<string, unknown>
    // simplify 语义：与默认值 deepEqual 的字段塌缩剔除——baseUrl/key/model 非默认
    // 保留；dimension=1024 恰等于默认值被剔除（DSH 配置写回惯例：只落非默认项）
    expect(result).toEqual({ embeddingApiBaseUrl: 'http://x', embeddingApiKey: 'k', embeddingModel: 'm' })
  })
})
