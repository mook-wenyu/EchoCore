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
import type { JsonValue } from '@deepseek-ai/dsh-session'

import type { MemoryCausalStore } from './causal.js'
import { DEFAULT_WORKSPACE, EXCERPT_MAX_CHARS } from './constants.js'
import { resolveRoute } from './extract.js'
import { searchWithSemantic, type EmbeddingHolder } from './embedding.js'
import type { CausalSummary } from './causal.js'
import { formatMemoryLine } from './render.js'
import type { ReflectionSummary } from './reflect.js'
import type { MemoryStableSnapshot } from './stable-snapshot.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry, MemoryKind } from './types.js'

/** 工具集依赖 */
export interface MemoryToolsDeps {
  store: MemoryStore
  /**
   * 稳定快照（G3 去重回路）：工具显式召回/检索时，排除当前 workspace 快照
   * 已含的记忆 id——快照已由 systemPrompt 段前缀注入，工具只补快照未含的，
   * 防同一记忆被「快照段 + 实时注入包 + 工具输出」三处重复消化（上下文腐化）。
   */
  snapshot: MemoryStableSnapshot
  /** P4 语义嵌入持有者（可选；调用时读 service/index——热换后即生效，无需重启） */
  embedding?: EmbeddingHolder
  /** 语义降级/嵌入故障记录（可选；装配层注入 logger） */
  logger?: Pick<ReturnType<Context['logger']>, 'warn'>
  /** O1 运行健康指标（装配层组装；测试环境不传 → 占位） */
  runtime?: RuntimeHealth
  /** 因果边表（可选：memory_audit 渲染因果视图用；未接线不显示因果链） */
  causal?: MemoryCausalStore
  /** 反思器（可选：memory_reflect 手动触发用；未接线时工具仍注册并诚实返回未执行） */
  reflector?: {
    runOnce(route: { provider: string; model: string } | undefined, opts?: { force?: boolean }): Promise<ReflectionSummary | undefined>
  }
}

