/**
 * 密钥一键迁移脚本集成测试（scripts/migrate-apikey-to-env.mjs）。
 *
 * 在临时 settings.yaml 上串行验证：
 * 1) --dry-run 仅预览不落盘（脱敏备份预览 + 迁移后预览，原文件不变且不产生 .bak）
 * 2) 真跑落盘：脱敏备份（sk-**** 不泄漏明文）且 settings.yaml 变为 env:BAILIAN_API_KEY 引用且无明文残留
 * 3) 幂等：已为 env 引用再次运行提示无需迁移
 * 4) 自定义 --env 与 --file 路径解析
 *
 * 约束：中文注释，不改核心检索；用子进程跑脚本（贴近用户真实用法），临时目录自动清理。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'migrate-apikey-to-env.mjs')

// 每次用例独立临时目录
let tmpDir = ''
let settingsPath = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echocore-migrate-'))
  settingsPath = path.join(tmpDir, 'settings.yaml')
})

afterEach(() => {
  // 清理临时目录（Windows 上 .bak 文件亦需删除）
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败（不影响断言）
  }
})

/** 以指定内容写临时 settings.yaml */
function writeSettings(content: string): void {
  fs.writeFileSync(settingsPath, content, 'utf8')
}

/** 读临时 settings.yaml 原文 */
function readSettings(): string {
  return fs.readFileSync(settingsPath, 'utf8')
}

/** 同步执行迁移脚本（返回 spawnSync 结果） */
function runMigrate(args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

/** 典型含明文 embeddingApiKey 的 settings.yaml */
function plainSettings(apiKey = 'sk-ws-test1234567890abcdef-SECRET_1234'): string {
  return `# DSH settings 示例
memory:
  embeddingApiKey: "${apiKey}"
  embeddingModel: "bge-m3"
  embeddingDimension: 1024
`
}

describe('migrate-apikey-to-env.mjs 集成（临时 settings.yaml）', () => {
  it('--dry-run 仅预览：原文不变且不产生脱敏备份', () => {
    const original = plainSettings()
    writeSettings(original)

    const result = runMigrate(['--dry-run', '--file', settingsPath])

    // 退出码 0（检测到明文但为预览，不报错）
    expect(result.status).toBe(0)
    // stdout 含预览信息
    expect(result.stdout).toMatch(/--dry-run 预览/)
    expect(result.stdout).toMatch(/脱敏备份预览/)
    expect(result.stdout).toMatch(/迁移后预览/)
    expect(result.stdout).toMatch(/env:BAILIAN_API_KEY/)

    // 原文件未被改动
    expect(readSettings()).toBe(original)

    // 未产生 .bak 脱敏备份
    const files = fs.readdirSync(tmpDir)
    expect(files.some((f) => f.includes('.bak.'))).toBe(false)
  })

  it('真跑：生成脱敏备份且 settings 变为 env 引用、无明文残留', () => {
    const sk = 'sk-ws-abcdefghijklmnopqrstuvwxyz-SECRET_9999'
    writeSettings(plainSettings(sk))

    const result = runMigrate(['--file', settingsPath])

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/已写入脱敏备份/)
    expect(result.stdout).toMatch(/已迁移/)
    expect(result.stdout).toMatch(/校验通过/)

    // 迁移后文件含 env 引用且不含明文 sk-
    const migrated = readSettings()
    expect(migrated).toMatch(/env:BAILIAN_API_KEY/)
    expect(migrated).not.toMatch(/sk-[A-Za-z0-9._\-]{8,}/)
    expect(migrated).toMatch(/embeddingApiKey:\s*'env:BAILIAN_API_KEY'/)

    // 脱敏备份存在且已打码（不泄漏完整密钥）
    const files = fs.readdirSync(tmpDir)
    const bakName = files.find((f) => f.includes('.bak.'))
    expect(bakName).toBeDefined()
    const bakText = fs.readFileSync(path.join(tmpDir, bakName!), 'utf8')
    expect(bakText).toMatch(/sk-\*\*\*\*/) // 已打码
    expect(bakText).not.toMatch(sk) // 不含完整明文
    // 备份中 embeddingApiKey 已为打码占位
    expect(bakText).toMatch(/embeddingApiKey:\s*"sk-\*\*\*\*"|sk-\*\*\*\*/)
  })

  it('幂等：已为 env 引用再次运行提示无需迁移且不新增备份', () => {
    writeSettings(plainSettings())
    // 首次真跑
    const first = runMigrate(['--file', settingsPath])
    expect(first.status).toBe(0)
    const filesAfterFirst = fs.readdirSync(tmpDir).filter((f) => f.includes('.bak.'))
    expect(filesAfterFirst.length).toBe(1)

    // 再次运行（已是 env 引用）
    const second = runMigrate(['--file', settingsPath])
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/已为 env 引用|无需迁移/)

    // 幂等：不新增备份
    const filesAfterSecond = fs.readdirSync(tmpDir).filter((f) => f.includes('.bak.'))
    expect(filesAfterSecond.length).toBe(1)

    // 文件仍为 env 引用
    expect(readSettings()).toMatch(/env:BAILIAN_API_KEY/)
  })

  it('折行引号（yaml 折行 \\）的 embeddingApiKey 亦可迁移', () => {
    // 形如 "sk-....\\\n    续行" 的折行格式（脚本需跳过续行）
    const folded = `# 折行示例
memory:
  embeddingApiKey: "sk-ws-foldedKey1234567890\\
    S0j5FoldedTail"
  embeddingModel: "bge-m3"
`
    writeSettings(folded)

    const result = runMigrate(['--file', settingsPath])
    expect(result.status).toBe(0)

    const migrated = readSettings()
    expect(migrated).toMatch(/env:BAILIAN_API_KEY/)
    expect(migrated).not.toMatch(/sk-[A-Za-z0-9._\-]{8,}/)
    // 折行续行不应残留
    expect(migrated).not.toMatch(/S0j5FoldedTail/)
  })

  it('--env 自定义变量名：备份与迁移均使用指定 env 名', () => {
    writeSettings(plainSettings('sk-custom-env-test-12345678'))
    const customEnv = 'MY_EMBED_KEY'
    const result = runMigrate(['--file', settingsPath, '--env', customEnv])

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(new RegExp(`env:${customEnv}`))

    const migrated = readSettings()
    expect(migrated).toMatch(new RegExp(`env:${customEnv}`))
    expect(migrated).not.toMatch(/sk-[A-Za-z0-9._\-]{8,}/)
  })

  it('未含明文 sk- 时提示无需迁移（已干净）', () => {
    writeSettings(`memory:
  embeddingApiKey: ''
  embeddingModel: "bge-m3"
`)
    const result = runMigrate(['--file', settingsPath])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/无需迁移/)
  })

  it('文件不存在时以非零退出并提示路径', () => {
    const missing = path.join(tmpDir, 'not-exist', 'settings.yaml')
    const result = runMigrate(['--file', missing])
    // 脚本对缺失文件置 process.exitCode=1（非 0）
    expect(result.status).not.toBe(0)
    // stderr 或 stdout 含“文件不存在”
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(combined).toMatch(/文件不存在/)
  })
})
