/**
 * @module @echocore/dsh-memory
 *
 * 记忆领域类型定义：条目、来源、审计记录与生命周期。
 * 本文件只包含纯类型与创建辅助函数，不依赖任何运行时服务，
 * 保证可独立单测、可被存储/提取/注入各模块共享。
 */

/** 记忆条目分类（实现计划 D9：五类） */
export type MemoryKind = 'fact' | 'preference' | 'decision' | 'todo' | 'insight'

/** 记忆条目生命周期状态 */
export type MemoryStatus = 'active' | 'archived' | 'deleted'

/** 审计动作：记录记忆条目的每一次变更（访问仅计数值 lastAccessAt/accessCount，不入审计） */
export type AuditAction =
  | 'create' // 新建
  | 'update' // 内容/属性更新
  | 'merge' // 与既有条目合并（去重）
  | 'archive' // 归档（软删除）
  | 'restore' // 恢复
  | 'delete' // 物理删除
  | 'inject' // 注入进模型上下文

/** 审计主体：谁发起了这次变更 */
export type AuditActor = 'extractor' | 'tool' | 'user' | 'system'

/** 单条审计记录（追加式，不可变） */
export interface AuditRecord {
  /** 动作类型 */
  action: AuditAction
  /** ISO 时间戳 */
  at: string
  /** 发起主体 */
  by: AuditActor
  /** 补充说明（如合并来源 id、注入的步骤号） */
  detail?: string
}

/**
 * 记忆来源锚点：支撑"你为何记得这个？依据是哪段原始对话？"的可解释性追问。
 * - sessionId + eventSeqs：指向来源会话日志中的原始事件（会话日志仅追加，压缩只遮蔽不删除，可还原）
 * - excerpt：来源原文摘录（≤ 400 字符），审计时无需读取历史日志即可展示依据
 */
export interface MemorySource {
  /** 来源会话 id */
  sessionId: string
  /** 来源事件序号（会话日志内，升序） */
  eventSeqs: number[]
  /** 来源原文摘录 */
  excerpt: string
}

/** 持久化记忆条目（storageDomain 领域记录） */
export interface MemoryEntry {
  /** 记忆 id（uuid） */
  id: string
  /** 规范化 workspace 键（realpath 后的 cwd；跨会话聚合维度） */
  workspace: string
  /** 来源会话 id */
  sessionId: string
  /** 分类 */
  kind: MemoryKind
  /** 记忆正文 */
  content: string
  /** 重要性 0-10（提取器 LLM 自评；手动写入默认 5） */
  importance: number
  /** 标签 */
  tags: string[]
  /** 来源锚点 */
  source: MemorySource
  /** 内容规范化哈希（去重合并键） */
  dedupKey: string
  /** 创建时间（ISO） */
  createdAt: string
  /** 最后更新时间（ISO） */
  updatedAt: string
  /** 最后访问时间（ISO，时间衰减用） */
  lastAccessAt: string
  /** 访问次数（检索/注入命中累计） */
  accessCount: number
  /** 生命周期状态 */
  status: MemoryStatus
  /** 审计日志（追加） */
  audit: AuditRecord[]
}

/** 新建条目入参（id/时间戳/审计由工厂生成） */
export interface NewMemoryInput {
  workspace: string
  sessionId: string
  kind: MemoryKind
  content: string
  importance?: number
  tags?: string[]
  source: MemorySource
  by: AuditActor
}

/** 提取器输出的原始记忆（LLM 结构化输出的中间形态） */
export interface ExtractedMemory {
  kind: MemoryKind
  content: string
  importance?: number
  tags?: string[]
}

/** 记忆统计快照 */
export interface MemoryStats {
  total: number
  active: number
  archived: number
  deleted: number
  byKind: Record<MemoryKind, number>
}

/**
 * 规范化内容文本用于去重键：小写、去首尾空白、压缩连续空白。
 * 提取器与手动写入共用同一规范化，保证同义内容可合并。
 */
export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * FNV-1a 32 位哈希（确定性、无依赖）。
 * 用于生成 dedupKey；碰撞概率对数百条量级可忽略。
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 生成记忆条目的去重键 */
export function dedupKeyOf(content: string): string {
  return fnv1a(normalizeContent(content))
}

/** 记忆 id 生成（host 环境有 node:crypto） */
export function newMemoryId(): string {
  return crypto.randomUUID()
}
