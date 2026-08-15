#!/usr/bin/env node
/**
 * memory.json 备份脚本（@echocore/dsh-memory 生产运维）。
 *
 * 背景（生产可用性评估 2026-08-15）：memory.json 是记忆库唯一副本
 * （7.59MB / 2937 条，持续写入），无任何备份机制——单点风险。
 *
 * 功能：
 * - 复制 ~/.dsh/storages/memory.json → 备份目录（默认
 *   ~/.dsh/storages/backups/memory-<YYYYMMDD-HHmmss>.json）；
 * - 清理旧备份：按文件名时间戳排序，仅保留最近 N 份（默认 10）。
 *
 * 用法：
 *   node scripts/backup-memory.mjs [备份目录] [保留份数]
 * 建议配合系统计划任务/定时器每日运行（个人场景手动运行亦可）。
 *
 * 边界（显式错误，不静默）：
 * - 源文件不存在 → 报错退出（绝不创建空备份掩盖缺失）；
 * - 备份目录不可写 → 报错退出；
 * - 保留份数 < 1 → 报错退出（0 会删光历史备份，明确拒绝）。
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 源文件：记忆库唯一副本（storage-json 整文件原子写，复制时机任意时刻均一致） */
const SOURCE = join(homedir(), '.dsh', 'storages', 'memory.json')

/** 时间戳文件名（秒级精度；同秒多次运行由保留策略收敛） */
function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function main() {
  const targetDir = process.argv[2] ?? join(homedir(), '.dsh', 'storages', 'backups')
  const keep = Number(process.argv[3] ?? 10)
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`保留份数必须为正整数（收到 ${process.argv[3]}）`)
  }

  // 源缺失即报错——备份脚本绝不掩盖"记忆库消失"这一故障信号
  const { access } = await import('node:fs/promises')
  try {
    await access(SOURCE)
  } catch {
    throw new Error(`源文件不存在：${SOURCE}（记忆库缺失是故障，不是备份时机）`)
  }

  await mkdir(targetDir, { recursive: true })
  const dest = join(targetDir, `memory-${stamp()}.json`)
  await copyFile(SOURCE, dest)
  console.log(`已备份：${SOURCE} → ${dest}`)

  // 保留策略：按文件名（时间戳字典序 = 时间序）排序，删除最旧的超限份
  const backups = (await readdir(targetDir))
    .filter((name) => name.startsWith('memory-') && name.endsWith('.json'))
    .sort()
  const excess = backups.length - keep
  if (excess > 0) {
    for (const name of backups.slice(0, excess)) {
      await rm(join(targetDir, name), { force: false })
      console.log(`已清理旧备份：${name}`)
    }
  }
  console.log(`备份目录：${targetDir}（保留 ${Math.min(backups.length, keep)}/${keep} 份）`)
}

main().catch((error) => {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
