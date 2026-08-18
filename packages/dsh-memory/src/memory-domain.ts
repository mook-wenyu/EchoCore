/**
 * @module @echocore/dsh-memory/memory-domain
 *
 * 记忆条目 schema（迁移校验与字段形态防线共用）。
 *
 * 存储形态（2026-08-15 结构性改造，用户拍板）：
 * 自建 SQLite 存储（SqliteKvTable，node:sqlite）替代 storage-domain +
 * storage-json 整文件原子写——写从 O(n) 重写降为 O(1) WAL 追加、检索可索引。
 * 领域声明（defineDomain/memoryDomainSpec）不再用于装配，已删除；
 * memoryEntrySchema 保留：① 首启迁移（memory.json → memory.sqlite）逐条校验；
 * ② 字段形态防线（isSourceWellFormed 之外的写入接口防线）。
 *
 * 记录 schema 使用 zod（领域层约定）；插件 Config 使用 schemastery（见 config.ts）。
 */

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
  // R3-4：重要度语义域 0..10（提取侧已 clamp；工具侧模型可传任意值——持久层是最后防线，越界拒绝入库）
  importance: z.number().min(0).max(10),
  // W2：self/user 相关性 0..10（可选——旧记录无此字段，向后兼容）
  selfRelevance: z.number().min(0).max(10).optional(),
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

/** entries 表名（SqliteKvTable 表名与旧领域表名一致，避免魔法字符串） */
export const MEMORY_TABLE = 'entries'
