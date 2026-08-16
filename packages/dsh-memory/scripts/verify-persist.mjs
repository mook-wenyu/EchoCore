#!/usr/bin/env node
/**
 * 配置持久化链路实机验证脚本（2026-08-16 根因修复——"面板保存成功但重启后配置丢失"）。
 *
 * 用 DSH 真实启动链（@deepseek-ai/dsh-app-boot 的 boot() + 真实 loader /
 * include / settings-file 提供者）在隔离的临时 DSH_HOME 里跑最小 profile，
 * 驱动记忆插件面板 setConfig 的完整宿主链路，断言：
 *   1. 保存后 settings.yaml 出现 memory 段（新持久化通道落盘）；
 *   2. cordis.yml 不被污染（保持组合基底 []——旧链路写回目标，每次启动被重置）；
 *   3. 保存触发插件内存重启（RPC 重新注册）；
 *   4. 独立进程重新 boot（模拟 dsh 重启）后，未再保存即从 settings.yaml 读回
 *      配置（getConfig 返回保存值）——"重启后配置不再丢失"。
 *
 * 用法：node scripts/verify-persist.mjs [--phase2 <根目录>]
 *   --phase2：仅执行"重启后读回"断言（由 phase 1 以子进程方式调用，模拟全新进程）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 真实 DSH 安装包定位：环境变量 > npm 全局前缀 > 常见路径 */