/** O1：运行健康指标（写链失败/嵌入状态/维护时间——"写失败一眼可见"闭环） */
export interface RuntimeHealth {
  writeFailures: number
  embeddingState: string
  lastMaintenanceAt: string | null
  /** 当前嵌入后端标签（'remote' | 'local'；未就绪缺席）——面板展示真实后端（2026-08-17 状态可见化） */
  embeddingBackend?: string
  /** 最近一次初始化期远程验证失败原因（远程未生效时展示，杜绝静默回退） */
  embeddingInitError?: string
  /** Q1/A：运行期跨维降级原因（语义已降级为关键词时展示——状态可见化，非静默） */
  embeddingDegradedReason?: string
  /** 反思观测：最近一次成功执行的观察量（审/决/合并/归档/跳过；未运行 null） */
  reflection?: ReflectionSummary | null
  /** 反思最近一次成功执行时刻（ISO；未运行 null） */
  lastReflectionAt?: string | null
  /** 因果抽取观测：最近一次成功批次（审/提边/建成/跳过；未运行 null） */
  causal?: CausalSummary | null
  /** 因果抽取最近一次成功批次时刻（ISO；未运行 null） */
  lastCausalAt?: string | null
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

/** 注册全部记忆工具（七件：+ memory_reflect）；返回各注册的 disposer 集合（随插件 fiber 自动清理） */
export function registerMemoryTools(ctx: Context, deps: MemoryToolsDeps): void {
  registerRecall(ctx, deps)
  registerSearch(ctx, deps)
  registerNote(ctx, deps)
  registerForget(ctx, deps)
  registerAudit(ctx, deps)
  registerStatus(ctx, deps)
  registerReflect(ctx, deps)
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
                  // G3/R2-6：投影补充创建时间（与注入包渲染一致，模型可判新旧）
                  createdAt: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
            },
            // G3：语义修正——`total` 实为返回条数（≤limit 且经快照去重），
            // 改为诚实命名 `returned`（"返回条数"）。真实匹配总数正确统计
            // 需 store 层新增计数方法（越出本次文件边界，store.ts 不受触碰），
            // 故选改名——改动最小且模型不再把子集误当全量命中数。
            returned: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          // R2-7（B7）：渲染单源——直接走 render.formatMemoryLine（memory 形状即 MemoryLineView）
          const lines = value.memories.map((memory) => formatMemoryLine(memory))
          const header =
            value.returned === 0
              ? '记忆库中未找到相关记忆。'
              : `找到 ${value.returned} 条相关记忆（可追问依据：memory_audit <id>）：`
          return [{ type: 'text', text: [header, ...lines].join('\n') }]
        },
      },
      async execute(args, exec) {
        // P4：语义增强检索（未启用时纯关键词，行为与之前一致）
        const results = (await searchWithSemantic(
          deps.store,
          deps.embedding?.service,
          deps.embedding?.index,
          args.query,
          { workspace: workspaceOf(exec), limit: args.limit ?? 8 },
          (message) => deps.logger?.warn(message),
        )) as MemoryEntry[]
        // G3 去重：快照已含同一记忆（system 前缀段已注入）→ 工具不再重复输出。
        // 快照优先语义：显式查询与快照/注入重复时，快照负责呈现，工具只补缺失。
        const workspace = workspaceOf(exec)
        const snapshotIds = deps.snapshot.snapshotIds(workspace)
        const deduped = results.filter((entry) => !snapshotIds.has(entry.id))
        return {
          memories: deduped.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            content: entry.content,
            importance: entry.importance,
            sessionId: entry.source.sessionId,
            eventSeqs: entry.source.eventSeqs,
            createdAt: entry.createdAt,
          })),
          returned: deduped.length,
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
                  updatedAt: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
            },
            // G3：同 recall——`total` 语义修正为诚实命名 `returned`（返回条数），
            // 模型不再把 limit/去重后的子集误当全量命中数。
            returned: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          // R2-7（B7）：渲染单源——toSummary 形状即 MemoryLineView（含 sessionId）
          const lines = value.memories.map((memory) => formatMemoryLine(memory))
          return [{ type: 'text', text: `共 ${value.returned} 条：\n${lines.join('\n')}` }]
        },
      },
      async execute(args, exec) {
        const workspace = workspaceOf(exec)
        // G3 去重：快照优先——排除快照已含记忆，工具只补快照未含的（防三处重复消化）
        const snapshotIds = deps.snapshot.snapshotIds(workspace)
        // P4：语义增强检索（未启用时纯关键词；查询为空走浏览路径不嵌入）
        let results: MemoryEntry[]
        if (args.query === undefined || args.query.trim() === '') {
          results = deps.store.search({
            query: '',
            workspace,
            kind: args.kind,
            tag: args.tag,
            status: args.status,
            limit: args.limit ?? 20,
          })
        } else {
          results = (await searchWithSemantic(
            deps.store,
            deps.embedding?.service,
            deps.embedding?.index,
            args.query,
            {
              workspace,
              kind: args.kind,
              tag: args.tag,
              status: args.status,
              limit: args.limit ?? 20,
            },
            (message) => deps.logger?.warn(message),
          )) as MemoryEntry[]
        }
        const deduped = results.filter((entry) => !snapshotIds.has(entry.id))
        return {
          memories: deduped.map(toSummary),
          returned: deduped.length,
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
                sessionId: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
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
            // 因果链视图（可选：未接线因果边表或无边时不返回）——保守利用：v1 仅审计展示，
            // 不做检索沿链扩散（"仅因果方向扩散更优"无直接论文证明，见设计说明）
            causal: {
              type: 'object',
              properties: {
                causedBy: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', required: true, description: '短记忆 id（前 8 位）' },
                      confidence: { type: 'number', required: true, description: '边置信 0-1' },
                    },
                    additionalProperties: false,
                  },
                },
                causeOf: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', required: true, description: '短记忆 id（前 8 位）' },
                      confidence: { type: 'number', required: true, description: '边置信 0-1' },
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
          // 因果链视图（v1 保守：仅审计展示，供模型做多跳排查/反事实）
          const causal = value.causal
          const causalLines =
            causal === undefined
              ? []
              : [
                  ...(causal.causedBy.length > 0
                    ? [`因果（被谁影响/支撑）：${causal.causedBy.map((c) => `#${c.id}（置信 ${c.confidence}）`).join('、')}`]
                    : []),
                  ...(causal.causeOf.length > 0
                    ? [`因果（影响/支撑谁）：${causal.causeOf.map((c) => `#${c.id}（置信 ${c.confidence}）`).join('、')}`]
                    : []),
                ]
          const lines = [
            `记忆 #${entry.id.slice(0, 8)}（${entry.kind}，重要度 ${entry.importance}，状态 ${entry.status}）`,
            `内容：${entry.content}`,
            `来源会话：${entry.source.sessionId}`,
            `来源事件序号：${entry.source.eventSeqs.join(', ') || '（手动记录，无事件锚点）'}`,
            `原文摘录：${entry.source.excerpt.slice(0, 200)}${entry.source.excerpt.length > 200 ? '…' : ''}`,
            `访问次数：${entry.accessCount}`,
            ...(supersedeLine !== '' ? [supersedeLine] : []),
            ...causalLines,
            `审计日志：`,
            ...entry.audit.map((record) => `  - ${record.at} [${record.by}] ${record.action}${record.detail ? `：${record.detail}` : ''}`),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const entry = deps.store.getById(args.id)
        if (entry === undefined) return { found: false, entry: undefined }
        const detail = toDetail(entry)
        if (deps.causal === undefined) return { found: true, entry: detail }
        // 因果装订：out（本条→target）= 本条支撑/导致谁；in（source→本条）= 谁影响/支撑本条
        const { out, in: inEdges } = deps.causal.edgesOf(entry.id)
        return {
          found: true,
          entry: detail,
          causal: {
            causedBy: inEdges.map((edge) => ({ id: edge.sourceId.slice(0, 8), confidence: edge.confidence })),
            causeOf: out.map((edge) => ({ id: edge.targetId.slice(0, 8), confidence: edge.confidence })),
          },
        }
      },
    }),
  )
}

