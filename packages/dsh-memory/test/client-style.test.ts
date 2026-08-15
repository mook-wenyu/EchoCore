/**
 * @module @echocore/dsh-memory/client-style.test
 *
 * 面板样式主题一致性测试（防回归）：
 * - 面板不得再使用不存在的 `--dsh-*` 颜色变量（官方主题是 `--dsw-*` 前缀，
 *   历史 bug：`--dsh-border/--dsh-danger/--dsh-accent-soft` 从未被官方定义，
 *   只能靠 fallback 硬编码色运行——风格不同步根因）；
 * - 引用的 `--dsw-*` token 必须是官方主题 alias 清单成员（清单来源：
 *   dsh-client-ui-theme/lib/styles/design-platform.css，2026-08-15 实证；
 *   官方 UI 全部裸 var 零 fallback，本面板同步该模式）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 面板源码路径（相对本测试文件） */
const CLIENT_SRC = resolve(import.meta.dirname, '../src/client.ts')

/**
 * 官方主题 alias token 清单（design-platform.css:156-246 实证，2026-08-15）。
 * 面板允许使用的全部 `--dsw-*` token 必须在此清单内——新增 token 前先查证官方主题。
 */
const OFFICIAL_ALIAS_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-border-inverted',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-quaternary',
  '--dsw-alias-line-secondary',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-separator-primary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
])

/** 官方字号 token（gradient-shadow-text.css:19-232 实证）——面板使用的两个 */
const OFFICIAL_FONT_TOKENS = new Set(['--dsw-font-xs-13', '--dsw-font-xxs-12'])

describe('记忆面板样式与 DSH 主题同步（防回归）', () => {
  const source = readFileSync(CLIENT_SRC, 'utf8')

  it('不再使用不存在的 --dsh-* 颜色变量（风格不同步根因）', () => {
    const offenders = [...source.matchAll(/var\(--dsh-[^)]*\)/g)].map((match) => match[0])
    expect(offenders).toEqual([])
  })

  it('全部 --dsw-* 引用都在官方 alias/font 清单内（token 有效性）', () => {
    // 精确 token 形态（alias/specific/static/font + 字母数字段），避免命中注释中的字面 `var(--dsw-*)`
    const used = [...source.matchAll(/var\((--dsw-(?:alias|specific|static|font)-[a-z0-9-]+)\)/g)].map((match) => match[1])
    const unknown = used.filter((token) => !OFFICIAL_ALIAS_TOKENS.has(token) && !OFFICIAL_FONT_TOKENS.has(token))
    expect(unknown).toEqual([])
  })

  it('不再有硬编码 fallback 颜色（官方模式：裸 var 零 fallback）', () => {
    const fallbacks = [...source.matchAll(/var\(--dsw-[^)]*,\s*[^)]*\)/g)].map((match) => match[0])
    expect(fallbacks).toEqual([])
  })

  it('次要文字走官方 label 语义 token（不再用 opacity 代替颜色）', () => {
    // metaStyle/statsStyle 不得再用 opacity 控制文字层级（官方用 label-secondary/tertiary）
    const styleSection = source.slice(source.indexOf('─ 样式'))
    expect(styleSection).toContain('--dsw-alias-label-secondary')
    expect(styleSection).toContain('--dsw-alias-label-tertiary')
  })
})
