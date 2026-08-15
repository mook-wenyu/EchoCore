/**
 * @module @echocore/dsh-memory/tools
 *
 * 记忆模型工具集（六件）：recall / search / note / forget / audit / status。
 * 全部经 ctx.tools.register(defineTool(...)) 注册，schema 自动流入提示词组装。
 *
 * 输出契约（DSH 规范输出）：execute 返回规范 JSON 值，render 为纯函数
 * 渲染文本；规范值可被审计与回放，渲染只负责模型/UI 呈现。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { DEFAULT_WORKSPACE, EXCERPT_MAX_CHARS } from './constants.js'
import { formatMemoryLine } from './render.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry, MemoryKind } from './types.js'

/** 工具集依赖 */
export interface MemoryToolsDeps {
  store: MemoryStore
}

/** 记忆条目的最小规范形态（工具输出与 RPC 共用） */
export interface MemorySummary {
  id: string
  kind: MemoryKind
  content: string
  importance: number
  tags: string[]
  sessionId: string
  status: string
  createdAt: string
  updatedAt: string
}

/** 记忆详情的规范形态（audit 输出） */
export interface MemoryDetail extends MemorySummary {
  workspace: string
  source: { sessionId: string; eventSeqs: number[]; excerpt: string }
  accessCount: number
  audit: Array<{ action: string; at: string; by: string; detail?: string }>
  /** 被哪条记忆覆盖（supersede 链后向引用；无则缺席） */
  supersededBy?: string
  /** 覆盖了哪条旧记忆（supersede 链前向引用；无则缺席） */
  supersedes?: string
}

/** 把条目投影为最小规范形态（不泄漏内部结构） */
export function toSummary(entry: MemoryEntry): MemorySummary {
  return {
    id: entry.id,
    kind: entry.kind,
    content: entry.content,
    importance: entry.importance,
    tags: entry.tags,
    sessionId: entry.sessionId,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

/** 把条目投影为详情规范形态（audit 用）；supersede 链字段仅在存在时投射 */
export function toDetail(entry: MemoryEntry): MemoryDetail {
  return {
    ...toSummary(entry),
    workspace: entry.workspace,
    source: { ...entry.source },
    accessCount: entry.accessCount,
    audit: entry.audit.map((record) => ({ ...record })),
    ...(entry.supersededBy !== undefined ? { supersededBy: entry.supersededBy } : {}),
    ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
  }
}

/** 解析执行上下文中的 workspace（agent 缺省时回退默认键——"无项目"是合法业务语义，落入全局池） */
export function workspaceOf(exec: { agent?: Agent }): string {
  return exec.agent?.session.header.cwd ?? DEFAULT_WORKSPACE
}

/**
 * 解析执行上下文中的 sessionId。
 * R2-5（B5）：DSH 契约下工具执行必有 agent（模型调用均发生在 agent 循环内；
 * 无 agent 的原生直调在策略管道前被拒，见 dsh-tools ToolRunContext.agent 注释）。
 * 缺失即抛错暴露契约违例——禁止用 workspace 键伪造 sessionId 写入来源数据（污染跨会话溯源）。
 */
export function sessionIdOf(exec: { agent?: Agent }): string {
  if (exec.agent === undefined) {
    throw new Error('工具执行缺少 agent 上下文：无法确定来源会话')
  }
  return exec.agent.id
}

/** 注册全部记忆工具；返回各注册的 disposer 集合（随插件 fiber 自动清理） */
export function registerMemoryTools(ctx: Context, deps: MemoryToolsDeps): void {
  registerRecall(ctx, deps)
  registerSearch(ctx, deps)
  registerNote(ctx, deps)
  registerForget(ctx, deps)
  registerAudit(ctx, deps)
  registerStatus(ctx, deps)
}

/** memory_recall：按查询检索 Top-K 相关记忆（显式召回路径） */
function registerRecall(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_recall',
      description:
        '按当前任务需求从记忆库检索最相关的记忆（事实/偏好/决策/待办/洞察）。' +
        '用于需要历史背景时主动召回；返回条目带记忆 id 与来源会话，可进一步用 memory_audit 溯源。',
      parameters: {
        query: { type: 'string', required: true, description: '当前需要背景支撑的查询描述' },
        limit: { type: 'integer', description: '返回条数上限（默认 8）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            memories: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  content: { type: 'string', required: true },
                  importance: { type: 'number', required: true },
                  sessionId: { type: 'string', required: true },
                  eventSeqs: { type: 'array', required: true, items: { type: 'integer' } },
                },
                additionalProperties: false,
              },
            },
            total: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          // R2-7（B7）：渲染单源——直接走 render.formatMemoryLine（memory 形状即 MemoryLineView）
          const lines = value.memories.map((memory) => formatMemoryLine(memory))
          const header =
            value.total === 0
              ? '记忆库中未找到相关记忆。'
              : `找到 ${value.total} 条相关记忆（可追问依据：memory_audit <id>）：`
          return [{ type: 'text', text: [header, ...lines].join('\n') }]
        },
      },
      async execute(args, exec) {
        const results = deps.store.search({
          query: args.query,
          workspace: workspaceOf(exec),
          limit: args.limit ?? 8,
        })
        return {
          memories: results.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            content: entry.content,
            importance: entry.importance,
            sessionId: entry.source.sessionId,
            eventSeqs: entry.source.eventSeqs,
          })),
          total: results.length,
        }
      },
    }),
  )
}

