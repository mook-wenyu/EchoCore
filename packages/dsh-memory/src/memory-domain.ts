/**
 * @module @echocore/dsh-memory/memory-domain
 *
 * 记忆持久化领域声明（storageDomain 数据形式）。
 * 领域名 = 后端单元名：宿主 storage-json root 为 ~/.dsh/storages 时，
 * 数据落盘为 ~/.dsh/storages/memory.json（单位文件，人类可读）。
 * 记录 schema 使用 zod（领域层约定）；插件 Config 使用 schemastery（见 config.ts）。
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import { AUDIT_ACTIONS, AUDIT_ACTORS, MEMORY_KINDS, MEMORY_STATUSES, type MemoryEntry } from './types.js'

/** 审计记录 schema（动作/主体枚举从 types.ts 单源派生，防止双写漂移） */
export const auditRecordSchema = z.object({
  action: z.enum(AUDIT_ACTIONS),
  at: z.string(),
  by: z.enum(AUDIT_ACTORS),
  detail: z.string().optional(),
})

/** 来源锚点 schema */
export const memorySourceSchema = z.object({
  sessionId: z.string(),
  eventSeqs: z.array(z.number()),
  excerpt: z.string(),
})

/** 记忆条目 schema（持久记录的全部字段；supersededBy/supersedes 为可选，向后兼容既有记录） */
export const memoryEntrySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  sessionId: z.string(),
  kind: z.enum(MEMORY_KINDS),
  content: z.string(),
  importance: z.number(),
  tags: z.array(z.string()),
  source: memorySourceSchema,
  dedupKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAccessAt: z.string(),
  accessCount: z.number(),
  status: z.enum(MEMORY_STATUSES),
  supersededBy: z.string().optional(),
  supersedes: z.string().optional(),
  audit: z.array(auditRecordSchema),
})

/**
 * memory 领域：单表 entries（键 = 记忆 id）。
 * version 1：预发布阶段不承诺迁移；升级时整体重写文件（见 AGENTS.md 向后兼容立场）。
 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  tables: {
    entries: domainTable<string, MemoryEntry>(memoryEntrySchema),
  },
})

/** entries 表名（供 store 与装配处引用，避免魔法字符串） */
export const MEMORY_TABLE = 'entries'
