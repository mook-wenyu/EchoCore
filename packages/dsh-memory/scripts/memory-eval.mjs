#!/usr/bin/env node
/**
 * A1 记忆库直接质量评测脚本（@echocore/dsh-memory）。
 *
 * 背景（MemProbe 观点）：端到端任务成功率不是记忆质量的好指标——无记忆基线的
 * 任务也常饱和（检索结果好坏被下游模型消化掩盖）。本脚本改为直接测记忆库本身的
 * 检索质量：注入命中率、结构化 recall@k、衰减覆盖率，外加库健康度统计，给出一份
 * 可量化、可对比的中文报告。
 *
 * 零外部依赖：仅用 node 内置模块（node:sqlite / fs/promises / path / os）+ 本包
 * lib（scoring.js 的 tokenize、sqlite-kv.js 的 SqliteKvTable、store.js 的
 * MemoryStore）。jieba 由 scoring.js 内部惰性加载（~10ms 一次性，cut 约 0.4ms/次）。
 *
 * 指标说明（对 active 条目）：
 * - recall@k：每条取出 content 的前 2 个非停用词 token 作查询 → 跑 MemoryStore.search
 *   → 该条目是否出现在 top-k（默认 k=8）中 → 命中率 = 命中条目数 / 抽样总数。
 *   这是"结构化 recall"：查询来自条目自身内容，衡量检索是否能把该条目找回来。
 * - 注入命中率（近似）：对每条查询，search 返回非空结果的比例——即"注入时大概率
 *   有记忆可注入"的检索覆盖率（检索覆盖率 → 注入命中率的代理）。
 * - 衰减覆盖率：active 条目中 lastAccessAt 落在过去 90 天内的比例。反映记忆库的
 *   时效活性（衰减 window 与 SALIENCE_FLOOR_ACTIVE_WINDOW_MS 对齐）。
 * - 库健康度：总条数 / active / archived / superseded 分布。
 *
 * 采样控制：active 条目 > SAMPLE (500) 时随机采样 500 条参与 recall/注入评测，
 * 防止耗时爆炸（jieba 0.4ms × 500 条 × 2 ≈ 可接受）。健康度与大库统计仍全量。
 *
 * 只读防护：评测在 SQLite 的 :memory: 副本上构造 SqliteKvTable + MemoryStore——
 * 绝不向生产库写回访问追踪（MemoryStore.search 会对命中条目回写 lastAccessAt/
 * accessCount；若直接对生产库构造，会污染真实记忆库的衰减/频率指标）。
 *
 * 用法：
 *   node scripts/memory-eval.mjs [记忆库路径] [k]
 *   - 记忆库路径：默认 ~/.dsh/storages/memory.sqlite
 *   - k：recall@k 的 k，默认 8
 *
 * 边界（显式错误，不静默）：
 * - 库文件不存在 → 提示"先迁移/重启"并退出码 1；
 * - k < 1 → 报错退出。
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 采样上限：active 条目 > 该值时随机采样参与 recall/注入评测（健康度仍全量）
const SAMPLE_SIZE = 500
/** 衰减窗口（天）：与 scoring SALIENCE_FLOOR_ACTIVE_WINDOW_MS 对齐（90 天） */
const DECAY_WINDOW_DAYS = 90
/** 默认记忆库路径：~/.dsh/storages/memory.sqlite */
const DEFAULT_DB = join(homedir(), '.dsh', 'storages', 'memory.sqlite')

/**
 * 轻量停用词集合（过滤查询 token，避免用"了/的/the"这类虚词做查询）。
 * 中文：常见虚词/代词；英文：常见功能词。仅用于挑选查询词，不影响评分本身。
 * 有意保守：宁可多保留实词，避免误删有检索价值的词。
 */
