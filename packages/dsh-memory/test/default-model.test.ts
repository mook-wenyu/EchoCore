/**
 * agent-default-model 回退链单测（2026-08-22 根因修复）：
 * 面板"运行反思"报"无可用模型路由"的根因是 getDefaultModel 两路全错——
 * ① 猜测 ctx.get('settings') 契约不存在；② ESM 产物里 require ReferenceError
 * 被空 catch 吞掉。修复后唯一正解 = 官方服务 ctx.agentDefaultModel.currentSelection()。
 */

import { describe, expect, it } from 'vitest'

import { rpcContextFrom } from '../src/index.js'
import type { ResolvedConfig, SettingsSeam } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'

/** 最小配置桩（rpcContextFrom 只透传 config 视图，不校验内容） */
const fallbackConfig = {} as ResolvedConfig

/** 构造带/不带官方服务的假 ctx */
function fakeCtx(agentDefaultModel?: unknown): Context {
  return { agentDefaultModel } as unknown as Context
}

/** 无 seam 直连形态（defaultModel 走被测回退链） */
function build(ctx: Context) {
  return rpcContextFrom(undefined, fallbackConfig, ctx)
}

describe('rpcContextFrom.getDefaultModel（agent-default-model 官方服务回退链）', () => {
  it('宿主服务存在 → currentSelection() 的 provider/model 原样返回', () => {
    const ctx = fakeCtx({
      currentSelection: () => ({ provider: 'opencode-new', model: 'x-preview-f-free', reasoningEffort: 'max' }),
    })
    const route = build(ctx).defaultModel()
    expect(route).toEqual({ provider: 'opencode-new', model: 'x-preview-f-free' })
  })

  it('服务未挂载（非宿主环境）→ undefined（诚实返回，不猜测性兜底）', () => {
    expect(build(fakeCtx(undefined)).defaultModel()).toBeUndefined()
    expect(build({} as Context).defaultModel()).toBeUndefined()
  })

  it('服务形态异常：缺失/空字段 → undefined；抛错则向 RPC 边界传播（禁静默兜底，fail-loud）', () => {
    expect(build(fakeCtx({})).defaultModel()).toBeUndefined()
    expect(build(fakeCtx({ currentSelection: () => ({ provider: '', model: 'm' }) })).defaultModel()).toBeUndefined()
    expect(() =>
      build(
        fakeCtx({
          currentSelection: () => {
            throw new Error('settings 未就绪')
          },
        }),
      ).defaultModel(),
    ).toThrow('settings 未就绪')
  })

  it('回归钉住：产物中不得再出现 ESM 下必死的 require 兜底（根因防复发）', async () => {
    const { readFileSync } = await import('node:fs')
    const lib = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf-8')
    expect(lib.includes("require('node:fs')")).toBe(false)
  })
})