/** memory_search：结构化检索（分类/标签/状态过滤 + 关键词） */
function registerSearch(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        '结构化检索记忆库：可按分类、标签、状态过滤，可选关键词评分排序；' +
        '无关键词时按创建时间倒序浏览。用于盘点记忆库内容。',
      parameters: {
        query: { type: 'string', description: '关键词（可省略）' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'todo', 'insight'],
          description: '分类过滤',
        },
        tag: { type: 'string', description: '标签过滤' },
        status: { type: 'string', enum: ['active', 'archived'], description: '状态过滤（默认 active）' },
        limit: { type: 'integer', description: '返回条数上限（默认 20）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            memories: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  content: { type: 'string', required: true },
                  importance: { type: 'number', required: true },
                  tags: { type: 'array', required: true, items: { type: 'string' } },
                  sessionId: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  createdAt: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
            },
            total: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          // R2-7（B7）：渲染单源——toSummary 形状即 MemoryLineView（含 sessionId）
          const lines = value.memories.map((memory) => formatMemoryLine(memory))
          return [{ type: 'text', text: `共 ${value.total} 条：\n${lines.join('\n')}` }]
        },
      },
      async execute(args, exec) {
        const results = deps.store.search({
          query: args.query ?? '',
          workspace: workspaceOf(exec),
          kind: args.kind,
          tag: args.tag,
          status: args.status,
          limit: args.limit ?? 20,
        })
        return {
          memories: results.map(toSummary),
          total: results.length,
        }
      },
    }),
  )
}

/** memory_note：手动写入一条记忆（用户/模型主动记录） */
function registerNote(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_note',
      description:
        '主动记录一条值得长期记住的信息（事实/偏好/决策/待办/洞察）。' +
        '仅在用户明确要求记住、或信息明显具有长期价值时使用；' +
        '相同内容会自动与既有记忆合并（记忆 id 保持不变）。',
      parameters: {
        content: { type: 'string', required: true, description: '记忆内容（规范、自足的表述）' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'todo', 'insight'],
          description: '分类（默认 fact）',
        },
        importance: { type: 'integer', description: '重要度 0-10（默认 5）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', required: true },
            merged: { type: 'boolean', required: true },
            // R2-6（B6）：mergedWithId 仅在 merged=true 时有值（可选标注，V9 查证）；
            // 禁止用空串伪造 required 假值
            mergedWithId: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.merged
              ? `内容与既有记忆 #${value.mergedWithId?.slice(0, 8)} 合并，未新增条目。`
              : `已记录记忆 #${value.id.slice(0, 8)}（可用 memory_audit ${value.id} 溯源）。`,
          },
        ],
      },
      async execute(args, exec) {
        const result = await deps.store.create({
          workspace: workspaceOf(exec),
          sessionId: sessionIdOf(exec),
          kind: args.kind ?? 'fact',
          content: args.content,
          importance: args.importance ?? 5,
          tags: args.tags,
          source: {
            sessionId: sessionIdOf(exec),
            eventSeqs: [],
            excerpt: args.content.slice(0, EXCERPT_MAX_CHARS),
          },
          by: 'tool',
        })
        return {
          id: result.entry.id,
          merged: result.outcome.merged,
          mergedWithId: result.outcome.merged ? result.outcome.existingId : undefined,
        }
      },
    }),
  )
}

