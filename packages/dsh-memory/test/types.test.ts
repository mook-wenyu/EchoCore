/**
 * @module @echocore/dsh-memory/types.test
 *
 * 类型与辅助函数测试：去重键规范化（去重合并的核心逻辑，此前无直接测试）、
 * 枚举单源（schema 与工具从此派生）、supersede 字段形态。
 */

import { describe, expect, it } from 'vitest'

import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  dedupKeyOf,
  fnv1a,
  newMemoryId,
  normalizeContent,
  type MemoryEntry,
} from '../src/types.js'

describe('normalizeContent（去重规范化）', () => {
  it('折叠大小写与首尾空白', () => {
    expect(normalizeContent('  Hello World  ')).toBe('hello world')
  })

  it('压缩连续空白（含换行）为单空格', () => {
    expect(normalizeContent('pnpm  workspace\n管理\t多包')).toBe('pnpm workspace 管理 多包')
  })

  it('空串与纯空白归一为空串', () => {
    expect(normalizeContent('   ')).toBe('')
  })
})

describe('dedupKeyOf（去重键）', () => {
  it('语义等价的不同书写产生相同键（提取与手动写入可合并）', () => {
    expect(dedupKeyOf('  A B  ')).toBe(dedupKeyOf('a b'))
  })

  it('内容不同产生不同键', () => {
    expect(dedupKeyOf('使用 pnpm')).not.toBe(dedupKeyOf('使用 yarn'))
  })
})

describe('fnv1a', () => {
  it('确定性：同输入同输出', () => {
    expect(fnv1a('记忆内容')).toBe(fnv1a('记忆内容'))
  })

  it('输出为 36 进制短串', () => {
    expect(fnv1a('x')).toMatch(/^[0-9a-z]+$/)
    expect(fnv1a('x').length).toBeGreaterThan(0)
  })
})

describe('newMemoryId', () => {
  it('生成 uuid 且唯一', () => {
    const a = newMemoryId()
    const b = newMemoryId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})

describe('枚举单源', () => {
  it('五类记忆、两类状态、五类审计动作、四类审计主体', () => {
    expect(MEMORY_KINDS).toEqual(['fact', 'preference', 'decision', 'todo', 'insight'])
    expect(MEMORY_STATUSES).toEqual(['active', 'archived'])
    expect(AUDIT_ACTIONS).toEqual(['create', 'update', 'merge', 'archive', 'supersede'])
    expect(AUDIT_ACTORS).toEqual(['extractor', 'tool', 'user', 'system'])
  })

  it('D-D 裁决：deleted/restore/delete/inject 已从枚举移除', () => {
    expect(MEMORY_STATUSES).not.toContain('deleted')
    expect(AUDIT_ACTIONS).not.toContain('restore')
    expect(AUDIT_ACTIONS).not.toContain('delete')
    expect(AUDIT_ACTIONS).not.toContain('inject')
  })
})

describe('MemoryEntry supersede 字段（D-A 后向引用）', () => {
  it('可选字段存在且类型为字符串', () => {
    const entry: MemoryEntry = {
      id: 'id',
      workspace: 'w',
      sessionId: 's',
      kind: 'fact',
      content: 'c',
      importance: 5,
      tags: [],
      source: { sessionId: 's', eventSeqs: [1], excerpt: 'e' },
      dedupKey: 'k',
      createdAt: 't',
      updatedAt: 't',
      lastAccessAt: 't',
      accessCount: 0,
      status: 'active',
      audit: [],
    }
    // 未设置时不存在
    expect(entry.supersededBy).toBeUndefined()
    // 设置后存在（编译期验证类型）
    const superseded: MemoryEntry = { ...entry, supersededBy: 'other-id', supersedes: 'old-id' }
    expect(superseded.supersededBy).toBe('other-id')
    expect(superseded.supersedes).toBe('old-id')
  })
})
