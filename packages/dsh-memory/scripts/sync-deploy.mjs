#!/usr/bin/env node
/**
 * 部署同步脚本（根治 file: 副本的嵌套依赖链接丢失——2026-08-16）。
 *
 * 背景：profile 的 @echocore/dsh-memory 是 pnpm file: 依赖——pnpm install
 * 重建副本（目录哈希变化）时：① 只从源拷贝 lib + package.json（scripts/
 * 不拷）；② **嵌套 dependencies 链接不生成**（副本 node_modules 仅 .bin）——
 * @node-rs/jieba 无法解析（实测三次复发，均为手动补链接）。
 *
 * 本脚本一次完成全部部署同步（幂等）：
 * 1. 复制 lib/*.js + package.json + scripts/*.mjs 到副本（经 symlink 落盘）；
 * 2. 检查并自愈 jieba 嵌套链接（缺失则建 symlink → .pnpm 虚拟根）；
 * 3. 运行期验证：ESM import lib/scoring.js 的 tokenize（jieba 真实可用）。
 *
 * 用法：node scripts/sync-deploy.mjs [profile 路径]
 *   （默认 C:\Users\WenYu\.dsh\profiles\web）
 */

import { cp, mkdir, readdir, symlink, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const profile = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web')
const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..') // packages/dsh-memory
const pkgDir = join(profile, 'node_modules', '@echocore', 'dsh-memory')

/** 解析副本真实路径（@echocore/dsh-memory 是 symlink → .pnpm 虚拟副本） */
async function realPkgDir() {
  const real = await import('node:fs/promises').then((fs) => fs.realpath(pkgDir))
  return real
}

async function main() {
  const real = await realPkgDir()
  console.log(`副本真实路径：${real}`)

  // 1. lib + package.json + scripts（scripts 目录 pnpm 不拷——必须显式建）
  await cp(join(src, 'lib'), join(real, 'lib'), { recursive: true })
  await cp(join(src, 'package.json'), join(real, 'package.json'))
  await mkdir(join(real, 'scripts'), { recursive: true })
  for (const name of await readdir(join(src, 'scripts'))) {
    if (name.endsWith('.mjs')) await cp(join(src, 'scripts', name), join(real, 'scripts', name))
  }
  console.log('✓ lib/package.json/scripts 已同步')

  // 2. jieba 嵌套链接自愈（pnpm 重建副本后丢失——见文件头背景）
  const nested = join(real, 'node_modules', '@node-rs')
  const virtualRoot = join(profile, 'node_modules', '.pnpm', 'node_modules', '@node-rs')
  const jiebaEntry = join(nested, 'jieba')
  try {
    await access(jiebaEntry)
    console.log('✓ jieba 链接存在')
  } catch {
    await mkdir(dirname(nested), { recursive: true })
    await symlink(virtualRoot, nested, 'junction')
    console.log('✓ jieba 链接已自愈（→ .pnpm 虚拟根）')
  }

  // 3. 运行期验证（ESM tokenize——jieba 真实可用；Windows 绝对路径需 file:// URL）
  const { tokenize } = await import(pathToFileURL(join(real, 'lib', 'scoring.js')).href)
  const tokens = tokenize('记忆系统架构设计')
  if (!tokens.includes('记忆系统')) throw new Error(`tokenize 验证失败：${JSON.stringify(tokens)}`)
  console.log(`✓ 运行期验证：tokenize('记忆系统架构设计') → ${JSON.stringify(tokens)}`)
  console.log('部署同步完成。')
}

main().catch((error) => {
  console.error(`部署同步失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
