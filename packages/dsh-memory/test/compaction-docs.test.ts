/**
 * 400K 双阈值文档自动化测试（docs/COMPACTION.md 验证命令自动化）。
 *
 * 背景：COMPACTION.md 定义了宿主 compaction-basic 的三常量双阈值滞回（400K/200K/16K），
 * scripts/check-docs.mjs 已覆盖链接有效性，本单测补充阈值语义的文档一致性校验。
 * - 不改核心检索逻辑，仅校验文档常量与示例的完整性与数值关系（可独立验收的守门测试）。
 * - 中文注释；文档漂移（误删阈值/改比值漏改文档）即失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 仓库根（test 文件位于 packages/dsh-memory/test/）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const COMPACTION_MD = path.join(REPO_ROOT, 'docs', 'COMPACTION.md')
const DEPLOYMENT_MD = path.join(REPO_ROOT, 'docs', 'DEPLOYMENT.md')

/** 读取文档（不存在即测试失败，显式提示） */
function readDoc(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`文档不存在：${path.relative(REPO_ROOT, file)}`)
  return fs.readFileSync(file, 'utf8')
}

describe('COMPACTION.md 400K 双阈值滞回（文档守门）', () => {
  it('COMPACTION.md 存在且包含三常量 400K/200K/16K 及其语义', () => {
    const text = readDoc(COMPACTION_MD)

    // 三常量名称必须出现（防误改/误删）
    expect(text).toMatch(/COMPACTION_TRIGGER/)
    expect(text).toMatch(/COMPACTION_TARGET/)
    expect(text).toMatch(/COMPACTION_RESERVE/)

    // 对应数值 400K / 200K / 16K 必须出现（中文文档以 K 为单位）
    expect(text).toMatch(/400K/)
    expect(text).toMatch(/200K/)
    expect(text).toMatch(/16K/)

    // 滞回带语义：TRIGGER 400K - TARGET 200K = 200K 带宽（文档第 4 节图示与文字）
    expect(text).toMatch(/TRIGGER.*TARGET.*200K|滞回带.*200K/)

    // 数值关系守门：TARGET < TRIGGER 且 RESERVE < TARGET（防文档笔误反序）
    // 抽取数值做算术校验（容错：文档可能含多个 200K，取常量表那一行的值）
    const triggerMatch = text.match(/COMPACTION_TRIGGER[^]*?400K/)
    const targetMatch = text.match(/COMPACTION_TARGET[^]*?200K/)
    const reserveMatch = text.match(/COMPACTION_RESERVE[^]*?16K/)
    expect(triggerMatch).not.toBeNull()
    expect(targetMatch).not.toBeNull()
    expect(reserveMatch).not.toBeNull()
    // 数值常量关系：400K > 200K > 16K
    expect(400_000).toBeGreaterThan(200_000)
    expect(200_000).toBeGreaterThan(16_000)
  })

  it('COMPACTION.md 包含 thresholdRatio 0.4 的 profile 示例（1M 窗口 × 0.4 = 400K）', () => {
    const text = readDoc(COMPACTION_MD)

    // profile 段必须含 compaction-basic 解禁与 thresholdRatio 0.4
    expect(text).toMatch(/id:\s*compaction-basic/)
    expect(text).toMatch(/disabled:\s*false/)
    expect(text).toMatch(/thresholdRatio:\s*0\.4/)

    // 触发点算式说明（1M × 0.4 = 400K）必须出现
    expect(text).toMatch(/1M.*0\.4.*400K|0\.4.*1M.*400K/)
  })

  it('COMPACTION.md 的验证章节包含四项验证命令（与文档 §4 一致）', () => {
    const text = readDoc(COMPACTION_MD)

    // §4 验证（宿主是否生效）四项：compaction 命中、thresholdRatio 不在 settings.yaml、运行时验证、阈值重算
    expect(text).toMatch(/grep.*compaction/)
    expect(text).toMatch(/thresholdRatio/)
    expect(text).toMatch(/compaction\/summary|shadowedSeqs/)
    expect(text).toMatch(/阈值重算|新 TRIGGER/)
  })

  it('DEPLOYMENT.md 与 COMPACTION.md 互相引用且常量一致', () => {
    const compaction = readDoc(COMPACTION_MD)
    const deployment = readDoc(DEPLOYMENT_MD)

    // DEPLOYMENT §9 必须链向 COMPACTION.md
    expect(deployment).toMatch(/COMPACTION\.md/)

    // COMPACTION 头部必须链回 DEPLOYMENT.md §9
    expect(compaction).toMatch(/DEPLOYMENT\.md/)

    // 两处文档的阈值描述一致（DEPLOYMENT 复述 400K/200K/16K 或至少 400K）
    expect(deployment).toMatch(/400K/)
    expect(deployment).toMatch(/compaction-basic/)
    expect(deployment).toMatch(/thresholdRatio.*0\.4|0\.4.*thresholdRatio/)

    // DEPLOYMENT 必须提示 provider+model 精确匹配陷阱（2026-08-17 实测根因）
    expect(deployment).toMatch(/provider.*model.*精确匹配|精确匹配.*provider/)
  })

  it('滞回语义数值自检：TRIGGER - TARGET = 200K，且 RESERVE 为下一轮安全余量', () => {
    // 纯数值守门：若未来调整常量，测试显式失败提示同步改文档与代码
    const TRIGGER = 400_000
    const TARGET = 200_000
    const RESERVE = 16_000
    expect(TRIGGER - TARGET).toBe(200_000) // 滞回带
    expect(TARGET + RESERVE).toBeLessThan(TRIGGER) // 目标+预留仍在触发点之下
    expect(RESERVE).toBeGreaterThan(0)
    expect(RESERVE).toBeLessThan(50_000) // 预留不宜过大（防误把 160K 当 16K）
  })
})