/** memory_forget：归档一条记忆（软删除，审计保留） */
function registerForget(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_forget',
      description:
        '归档一条记忆：从检索与自动注入中消失，审计与来源记录保留（可用 memory_audit 查看历史）。' +
        '用户明确要求忘记时才使用。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id（来自 memory_recall/search/audit）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', required: true },
            archived: { type: 'boolean', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.archived ? `记忆 #${value.id.slice(0, 8)} 已归档。` : `未找到记忆 ${value.id}。` },
        ],
      },
      async execute(args) {
        const archived = await deps.store.archive(args.id, 'tool')
        return { id: args.id, archived }
      },
    }),
  )
}

/** memory_audit：完整溯源（内容/来源/原文摘录/审计日志），回答"为何记得" */
function registerAudit(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_audit',
      description:
        '查看一条记忆的完整溯源：内容、分类、重要度、来源会话与事件序号、原文摘录、审计日志。' +
        '用于回答"你为何记得这个？依据是哪段原始对话？"。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean', required: true },
            entry: {
              // 未找到时缺失（found=false）；渲染层已对 undefined 分支处理
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                content: { type: 'string', required: true },
                importance: { type: 'number', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                workspace: { type: 'string', required: true },
                source: {
                  type: 'object',
                  required: true,
                  properties: {
                    sessionId: { type: 'string', required: true },
                    eventSeqs: { type: 'array', required: true, items: { type: 'integer' } },
                    excerpt: { type: 'string', required: true },
                  },
                  additionalProperties: false,
                },
                accessCount: { type: 'integer', required: true },
                status: { type: 'string', required: true },
                supersededBy: { type: 'string', description: '被哪条记忆覆盖（supersede 链后向引用）' },
                supersedes: { type: 'string', description: '覆盖了哪条旧记忆（supersede 链前向引用）' },
                audit: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string', required: true },
                      at: { type: 'string', required: true },
                      by: { type: 'string', required: true },
                      detail: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          if (!value.found || value.entry === undefined) {
            return [{ type: 'text', text: `未找到记忆 ${value.entry?.id ?? ''}。` }]
          }
          const entry = value.entry
          const supersedeLine =
            entry.supersededBy != null || entry.supersedes != null
              ? `supersede 链：${entry.supersedes != null ? `覆盖了 #${entry.supersedes.slice(0, 8)}` : ''}${entry.supersededBy != null && entry.supersedes != null ? '；' : ''}${entry.supersededBy != null ? `被 #${entry.supersededBy.slice(0, 8)} 覆盖` : ''}`
              : ''
          const lines = [
            `记忆 #${entry.id.slice(0, 8)}（${entry.kind}，重要度 ${entry.importance}，状态 ${entry.status}）`,
            `内容：${entry.content}`,
            `来源会话：${entry.source.sessionId}`,
            `来源事件序号：${entry.source.eventSeqs.join(', ') || '（手动记录，无事件锚点）'}`,
            `原文摘录：${entry.source.excerpt.slice(0, 200)}${entry.source.excerpt.length > 200 ? '…' : ''}`,
            `访问次数：${entry.accessCount}`,
            ...(supersedeLine !== '' ? [supersedeLine] : []),
            `审计日志：`,
            ...entry.audit.map((record) => `  - ${record.at} [${record.by}] ${record.action}${record.detail ? `：${record.detail}` : ''}`),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const entry = deps.store.getById(args.id)
        if (entry === undefined) return { found: false, entry: undefined }
        return { found: true, entry: toDetail(entry) }
      },
    }),
  )
}

/** memory_status：记忆库统计与状态概览 */
function registerStatus(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_status',
      description: '查看记忆库统计：各分类/状态计数。用于了解当前记忆规模。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer', required: true },
            active: { type: 'integer', required: true },
            archived: { type: 'integer', required: true },
            byKind: {
              type: 'object',
              required: true,
              properties: {
                fact: { type: 'integer', required: true },
                preference: { type: 'integer', required: true },
                decision: { type: 'integer', required: true },
                todo: { type: 'integer', required: true },
                insight: { type: 'integer', required: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `记忆库统计：共 ${value.total} 条（active ${value.active} / archived ${value.archived}）`,
              `fact ${value.byKind.fact} · preference ${value.byKind.preference} · decision ${value.byKind.decision} · todo ${value.byKind.todo} · insight ${value.byKind.insight}`,
            ].join('\n'),
          },
        ],
      },
      execute: async () => {
        const stats = deps.store.stats()
        return {
          total: stats.total,
          active: stats.active,
          archived: stats.archived,
          byKind: stats.byKind,
        }
      },
    }),
  )
}