/**
 * memory_reflect：手动触发一轮 LLM 反思（自进化）。
 * 与维护周期共用同一 MemoryReflector（force 跳过周期门控即时执行）；只做可逆的
 * "归档一侧"动作，审计 by:'system' 可回滚。未接线/无路由 → 诚实返回 ran:false。
 */
function registerReflect(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_reflect',
      description:
        '立即执行一轮记忆反思（LLM 自进化）：审视已有记忆条目间的语义近似重复与跨条目矛盾，' +
        '只执行可逆的"归档一侧"动作（归档较旧、保留较新，审计可回滚）。' +
        '适用于手动触发/验证反思效果；平时由维护周期自动运行。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            ran: { type: 'boolean', required: true },
            reviewed: { type: 'integer', required: true },
            decisions: { type: 'integer', required: true },
            merged: { type: 'integer', required: true },
            archived: { type: 'integer', required: true },
            skipped: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ran
              ? `反思完成：审定 ${value.reviewed} 条焦点 · 提议 ${value.decisions} 个动作 · 合并 ${value.merged} · 矛盾归档 ${value.archived} · 跳过/拒绝 ${value.skipped}（审计 by:system，可回滚）`
              : '反思未执行：当前无可用模型路由，或反思器未接线。',
          },
        ],
      },
      async execute(_args, exec) {
        if (deps.reflector === undefined) {
          return { ran: false, reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }
        }
        // 路由：优先从当前执行会话解析；无 agent 则传给反思器回退其缓存路由（仅 RPC 面板场景）
        const route = exec.agent === undefined ? undefined : resolveRoute(exec.agent.session, exec.agent)
        const summary = await deps.reflector.runOnce(route, { force: true })
        if (summary === undefined) {
          return { ran: false, reviewed: 0, decisions: 0, merged: 0, archived: 0, skipped: 0 }
        }
        return {
          ran: true,
          reviewed: summary.reviewed,
          decisions: summary.decisions,
          merged: summary.merged,
          archived: summary.archived,
          skipped: summary.skipped,
        }
      },
    }),
  )
}

