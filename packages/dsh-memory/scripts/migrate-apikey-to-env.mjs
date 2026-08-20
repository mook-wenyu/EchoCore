#!/usr/bin/env node
/**
 * 一键迁移 settings.yaml 明文 apiKey → env:BAILIAN_API_KEY 引用（P2 密钥 env 化）。
 *
 * 作用：
 * - 扫描 `~/.dsh/settings.yaml`（或 $DSH_HOME/settings.yaml）的 `memory.embeddingApiKey`
 *   若为 `sk-` 开头明文，则替换为 `env:BAILIAN_API_KEY` 引用；
 * - 生成脱敏备份 `<settings.yaml>.bak.<YYYYMMDD-HHmmss>`（明文已打码为 sk-****，可安全留档/分享）；
 * - 校验迁移后文件不再含明文 `sk-` 且含 `env:BAILIAN_API_KEY`；
 * - 若当前环境未设置 `BAILIAN_API_KEY`，给出 export 提示（仅宿主继承 env 生效，无 .env/.credentials 兜底）。
 *
 * 用法：
 *   node scripts/migrate-apikey-to-env.mjs [--dry-run] [--env BAILIAN_API_KEY] [--file ~/.dsh/settings.yaml]
 *
 * 约束：中文日志；不改核心检索逻辑；仅操作 settings.yaml 文本，不依赖宿主进程。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const DEFAULT_ENV = 'BAILIAN_API_KEY'

/** 解析命令行参数 */
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { dryRun: false, envName: DEFAULT_ENV, file: undefined }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--env' && args[i + 1]) opts.envName = args[++i]
    else if (a === '--file' && args[i + 1]) opts.file = resolve(args[++i])
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node scripts/migrate-apikey-to-env.mjs [--dry-run] [--env NAME] [--file PATH]`)
      console.log(`  --dry-run   仅预览，不写文件`)
      console.log(`  --env NAME  环境变量名（默认 ${DEFAULT_ENV}）`)
      console.log(`  --file PATH 指定 settings.yaml 路径（默认 $DSH_HOME/settings.yaml 或 ~/.dsh/settings.yaml）`)
      process.exit(0)
    }
  }
  return opts
}

/** 解析 settings.yaml 路径（与 dsh-home-paths 同源：DSH_HOME 优先） */
function resolveSettingsPath(explicit) {
  if (explicit) return explicit
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'settings.yaml')
}

/** 时间戳（备份文件名） */
function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 脱敏：sk- 开头长串 → sk-****尾4位（保留可追溯性，不泄露完整密钥） */
function maskSk(text) {
  return text.replace(/sk-[A-Za-z0-9._\-]{8,}/g, (m) => {
    if (m.length <= 12) return m.slice(0, 5) + '****'
    return m.slice(0, 7) + '****' + m.slice(-4)
  })
}

/** 脱敏备份专用：对 embeddingApiKey 整段逻辑值打码（兼容折行），其余 sk- 零散出现亦打码 */
function maskSettingsText(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^(\s*embeddingApiKey\s*:\s*)(.*)$/)
    if (m && /sk-/.test(m[2])) {
      const indentAndKey = m[1]
      const isFolded = m[2].trimEnd().endsWith('\\')
      out.push(`${indentAndKey}"sk-****"`)
      if (isFolded) {
        // 跳过折行续行
        let j = i + 1
        while (j < lines.length) {
          const nxt = lines[j]
          if (/^\s+["']?[^:]*["']?\s*$/.test(nxt) && !/^\s*\w+\s*:/.test(nxt.trim())) {
            if (nxt.includes('"') || nxt.trim() === '') {
              i = j
              break
            }
            i = j
            j++
            continue
          }
          break
        }
      }
      continue
    }
    out.push(maskSk(line))
  }
  return out.join('\n')
}

/** 检测是否含明文 sk- 的 embeddingApiKey */
function hasPlainSk(text) {
  // 粗检：embeddingApiKey 行附近含 sk-
  return /embeddingApiKey\s*:/.test(text) && /sk-/.test(text)
}

/** 将 embeddingApiKey 的值替换为 env:NAME（保持缩进与引号风格，兼容折行引号） */
function migrateText(text, envName) {
  // 优先：处理带引号且可能折行的 yaml 值（如 "sk-...\\\n    S0j5..."）
  // 策略：按行扫描，命中 embeddingApiKey 行则重写该逻辑值
  const lines = text.split(/\r?\n/)
  let inKey = false
  let quoteChar = ''
  let replaced = false
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^(\s*embeddingApiKey\s*:\s*)(.*)$/)
    if (m) {
      const indentAndKey = m[1]
      const rest = m[2]
      // 若值含 sk-（单行或引号开头），则替换整条为 env:NAME（带单引号，yaml 安全）
      if (/sk-/.test(rest)) {
        // 检测是否为折行引号（末尾为 \）
        const isFolded = rest.trimEnd().endsWith('\\')
        // 替换当前行
        out.push(`${indentAndKey}'env:${envName}'`)
        replaced = true
        // 若折行，则跳过后续缩进续行（直到非续行）
        if (isFolded) {
          // 续行在原 yaml 是缩进 + 内容（带引号尾），跳过直到含结束引号的行
          let j = i + 1
          while (j < lines.length) {
            const nxt = lines[j]
            // 续行特征：行首缩进 + 非键（不含 :）或含结束引号
            if (/^\s+["']?[^:]*["']?\s*$/.test(nxt) && !/^\s*\w+\s*:/.test(nxt.trim())) {
              // 若该行含结束引号，则为折行尾，跳过后 break
              if (nxt.includes('"') || nxt.trim() === '') {
                i = j
                break
              }
              i = j
              j++
              continue
            }
            break
          }
        }
        inKey = false
        continue
      }
      // 非明文，保持原样
      out.push(line)
      continue
    }
    out.push(line)
  }
  // 兜底：若未替换但全文仍含 sk- 且位于 embeddingApiKey 附近（异常格式），做全局替换
  let result = out.join('\n')
  if (!replaced && hasPlainSk(text)) {
    // 将第一个 sk- 长串替换为 env:引用（避免误删其它 sk-）
    result = result.replace(/sk-[A-Za-z0-9._\-]{8,}/, `env:${envName}`)
    // 清理可能残留的折行续行碎片（已替换主行，续行行首缩进的密钥尾段）
    result = maskSk(result) // 确保无残留明文
    // 若仍被 mask，则恢复 env 引用
    result = result.replace(/sk-\*{4}.*/, `'env:${envName}'`)
  }
  return { text: result, replaced }
}

async function main() {
  const opts = parseArgs()
  const settingsPath = resolveSettingsPath(opts.file)
  console.log(`[migrate] settings.yaml 路径: ${settingsPath}`)
  console.log(`[migrate] 目标 env 引用: env:${opts.envName}`)

  if (!existsSync(settingsPath)) {
    console.error(`[migrate] 文件不存在: ${settingsPath}`)
    console.error(`[migrate] 请确认 DSH_HOME 或 ~/.dsh 已初始化（含 settings.yaml）`)
    process.exitCode = 1
    return
  }

  const original = readFileSync(settingsPath, 'utf8')

  if (!hasPlainSk(original)) {
    // 区分：已是 env 引用 vs 未配置
    if (original.includes(`env:${opts.envName}`)) {
      console.log(`[migrate] 已为 env 引用（env:${opts.envName}），无需迁移。`)
    } else {
      console.log(`[migrate] 未检测到明文 sk- 的 embeddingApiKey，无需迁移。`)
    }
    // 仍做 env 可用性提示
    if (!process.env[opts.envName]) {
      console.warn(`[migrate] 提示: 当前 shell 未设置 ${opts.envName}（宿主仅继承 env，无 .env 兜底；重启 dsh 前需 export ${opts.envName}=...）`)
    } else {
      console.log(`[migrate] 当前环境已含 ${opts.envName}（长度 ${String(process.env[opts.envName]).length}）`)
    }
    return
  }

  // 脱敏备份（原文打码后写入 .bak.<stamp>，可安全留档；embeddingApiKey 整段打码，兼容折行）
  const masked = maskSettingsText(original)
  const backupPath = `${settingsPath}.bak.${stamp()}`
  const { text: migrated, replaced } = migrateText(original, opts.envName)

  // 校验：迁移后应含 env 引用且不含明文 sk-
  const hasEnvRef = migrated.includes(`env:${opts.envName}`)
  const stillHasSk = /sk-[A-Za-z0-9._\-]{8,}/.test(migrated)
  if (!hasEnvRef) {
    console.error(`[migrate] 迁移后未找到 env:${opts.envName} 引用，终止写入（防误覆盖）。`)
    process.exitCode = 1
    return
  }
  if (stillHasSk) {
    console.error(`[migrate] 迁移后仍含明文 sk-，终止写入（请手动检查 yaml 折行格式）。`)
    console.error(`[migrate] 脱敏预览:\n${maskSk(migrated).slice(0, 600)}`)
    process.exitCode = 1
    return
  }

  console.log(`[migrate] 检测到明文 sk-，准备迁移 ${replaced ? '（行级替换）' : '（兜底替换）'}`)
  if (opts.dryRun) {
    console.log(`[migrate] --dry-run 预览（不写文件）：`)
    console.log(`  备份将写入: ${backupPath}（脱敏）`)
    console.log(`  脱敏备份预览:\n${masked.slice(0, 800)}`)
    console.log(`  迁移后预览:\n${migrated.slice(0, 800)}`)
    return
  }

  // 写脱敏备份
  mkdirSync(dirname(backupPath), { recursive: true })
  writeFileSync(backupPath, masked, 'utf8')
  console.log(`[migrate] 已写入脱敏备份: ${backupPath}`)

  // 写迁移后文件（保留原文件权限，由 writeFileSync 覆写）
  writeFileSync(settingsPath, migrated, 'utf8')
  console.log(`[migrate] 已迁移: ${settingsPath} → embeddingApiKey='env:${opts.envName}'`)

  // 验证回读
  const verify = readFileSync(settingsPath, 'utf8')
  if (verify.includes(`env:${opts.envName}`) && !/sk-[A-Za-z0-9._\-]{8,}/.test(verify)) {
    console.log(`[migrate] 校验通过: 文件已为 env 引用且无明文残留。`)
  } else {
    console.error(`[migrate] 校验失败: 文件状态异常，请检查 ${settingsPath}`)
    process.exitCode = 1
    return
  }

  if (!process.env[opts.envName]) {
    console.warn(`[migrate] 重要: 当前 shell 未设置 ${opts.envName}。宿主仅继承 env（无 .env/.credentials 兜底），重启 dsh 前务必执行:`)
    console.warn(`  export ${opts.envName}='sk-...'  # 或在启动 shell 的 profile 中持久化`)
    console.warn(`  验证: grep -r ${opts.envName} ~/.dsh/settings.yaml && echo $' + opts.envName + ' 已可用`)
  } else {
    console.log(`[migrate] 环境变量 ${opts.envName} 已就绪（当前 shell 可见）。重启 dsh 后面板应显示“已解析可用”。`)
  }
  console.log(`[migrate] 完成。验证命令: grep -E 'embeddingApiKey|${opts.envName}' ${settingsPath}`)
}

main().catch((err) => {
  console.error(`[migrate] 失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