function locateDshPackage() {
  const candidates = [
    process.env.DSH_PKG_DIR,
    process.env.npm_config_prefix && join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh'),
    process.platform === 'win32' && join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(homedir(), '.local', 'share', 'pnpm', 'global', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(`找不到 DSH 安装包（尝试过：${candidates.join('；')}）——设置 DSH_PKG_DIR 环境变量`)
}

const DSH_PKG = locateDshPackage()
/** 默认目标 profile（含已部署的 @echocore/dsh-memory 副本） */
const WEB_PROFILE = process.env.DSH_WEB_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web')
const HERE = fileURLToPath(import.meta.url)

/** 断言工具：失败即抛错（脚本以非零退出码结束） */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  console.log(`  ✓ ${message}`)
}

/** 最小 profile 的组合基底（与 DSH prepareProfile 写回的一致） */
const ROOT_CONFIG = '[]\n'

/** 面板 setConfig 用的验证载荷（4 项嵌入配置全量） */
const SAVE_PAYLOAD = {
  embeddingApiBaseUrl: 'http://verify.local/v1',
  embeddingApiKey: 'env:VERIFY_KEY',
  embeddingModel: 'verify-model',
  embeddingDimension: 512,
}

/** boot 前的宿主 stub（llm/tools/connection/systemPrompt——web 面由 dsh-web-app 提供） */
function prepareStubs(ctx, captured) {
  ctx.provide('llm', { stream: async function* stream() {} })
  ctx.provide('tools', { register: () => {} })
  ctx.provide('connection', {
    rpc: {
      handle: (channel, handler, _options) => {
        captured.handlers[channel] = handler
        captured.handleCount += 1
        return () => {}
      },
    },
  })
  ctx.provide('systemPrompt', { context: () => {} })
}

/** 最小 profile 的 patch 行：settings 提供者 + 记忆插件（组合基底为空，用顶层 insert） */
const PATCHES = [
  {
    insert: [
      { id: 'settings', name: '@deepseek-ai/dsh-settings-file' },
      { id: 'memory', name: '@echocore/dsh-memory' },
    ],
  },
]

/**
 * 解析目标 profile 的插件副本：
 * - `@deepseek-ai` junction → DSH 安装包（顶层行 specifier 用）；
 * - `@echocore/dsh-memory` **绝对** junction → 已部署副本的 realpath。
 *   注意：不能 junction 整个 @echocore 目录——副本是相对符号链接，经 junction
 *   访问时相对目标按逻辑路径解析会断（Node 的 packageResolve 阶段不做 realpath）；
 *   对包本身建绝对 junction 则 package.json 可读，模块加载后 Node 会 realpath，
 *   内部依赖从真实路径解析。
 */
function ensureProfileLinks(profileDir) {
  const nm = join(profileDir, 'node_modules')
  mkdirSync(join(nm, '@echocore'), { recursive: true })
  const targets = [
    [join(nm, '@echocore', 'dsh-memory'), realpathSync(join(WEB_PROFILE, 'node_modules', '@echocore', 'dsh-memory'))],
    [join(nm, '@deepseek-ai'), join(DSH_PKG, 'node_modules', '@deepseek-ai')],
  ]
  for (const [link, target] of targets) {
    if (!existsSync(link)) symlinkSync(target, link, 'junction')
  }
}

/** 一次性 boot：返回根 ctx 与捕获的 RPC handler */
async function bootVerify(root) {
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'verify')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  const cordisPath = join(profileDir, 'cordis.yml')
  writeFileSync(cordisPath, ROOT_CONFIG, 'utf8')
  ensureProfileLinks(profileDir)

  // 必须在使用前设置：settings-file 提供者按 DSH_HOME 解析 settings.yaml
  process.env.DSH_HOME = home

  const { boot } = await import(pathToFileURL(join(DSH_PKG, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href)
  const captured = { handlers: {}, handleCount: 0 }
  const ctx = await boot('dsh-verify', cordisPath, PATCHES, (c) => prepareStubs(c, captured))
  return { ctx, captured, home, profileDir, cordisPath }
}

/**
 * 等待记忆插件 RPC 注册。
 * 插件 apply 的嵌入 init 会加载真实 ~/.dsh/storages/embedding-model 本地模型
 * （插件路径硬编码 homedir()，忽略 DSH_HOME——既有设计，本脚本只读触碰），
 * 耗时数秒；boot 可能在 apply 完成前返回，故轮询而非立即断言。
 */
async function waitForRpc(captured, timeoutMs = 60000, minCount = 1) {
  const deadline = Date.now() + timeoutMs
  while (captured.handlers['/memory'] === undefined || captured.handleCount < minCount) {
    if (Date.now() > deadline) throw new Error(`等待记忆插件 RPC 注册超时（当前注册 ${captured.handleCount} 次）`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return captured.handlers['/memory']
}

/** 断言 settings.yaml 已含 memory 段（新持久化通道落盘） */
function assertSettingsPersisted(home, expected) {
  const file = join(home, 'settings.yaml')
  assert(existsSync(file), `settings.yaml 已生成（${file}）`)
  const text = readFileSync(file, 'utf8')
  for (const [key, value] of Object.entries(expected)) {
    assert(text.includes(key), `settings.yaml 含键 ${key}`)
    assert(text.includes(String(value)), `settings.yaml 的 ${key} = ${String(value)}`)
  }
}

async function phase1(root) {
  console.log('== phase 1：保存配置（真实宿主链路） ==')
  const { ctx, captured, home, profileDir, cordisPath } = await bootVerify(root)
  const rpc = await waitForRpc(captured)
  assert(captured.handlers['/memory'] !== undefined, '记忆插件 RPC 已注册（初始装配）')
  const initialHandleCount = captured.handleCount

  // 面板保存：真实 RPC 处理器 → settings.update（落盘）→ applyChange（内存重启）
  const result = await rpc('setConfig', SAVE_PAYLOAD)
  assert(result.ok === true, 'setConfig 返回 ok')
  const view = result.value.config
  assert(view.embeddingModel === 'verify-model', '响应视图含新配置')

  // 1) settings.yaml 落盘（新通道）
  assertSettingsPersisted(home, SAVE_PAYLOAD)

  // 2) cordis.yml 不被污染（旧链路写回目标保持组合基底）
  assert(readFileSync(cordisPath, 'utf8') === ROOT_CONFIG, 'cordis.yml 保持组合基底（未被 loader 写回污染）')

  // 3) 插件内存重启（等待重启落定后的新 RPC 注册——重启后的 apply 会再次加载
  //    真实本地嵌入模型，耗时数秒）
  const afterRpc = await waitForRpc(captured, 60000, initialHandleCount + 1)
  assert(captured.handleCount === initialHandleCount + 1, `保存触发插件重启（RPC 重注册：${captured.handleCount}）`)

  // 重启后的新装配已读入合并配置
  const after = await afterRpc('getConfig', null)
  assert(after.ok === true && after.value.config.embeddingModel === 'verify-model', '重启后 getConfig 返回保存值')

  // 释放锁与 watcher 后再起"重启"进程（dispose 竞态的无害拒绝由 exit 兜底——见 phase2）
  await ctx.fiber.dispose().catch(() => {})

  console.log('== phase 2：模拟 dsh 重启（独立进程全新 boot） ==')
  const child = spawn(process.execPath, [HERE, '--phase2', root], {
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: home },
  })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  if (code !== 0) throw new Error(`phase 2 失败（退出码 ${code}）——重启后配置丢失仍存在`)
  console.log('验证全部通过：保存 → 重启 → 配置仍在。')
  return { home, profileDir }
}

async function phase2(root) {
  const { ctx, captured } = await bootVerify(root)
  const rpc = await waitForRpc(captured)
  const result = await rpc('getConfig', null)
  assert(result.ok === true, '重启后 getConfig 可用')
  for (const [key, value] of Object.entries(SAVE_PAYLOAD)) {
    assert(result.value.config[key] === value, `重启后 ${key} = ${String(value)}（从 settings.yaml 读回）`)
  }
  console.log('phase 2 通过：未保存即从 settings.yaml 恢复全部 4 项配置。')
  // 直接退出（不做优雅 dispose：apply 的嵌入 init 仍在加载真实模型，dispose 会
  // 与其异步续体竞争产生无害的 unhandledRejection——进程退出即终止一切）
  process.exit(0)
}

async function main() {
  const phase2Arg = process.argv.indexOf('--phase2')
  if (phase2Arg >= 0) {
    await phase2(process.argv[phase2Arg + 1])
    return
  }
  const root = join(process.env.TEMP ?? '/tmp', `memory-persist-verify-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { home, profileDir } = await phase1(root)
    // 清理（junction 先于目录删除；失败保留现场便于排查）
    rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    console.log(`已清理临时目录。DSH_HOME=${home}`)
  } catch (error) {
    console.error(`\n验证失败：${error instanceof Error ? error.message : String(error)}`)
    console.error(`现场保留于：${root}（可手动检查 settings.yaml / cordis.yml）`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