/** memory_status：记忆库统计与状态概览 */
function registerStatus(ctx: Context, deps: MemoryToolsDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_status',
      description: '查看记忆库统计与运行健康：各分类/状态计数、写链失败次数、嵌入后端状态、上次维护时间。',
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
            writeFailures: { type: 'integer', required: true },
            embeddingState: { type: 'string', required: true },
            // O1：string|null 形态——ValueSchemaSpec 无联合 type，用 'json' 声明
            lastMaintenanceAt: { type: 'json', required: true },
            rejectedCount: { type: 'integer', required: true },
            // 自进化/因果链观测（null = 未运行/未接线；'json' 承载对象或 null）
            reflection: { type: 'json', required: true },
            lastReflectionAt: { type: 'json', required: true },
            causal: { type: 'json', required: true },
            lastCausalAt: { type: 'json', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `记忆库统计：共 ${value.total} 条（active ${value.active} / archived ${value.archived}）`,
              `fact ${value.byKind.fact} · preference ${value.byKind.preference} · decision ${value.byKind.decision} · todo ${value.byKind.todo} · insight ${value.byKind.insight}`,
              `运行健康：写失败 ${value.writeFailures} 次 · 嵌入 ${value.embeddingState} · 上次维护 ${value.lastMaintenanceAt ?? '未运行'}`,
              `写端门：已拦截 ${value.rejectedCount} 条噪声（extractor 通道）`,
              // 自进化/因果观测（A′ 建议 5：度量"反思是否真正变好"的起点——先可观测，再谈优化；
              // schema 为 json 承载 null/对象，读取时经 unknown 收窄为行为形状）
              `反思自进化：上次 ${value.lastReflectionAt ?? '未运行'}${
                value.reflection ? `（审定 ${(value.reflection as unknown as ReflectionSummary).reviewed} · 合并 ${(value.reflection as unknown as ReflectionSummary).merged} · 矛盾归档 ${(value.reflection as unknown as ReflectionSummary).archived} · 跳过 ${(value.reflection as unknown as ReflectionSummary).skipped}）` : ''
              }`,
              `因果链：上次 ${value.lastCausalAt ?? '未运行'}${
                value.causal ? `（审 ${(value.causal as unknown as CausalSummary).reviewed} · 建边 ${(value.causal as unknown as CausalSummary).created} · 跳过 ${(value.causal as unknown as CausalSummary).skipped}）` : ''
              }`,
            ].join('\n'),
          },
        ],
      },
      execute: async () => {
        const stats = deps.store.stats()
        // O1：装配层 runtime 覆盖健康字段（测试/未装配 → 占位）
        const runtime = deps.runtime
        return {
          total: stats.total,
          active: stats.active,
          archived: stats.archived,
          byKind: stats.byKind,
          writeFailures: runtime?.writeFailures ?? stats.writeFailures,
          embeddingState: runtime?.embeddingState ?? stats.embeddingState,
          lastMaintenanceAt: runtime?.lastMaintenanceAt ?? stats.lastMaintenanceAt,
          // R2：P2 写端门拒绝计数（store 自身可观测，直读 stats）
          rejectedCount: stats.rejectedCount,
          // json 承载对象或 null（schema 为 'json'）；运行时对象即为 JsonValue（显式收窄）
          reflection: (runtime?.reflection ?? null) as JsonValue,
          lastReflectionAt: runtime?.lastReflectionAt ?? null,
          causal: (runtime?.causal ?? null) as JsonValue,
          lastCausalAt: runtime?.lastCausalAt ?? null,
        }
      },
    }),
  )
}
