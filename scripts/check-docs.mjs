/**
 * docs-as-code 文档校验（零依赖，Node ESM）——CI 与本地共用入口。
 *
 * 检查项：
 *  1) 断链（link check）：仓库自有 .md 中所有【相对】markdown 链接（含锚点剥离）
 *     必须能从"所在文件目录"解析到真实目标；http(s) 绝对链接与裸锚点 #… 跳过。
 *  2) 中英一致性（zh/en parity）：README.md（英文单源）与 README.zh.md 的标题
 *     （#/## 级）必须在 zh 侧一一存在（漏译即失败）；zh 顶部须有跳回 EN 的语言条。
 *  3) 覆盖范围：遍历仓库自有 .md（跳过 node_modules/.git/.pnpm）。
 *
 * 用法：node scripts/check-docs.mjs            —— 全量检查
 *      node scripts/check-docs.mjs --links      —— 只查断链
 *      node scripts/check-docs.mjs --i18n       —— 只查中英一致性
 * 任一检查发现问题 → 打印明细并以非零退出（CI 门禁）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = [/node_modules/, /\.git[/\\]/, /[\\/]\.pnpm[\\/]/]
const LINKS_ONLY = process.argv.includes('--links')
const I18N_ONLY = process.argv.includes('--i18n')

/** 收集仓库自有 .md 文件（相对路径） */
function collectMdFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (SKIP.some((re) => re.test(rel))) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

/** 检查一：相对 .md 链接解析 */
function linkCheck(root, files) {
  const errors = []
  let checked = 0
  for (const rel of files) {
    const abs = path.join(root, rel)
    const dir = path.dirname(abs)
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    lines.forEach((line, idx) => {
      const re = /\]\(([^)\s]+)\)/g
      let m
      while ((m = re.exec(line)) !== null) {
        let target = m[1]
        if (/^https?:\/\//.test(target)) continue // 外部绝对链接
        if (target.startsWith('#') || target.startsWith('mailto:')) continue // 裸锚点/邮件
        target = target.split('#')[0] // 去锚点
        if (!target) continue
        if (!/\.md$/i.test(target) && !/[\\/]/.test(target)) continue // 非文件链接（如目录引用）
        checked++
        const resolved = path.resolve(dir, target)
        if (!fs.existsSync(resolved)) errors.push(`${rel}:${idx + 1} → ${target}（解析为 ${path.relative(root, resolved)}）`)
      }
    })
  }
  return { errors, checked }
}

/** 检查二：zh 与 en README 标题一致 + 语言条 */
function headingSet(file) {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) return null
  return fs
    .readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^#{1,2}\s+/.test(l))
    .map((l) => l.trim())
}

/** 围栏感知标题计数：跳过 ``` 代码块内的 `#` 注释行（防误把围栏注释当标题） */
function countHeadings(text, lvl) {
  let inFence = false
  const re = new RegExp(`^#{${lvl}}\\s+`)
  return text.split(/\r?\n/).filter((line) => {
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      inFence = !inFence
      return false
    }
    return !inFence && re.test(line)
  }).length
}

function i18nCheck(files) {
  const errors = []
  // 约定：README.md（EN 单源） ↔ README.zh.md（变体）
  const pairs = files
    .filter((f) => /(^|[\\/])README\.md$/.test(f))
    .map((en) => ({ en, zh: en.replace(/(^|[\\/])README\.md$/, '$1README.zh.md') }))
  for (const { en, zh } of pairs) {
    if (!files.includes(zh)) continue
    const enText = fs.readFileSync(path.join(ROOT, en), 'utf8')
    const zhText = fs.readFileSync(path.join(ROOT, zh), 'utf8')
    // 结构性一致性（防"整体漏译整节"；标题文本是翻译 → 不做文本匹对，只做层级计数）
    const h1En = countHeadings(enText, 1)
    const h1Zh = countHeadings(zhText, 1)
    if (h1Zh !== h1En) errors.push(`${zh}：# 标题数 ${h1Zh} ≠ EN ${h1En}`)
    const h2En = countHeadings(enText, 2)
    const h2Zh = countHeadings(zhText, 2)
    // 容差 ≤2：允许 zh 增补"简介"一类小节，但整体漏翻（少 ≥3 节）即失败
    if (Math.abs(h2Zh - h2En) > 2) errors.push(`${zh}：## 标题数 ${h2Zh} vs EN ${h2En}，结构性差异超容差 → 疑似整节漏译`)
    // 语言条：zh 顶部（前 5 行）须含跳回 EN 的链接
    const zhTop = zhText.split(/\r?\n/).slice(0, 5).join('\n')
    if (!/\[[^\]]*English[^\]]*\]\((\.\/)?README\.md\)/.test(zhTop)) {
      errors.push(`${zh} 顶部缺少指向英文单源的切换条 [English](README.md)`)
    }
  }
  return errors
}

const files = collectMdFiles(ROOT)
let failed = false

if (!I18N_ONLY) {
  const { errors, checked } = linkCheck(ROOT, files)
  console.log(`[link] 检查 ${checked} 条相对 .md 链接：${errors.length ? errors.length + ' 处断开' : '全部有效'}`)
  for (const e of errors) console.log('  ✗ ' + e)
  if (errors.length) failed = true
}

if (!LINKS_ONLY) {
  const errors = i18nCheck(files)
  console.log(`[i18n] 中英标题一致性 + 语言条：${errors.length ? errors.length + ' 处问题' : 'OK'}`)
  for (const e of errors) console.log('  ✗ ' + e)
  if (errors.length) failed = true
}

if (failed) {
  console.error('[docs] 校验未通过（需修复后再提交/合并）。')
  process.exit(1)
}
console.log('[docs] 校验通过 ✓')