const STOPWORDS = new Set([
  // 中文虚词/代词/高频功能词
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '和', '与', '及', '或',
  '也', '都', '这', '那', '个', '中', '上', '下', '对', '被', '把', '就', '等', '而',
  '其', '之', '于', '为', '以', '但', '并', '又', '才', '么', '吗', '呢', '吧', '啊',
  '要', '会', '能', '去', '来', '做', '有', '没', '不', '很', '更', '最', '一些', '一个',
  // 英文高频功能词
  'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'for', 'of', 'is', 'are', 'was',
  'were', 'this', 'that', 'with', 'from', 'as', 'at', 'by', 'be', 'it', 'we', 'you',
  'i', 'your', 'their', 'its', 'about', 'into', 'over', 'after', 'before', 'can',
  'will', 'have', 'has', 'not', 'do', 'did', 'but', 'so', 'then', 'when', 'what',
])

/** 从 tokenize 结果中取前 2 个非停用词 token 作为查询词（不足则全部） */
function pickQueryTokens(tokens) {
  const picked = []
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue
    picked.push(token)
    if (picked.length === 2) break
  }
  return picked
}

/** 随机采样数组（Fisher–Yates 取前 n，避免改变原数组） */
function sample(items, n) {
  if (items.length <= n) return items
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

/** 计算百分数（保留 1 位小数） */
function pct(part, total) {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

async function main() {
  const dbPath = process.argv[2] ?? DEFAULT_DB
  const k = Number(process.argv[3] ?? 8)
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k 必须为正整数（收到 ${process.argv[3]}）`)
  }

  // 库文件缺失即退出码 1（显式错误）——files 表为 SQLite 版，若无则说明尚未迁移完成
  try {
    await access(dbPath)
  } catch {
    console.error(`记忆库不存在：${dbPath}`)
    console.error('未找到 SQLite 记忆库——请先迁移/重启插件（storage 已从 memory.json 迁到 memory.sqlite），再运行评测。')
    process.exitCode = 1
    return
  }

  // 1. 读取生产库 entries 表的 value 列（JSON.parse 还原条目对象）
  const source = new DatabaseSync(dbPath, { readOnly: true })
  const rows = source.prepare('SELECT id, value FROM "entries"').all()
  source.close()
  console.log(`记忆库：${dbPath}`)
  console.log(`SQLite 条目原始行数：${rows.length}`)
  console.log('')

  // 解析 + 按状态分类（容忍个别坏 JSON，跳过并计数；坏数据不影响整体评测）
  const entries = []
  let skipped = 0
  for (const row of rows) {
    try {
      const entry = JSON.parse(row.value)
      if (entry && entry.id && entry.content) entries.push(entry)
      else skipped++
    } catch {
      skipped++
    }
  }
  if (skipped > 0) console.log(`（跳过 ${skipped} 条不可解析/缺失正文的记录）`)

  const active = entries.filter((e) => e.status === 'active')
  const archived = entries.filter((e) => e.status === 'archived')
  const superseded = entries.filter((e) => e.supersededBy !== undefined)
  // 注意：superseded 条目 status 仍为 active（仅检索隐藏），故总/active/superseded 会重叠

  // -------------------- 库健康度 --------------------
  const now = Date.now()
  const decayCutoff = now - DECAY_WINDOW_DAYS * 86_400_000
  // 衰减覆盖：active 条目中 lastAccessAt 在 90 天内
  const activeRecent = active.filter((e) => Date.parse(e.lastAccessAt) >= decayCutoff)

  // -------------------- recall@k + 注入命中率（仅对抽样 active 条目） --------------------
  const { tokenize: tokenizeFn } = await import(new URL('../lib/scoring.js', import.meta.url))
  const { SqliteKvTable } = await import(new URL('../lib/sqlite-kv.js', import.meta.url))
  const { MemoryStore } = await import(new URL('../lib/store.js', import.meta.url))

  // 只读副本：把条目灌进 :memory: 的 SqliteKvTable + MemoryStore，跑真实 lib 检索路径。
  // put() 同步填充内存 cache（search 读 cache），无需等待写链；全程不触碰生产库。
  const memDb = new DatabaseSync(':memory:')
  const table = new SqliteKvTable(memDb)
  for (const entry of active) {
    table.put(entry.id, entry)
  }
  const store = new MemoryStore(table)

  // 决定样本：抽样 active 条目参与 recall/注入（健康度不受影响）
  const sampleEntries = sample(active, SAMPLE_SIZE)

  let hit = 0
  let nonEmpty = 0
  let noQuery = 0
  // 预留：记录被检索到的条目 id 以便报告"可检索比例"
  const retrievedIds = new Set()
  for (const entry of sampleEntries) {
    const queryTokens = pickQueryTokens(tokenizeFn(entry.content))
    if (queryTokens.length === 0) {
      noQuery++
      continue
    }
    const query = queryTokens.join(' ')
    let top
    try {
      top = store.search({ query, limit: k })
    } catch (error) {
      // 检索异常不应使整体评测崩溃——记录并跳过该条
      console.warn(`[memory-eval] 条目 ${entry.id} 检索异常：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (top.length > 0) nonEmpty++
    for (const item of top) retrievedIds.add(item.id)
    if (top.some((item) => item.id === entry.id)) hit++
  }
  const judged = sampleEntries.length - noQuery

  // -------------------- 中文报告 --------------------
  console.log('========== A1 记忆库直接质量评测 ==========')
  console.log('')
  console.log(`【库健康度】`)
  console.log(`  库路径          ：${dbPath}`)
  console.log(`  总条目数        ：${entries.length}`)
  console.log(`  active          ：${active.length}`)
  console.log(`  archived        ：${archived.length}`)
  console.log(`  superseded      ：${superseded.length}（被覆盖，检索默认隐藏）`)
  console.log('')
  console.log(`【recall@${k}】（对 ${judged}/${sampleEntries.length} 条可建查询的 active 样本；库 >500 条时采样 ${SAMPLE_SIZE} 条）`)
  console.log(`  命中条目数      ：${hit}`)
  console.log(`  recall@${k}      ：${pct(hit, judged)}`)
  console.log(`  结论：检索能把 ${pct(hit, judged)} 的抽样条目在 top-${k} 内找回来。${judged > 0 && hit / judged >= 0.8 ? '覆盖良好。' : '偏低——需排查查询词/评分/门槛配置。'}`)
  console.log('')
  console.log('【注入命中率（近似=检索覆盖率）】')
  console.log(`  非空结果查询    ：${nonEmpty}/${judged}`)
  console.log(`  注入命中率(近似) ：${pct(nonEmpty, judged)}`)
  console.log(`  结论：${pct(nonEmpty, judged)} 的查询能取回记忆用于注入。${judged > 0 && nonEmpty / judged >= 0.8 ? '检索覆盖良好，注入大概率非空。' : '偏低——多数查询无记忆可注入，可能抑制注入效果。'}`)
  console.log('')
  console.log('【衰减覆盖率】（active 条目，lastAccessAt 过去 90 天内）')
  console.log(`  活跃条目        ：${activeRecent.length}/${active.length}`)
  console.log(`  衰减覆盖率      ：${pct(activeRecent.length, active.length)}`)
  console.log(`  结论：${active.length > 0 && activeRecent.length / active.length >= 0.5 ? '库内半数以上记忆在活跃窗口内，时效性尚可。' : '过半记忆久未访问——检索前排可能被旧记忆占据或注入稀疏。'}`)
  console.log('')
  console.log(`【检索到的去重条目】${retrievedIds.size}/${judged}（样本查询命中的不同条目数，反映检索覆盖面）`)
  console.log('==========================================')

  // MemoryStore.search 会对命中条目做异步访问追踪回写（入 :memory: 副本写链）。
  // 评测只是只读副本，回写无意义；这里显式等写链排空再关闭，避免中途 finalize
  // 语句导致 "statement has been finalized" 的噪音告警。
  await table.chain
  memDb.close()
}

main().catch((error) => {
  console.error(`评测失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
