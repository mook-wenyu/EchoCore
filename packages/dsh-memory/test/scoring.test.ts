/**
 * 评分模块单元测试：分词、相关性、时间衰减、重要性、综合分。
 * 全部为确定性纯函数断言。
 */

import { describe, expect, it } from 'vitest'

import {
  adaptiveHalfLifeDays,
  bm25Idf,
  effectiveImportance,
  idfWeightedRelevance,
  importanceFactor,
  MIN_RELEVANCE_SCORE,
  modulatedHalfLifeDays,
  recencyFactor,
  relevanceScore,
  rrfScore,
  SALIENCE_FLOOR_IMPORTANCE,
  SALIENCE_FLOOR_RECENCY,
  timeImportanceFactor,
  tokenize,
} from '../src/scoring.ts'
import { type MemoryEntry } from '../src/types.ts'

/** 条目 token 集合（content+tags，M4：与 store 检索同源） */
function tokensOf(entry: MemoryEntry): Set<string> {
  return new Set(tokenize(`${entry.content} ${entry.tags.join(' ')}`))
}

/** 构造一个最小记忆条目（测试辅助） */
function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'm1',
    workspace: 'D:/workspace',
    sessionId: 's1',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理多包',
    importance: 5,
    tags: [],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '…' },
    dedupKey: 'k1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAccessAt: '2026-01-01T00:00:00.000Z',
    accessCount: 0,
    status: 'active',
    audit: [],
    ...overrides,
  }
}

describe('tokenize', () => {
  it('切分英文单词并小写', () => {
    expect(tokenize('Use Pnpm Workspace')).toEqual(['use', 'pnpm', 'workspace'])
  })

  it('切分中文为二元组', () => {
    expect(tokenize('项目')).toEqual(['项目'])
    expect(tokenize('使用pnpm')).toEqual(['pnpm', '使用'])
  })

  it('混合中英文与数字', () => {
    const tokens = tokenize('vite 5.0 构建 echoCore')
    expect(tokens).toContain('vite')
    expect(tokens).toContain('5')
    expect(tokens).toContain('0')
    expect(tokens).toContain('构建')
  })

  it('空文本返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })

  it('J1 jieba 词边界：真实中文词入 token（并集语义，词+2-gram 兜底）', () => {
    const tokens = tokenize('记忆系统架构设计')
    // jieba 真实词边界（语义质量）
    expect(tokens).toContain('记忆系统')
    expect(tokens).toContain('架构设计')
    // 2-gram 兜底（任意 2 字子串召回保持——jieba 不切的组合也能命中）
    expect(tokens).toContain('忆系')
    expect(tokens).toContain('统架')
  })

  it('J1 并集召回：jieba 未切出的 2 字组合仍可检索（2-gram 兜底不丢失）', () => {
    // '项目偏好' jieba 切为 项目/偏好；'目偏' 由 2-gram 兜底
    const tokens = tokenize('项目偏好')
    expect(tokens).toContain('项目')
    expect(tokens).toContain('偏好')
    expect(tokens).toContain('目偏')
  })

  it('J1 输出去重：jieba 词与 2-gram 重叠不重复（Set 语义，分母不稀释）', () => {
    const tokens = tokenize('记忆系统')
    // '系统' 既是 jieba 词也是 2-gram——只出现一次
    const count = tokens.filter((t) => t === '系统').length
    expect(count).toBe(1)
  })
})

describe('relevanceScore', () => {
  it('完全命中得 1 分', () => {
    expect(relevanceScore(['pnpm'], new Set(['pnpm']))).toBe(1)
  })

  it('部分命中按比例得分', () => {
    expect(relevanceScore(['pnpm', 'vite'], new Set(['pnpm']))).toBe(0.5)
  })

  it('空查询得 0 分', () => {
    expect(relevanceScore([], new Set(['pnpm']))).toBe(0)
  })
})

// 轻量 IDF 加权（决策：含轻量 IDF——保留 0-1 标定的 BM25 化）。
// 检索时按候选集统计 df（零维护），使稀有词命中权重大于常见词，同命中数下可区分条目。
describe('idfWeightedRelevance（轻量 IDF 加权）', () => {
  it('全命中 = 1.0（0-1 上界保留——注入 0.7/0.4 三档语义不变）', () => {
    // N=3 候选，token 出现在全部候选（df=N，idf 趋小）仍全命中 = 1
    const df = { rareB: 1, common: 3, common2: 3 }
    expect(
      idfWeightedRelevance(['common', 'common2'], new Set(['common', 'common2']), (t) => df[t] ?? 0, 3),
    ).toBeCloseTo(1, 10)
    // 稀有词全命中同样 = 1
    expect(idfWeightedRelevance(['rareB'], new Set(['rareB']), (t) => df[t] ?? 0, 3)).toBeCloseTo(1, 10)
  })

  it('零命中 = 0', () => {
    expect(idfWeightedRelevance(['a', 'b'], new Set(['x', 'y']), () => 1, 3)).toBe(0)
  })

  it('空查询 = 0', () => {
    expect(idfWeightedRelevance([], new Set(['a']), () => 1, 3)).toBe(0)
  })

  it('稀有词命中权重 > 常见词命中（同命中数下 IDF 区分条目）', () => {
    // 候选 N=3：rareB 仅 1 条含，common 3 条全含，mid 2 条含；
    // 两查询 token 均为非零 df（不引入 df=0 稀释，只对比命中 token 的稀有度）
    const df = { rareB: 1, common: 3, mid: 2 }
    const hitRare = idfWeightedRelevance(['rareB', 'mid'], new Set(['rareB']), (t) => df[t] ?? 0, 3)
    const hitCommon = idfWeightedRelevance(['common', 'mid'], new Set(['common']), (t) => df[t] ?? 0, 3)
    // 同为 1/2 命中，命中"稀有 token"的那条权重更高（IDF 区分条目核心语义）
    expect(hitRare).toBeGreaterThan(hitCommon)
  })

  it('df=N 的常见词 idf 趋近 0（BM25 让常见词几乎不贡献权重）', () => {
    expect(bm25Idf(3, 3)).toBeLessThan(bm25Idf(3, 1))
    expect(bm25Idf(3, 3)).toBeCloseTo(Math.log(0.5 / 3.5 + 1), 10)
    expect(bm25Idf(3, 0)).toBeGreaterThan(bm25Idf(3, 3))
  })

  it('df=0 用最大 idf 保底且恒为正（只进分母稀释弱相关，不取负）', () => {
    expect(bm25Idf(3, 0)).toBeGreaterThan(0)
    // N 增大使 df=0 的 idf 更大（更罕见）
    expect(bm25Idf(20, 0)).toBeGreaterThan(bm25Idf(3, 0))
  })

  it('部分命中 = 命中的 idf 占比（0..1 之间；候选集外 df=0 词不进分母）', () => {
    // N=2：a/c 在候选集（df=1），只命中 a → 0.5（分母 = a+c 的 idf）
    const df = { a: 1, c: 1 }
    const score = idfWeightedRelevance(['a', 'c'], new Set(['a']), (t) => df[t] ?? 0, 2)
    expect(score).toBeCloseTo(0.5, 10)
    // 候选集外词 b（df=0）不进分母——候选集内全命中仍 1.0（相对匹配度语义）
    const scoreFull = idfWeightedRelevance(['a', 'b'], new Set(['a']), (t) => df[t] ?? 0, 2)
    expect(scoreFull).toBe(1)
    // 命中 token 越多比例越高（df 相同时）
    const score3 = idfWeightedRelevance(['a', 'c'], new Set(['a', 'c']), (t) => df[t] ?? 0, 2)
    expect(score3).toBeGreaterThan(score)
    // 全部 token 候选集外 → 0（候选集内无匹配面）
    expect(idfWeightedRelevance(['x', 'y'], new Set(['x']), () => 0, 2)).toBe(0)
  })

  it('未命中集为空的退化（n<=0）返回 0，不抛错', () => {
    expect(idfWeightedRelevance(['a'], new Set(['a']), () => 1, 0)).toBe(0)
  })
})

// F2（相关性硬门槛）：relevance 低于 MIN_RELEVANCE_SCORE 的记忆视为与查询
// 无关（宁可不注入）。常量语义测试——验证门槛值与"判定示例"的映射关系，
// 使注入层的行为变化在评分层可追溯。
describe('MIN_RELEVANCE_SCORE（F2 相关性硬门槛）', () => {
  it('门槛值为 0.3', () => {
    expect(MIN_RELEVANCE_SCORE).toBe(0.3)
  })

  it('低于门槛的 relevance 判定为"无关"（不注入）', () => {
    // 10-token 查询只命中 1 个 → relevance = 0.1 < 0.3：视为无关
    const tenTokens = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const hitOne = relevanceScore(tenTokens, new Set(['a']))
    expect(hitOne).toBe(0.1)
    expect(hitOne < MIN_RELEVANCE_SCORE).toBe(true)

    // 10-token 查询命中 2 个 → relevance = 0.2（旧门槛 0.15 区间内）仍 < 0.3
    const hitTwo = relevanceScore(tenTokens, new Set(['a', 'b']))
    expect(hitTwo).toBe(0.2)
    expect(hitTwo < MIN_RELEVANCE_SCORE).toBe(true)

    // 10-token 查询命中 3 个 → relevance = 0.3：恰好等于门槛（边界，放行）
    const hitThree = relevanceScore(tenTokens, new Set(['a', 'b', 'c']))
    expect(hitThree).toBeCloseTo(0.3, 10)
    expect(hitThree >= MIN_RELEVANCE_SCORE).toBe(true)
  })

  it('达到/超过门槛的 relevance 判定为"相关"（放行）', () => {
    // 10-token 查询命中 4 个及以上 → 稳定超过门槛
    const tenTokens = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const hitFour = relevanceScore(tenTokens, new Set(['a', 'b', 'c', 'd']))
    expect(hitFour).toBe(0.4)
    expect(hitFour >= MIN_RELEVANCE_SCORE).toBe(true)
  })

  it('门槛语义与 2026 混合检索门槛实践一致（mem0 0.65-0.75 / magic-context 0.6 量级）', () => {
    // 0.3 为关键词 token 命中比例路径的硬门槛，语义评分与关键词评分非同一量纲，
    // 故判定示例仅覆盖 token 命中比例；语义路径由 store 层 RRF 融合共用同一过滤。
    expect(MIN_RELEVANCE_SCORE).toBeGreaterThan(0)
    expect(MIN_RELEVANCE_SCORE).toBeLessThanOrEqual(0.3)
  })
})

describe('recencyFactor', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')

  it('刚访问返回 1', () => {
    expect(recencyFactor('2026-01-15T00:00:00.000Z', now)).toBe(1)
  })

  it('一个半衰期（7 天）衰减到 0.5', () => {
    expect(recencyFactor('2026-01-08T00:00:00.000Z', now)).toBeCloseTo(0.5, 5)
  })

  it('未来时间戳钳制为 1', () => {
    expect(recencyFactor('2026-02-01T00:00:00.000Z', now)).toBe(1)
  })

  it('非法时间戳钳制为 1', () => {
    expect(recencyFactor('not-a-date', now)).toBe(1)
  })
})

describe('importanceFactor', () => {
  it('importance 10 得最高权重 1.0', () => {
    expect(importanceFactor(10)).toBe(1.0)
  })

  it('importance 0 得最低权重 0.5', () => {
    expect(importanceFactor(0)).toBe(0.5)
  })

  it('越界值被钳制', () => {
    expect(importanceFactor(99)).toBe(1.0)
    expect(importanceFactor(-5)).toBe(0.5)
  })
})

describe('时间×重要性调制（原 memoryScore 语义，M4 统一为 timeImportanceFactor）', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')

  it('无关条目得 0 分', () => {
    const e = entry({})
    expect(relevanceScore(tokenize('完全无关的话题xyz'), tokensOf(e))).toBe(0)
  })

  it('相关且重要的条目得分更高（重要性调制）', () => {
    const low = entry({ id: 'a', importance: 1 })
    const high = entry({ id: 'b', importance: 10 })
    expect(timeImportanceFactor(high, now)).toBeGreaterThan(timeImportanceFactor(low, now))
  })

  it('更近访问的条目得分更高（时间衰减调制）', () => {
    const stale = entry({ id: 'a', lastAccessAt: '2025-01-01T00:00:00.000Z' })
    const fresh = entry({ id: 'b', lastAccessAt: '2026-01-14T00:00:00.000Z' })
    expect(timeImportanceFactor(fresh, now)).toBeGreaterThan(timeImportanceFactor(stale, now))
  })

  it('标签参与相关性命中', () => {
    const tagged = entry({ tags: ['架构'] })
    expect(relevanceScore(tokenize('架构'), tokensOf(tagged))).toBeGreaterThan(0)
  })
})

// P3（OPTIMIZATION_PLAN_3）：importance 感知半衰期 + salience floor
describe('adaptiveHalfLifeDays（P3）', () => {
  it('importance 5 为基础半衰期 7 天（与 P3 前行为一致）', () => {
    expect(adaptiveHalfLifeDays(5)).toBeCloseTo(7, 10)
  })

  it('importance 每 +2 半衰期翻倍（7→14→28）', () => {
    expect(adaptiveHalfLifeDays(7)).toBeCloseTo(14, 10)
    expect(adaptiveHalfLifeDays(9)).toBeCloseTo(28, 10)
  })

  it('importance 10 半衰期约 39.6 天', () => {
    expect(adaptiveHalfLifeDays(10)).toBeCloseTo(7 * 2 ** 2.5, 6)
  })

  it('单调递增且越界钳制', () => {
    expect(adaptiveHalfLifeDays(3)).toBeLessThan(adaptiveHalfLifeDays(6))
    expect(adaptiveHalfLifeDays(6)).toBeLessThan(adaptiveHalfLifeDays(9))
    expect(adaptiveHalfLifeDays(99)).toBe(adaptiveHalfLifeDays(10))
    expect(adaptiveHalfLifeDays(-5)).toBe(adaptiveHalfLifeDays(0))
  })
})

describe('衰减增强调制（P3，timeImportanceFactor）', () => {
  const now = Date.parse('2026-01-15T00:00:00.000Z')
  const VERY_OLD = '2025-01-01T00:00:00.000Z' // 一年前

  it('高重要度久未访问的记忆得分高于低重要度久未访问（自适应半衰期）', () => {
    const high = entry({ id: 'a', importance: 9, lastAccessAt: VERY_OLD })
    const low = entry({ id: 'b', importance: 3, lastAccessAt: VERY_OLD })
    // 同 relevance（内容相同）；imp 9 半衰期 28 天 + floor，imp 3 半衰期 ~3.5 天无 floor
    expect(timeImportanceFactor(high, now)).toBeGreaterThan(timeImportanceFactor(low, now))
  })

  it('salience floor：importance ≥ 8 时时间因子被钳制（保活）', () => {
    const floored = entry({ id: 'a', importance: SALIENCE_FLOOR_IMPORTANCE, lastAccessAt: VERY_OLD })
    const below = entry({ id: 'b', importance: SALIENCE_FLOOR_IMPORTANCE - 1, lastAccessAt: VERY_OLD })
    // 一年远大于两者的半衰期：无 floor 时 recency ≈ 0（因子 0.6）；有 floor 时 recency=0.5（因子 0.8）
    expect(timeImportanceFactor(floored, now)).toBeGreaterThan(timeImportanceFactor(below, now))
  })

  it('floor 常量语义：recency 下限 0.5 → 时间调制因子下限 0.8', () => {
    expect(SALIENCE_FLOOR_RECENCY).toBe(0.5)
    expect(0.6 + 0.4 * SALIENCE_FLOOR_RECENCY).toBe(0.8)
  })

  it('G4 salience floor 活跃窗口：90 天未创建/访问的高重要度不再保活（允许软降权）', () => {
    // 创建与最后访问均在 90 天前 → floor 失效，recency 可降至 0.5 以下
    const dormant = entry({
      id: 'a',
      importance: SALIENCE_FLOOR_IMPORTANCE,
      lastAccessAt: '2025-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
    })
    const active = entry({
      id: 'b',
      importance: SALIENCE_FLOOR_IMPORTANCE,
      lastAccessAt: '2026-01-10T00:00:00.000Z', // 5 天前（窗口内）
    })
    // active 保活（因子 ≥0.8），dormant 无 floor（因子可低于 active）
    expect(timeImportanceFactor(active, now)).toBeGreaterThan(timeImportanceFactor(dormant, now))
    // dormant 的时间因子无 floor：recency=exp(-ln2/28d×380d)≈极低 → 因子≈0.6+0.4×0≈0.6×importanceFactor
    const dormantFactor = timeImportanceFactor(dormant, now)
    expect(dormantFactor).toBeLessThan(0.8)
  })

  it('G4 创建在窗口内（无访问）仍保活：创建活跃性替代访问活跃性', () => {
    const newlyCreated = entry({
      id: 'a',
      importance: SALIENCE_FLOOR_IMPORTANCE,
      lastAccessAt: '2025-06-01T00:00:00.000Z', // 半年无访问
      createdAt: '2025-12-20T00:00:00.000Z', // 创建 26 天前（窗口内）
    })
    // floor 生效：recency=0.5 → 时间因子 0.8 × importanceFactor(8)=0.9 = 0.72；
    // 无 floor（recency≈0）则 0.6×0.9=0.54——断言落在两者之间证明保活
    expect(timeImportanceFactor(newlyCreated, now)).toBeGreaterThan(0.65)
  })

  it('新近访问仍占优（自适应半衰期不逆转"新"优势）', () => {
    const fresh = entry({ id: 'a', importance: 9, lastAccessAt: '2026-01-14T00:00:00.000Z' })
    const old = entry({ id: 'b', importance: 9, lastAccessAt: '2025-12-01T00:00:00.000Z' })
    expect(timeImportanceFactor(fresh, now)).toBeGreaterThan(timeImportanceFactor(old, now))
  })
})

describe('modulatedHalfLifeDays（访问频率调制衰减，B2）', () => {
  it('访问次数延长半衰期：0→1×、1→2×、3→3×、7→4×（1+log2(1+n)）', () => {
    const base = adaptiveHalfLifeDays(5) // 7 天
    expect(modulatedHalfLifeDays(5, 0)).toBeCloseTo(base)
    expect(modulatedHalfLifeDays(5, 1)).toBeCloseTo(base * 2)
    expect(modulatedHalfLifeDays(5, 3)).toBeCloseTo(base * 3)
    expect(modulatedHalfLifeDays(5, 7)).toBeCloseTo(base * 4)
    expect(modulatedHalfLifeDays(5, 15)).toBeCloseTo(base * 5)
  })

  it('与 importance 感知叠加：高频访问的高重要度记忆衰减最慢', () => {
    const lowFreqLowImp = modulatedHalfLifeDays(3, 0)
    const highFreqHighImp = modulatedHalfLifeDays(9, 7)
    expect(highFreqHighImp).toBeGreaterThan(lowFreqLowImp * 4)
  })

  it('高频访问的久远记忆得分高于低频访问（召回抬回）', () => {
    const now = Date.parse('2026-01-15T00:00:00.000Z')
    const VERY_OLD = '2025-01-01T00:00:00.000Z' // 一年前
    const visited = entry({ id: 'a', importance: 5, lastAccessAt: VERY_OLD, accessCount: 15 })
    const ignored = entry({ id: 'b', importance: 5, lastAccessAt: VERY_OLD, accessCount: 0 })
    expect(timeImportanceFactor(visited, now)).toBeGreaterThan(timeImportanceFactor(ignored, now))
  })
})

describe('rrfScore（RRF 排名融合，B1）', () => {  it('双榜第一 = 1（归一化上界）', () => {
    expect(rrfScore(1, 1)).toBe(1)
  })

  it('单榜第一 = 0.5（归一化半权）', () => {
    expect(rrfScore(1, undefined)).toBe(0.5)
    expect(rrfScore(undefined, 1)).toBe(0.5)
  })

  it('双榜均不在榜 = 0', () => {
    expect(rrfScore(undefined, undefined)).toBe(0)
  })

  it('排名越靠前贡献越大且单调', () => {
    expect(rrfScore(1, 1)).toBeGreaterThan(rrfScore(2, 1))
    expect(rrfScore(3, 3)).toBeGreaterThan(rrfScore(4, 4))
    // 单榜第二 < 单榜第一
    expect(rrfScore(2, undefined)).toBeLessThan(rrfScore(1, undefined))
  })

  it('双榜靠前优于单榜靠前（两通道证据叠加）', () => {
    expect(rrfScore(2, 2)).toBeGreaterThan(rrfScore(1, undefined))
  })
})

describe('effectiveImportance（W2：self/user 相关性初始因子并入保留决策）', () => {
  it('selfRelevance 档位：≥8 → +2、≥6 → +1、<6 → +0（对数式访问证据之上叠加）', () => {
    expect(effectiveImportance(5, 0, 0)).toBe(5) // 无访问无自相关
    expect(effectiveImportance(5, 0, 5)).toBe(5) // 低自相关 +0
    expect(effectiveImportance(5, 0, 6)).toBe(6) // 高自相关 +1
    expect(effectiveImportance(5, 0, 8)).toBe(7) // 极高自相关 +2
    expect(effectiveImportance(5, 0, 10)).toBe(7) // 封顶 +2（防自评分过度支配保留面）
  })

  it('与访问证据叠加但仍封顶 10；第三参缺省默认 0（向后兼容两参调用）', () => {
    expect(effectiveImportance(5, 3, 8)).toBe(9) // 3次访问 +2 且 极高自相关 +2 → 5+2+2
    expect(effectiveImportance(9, 7, 9)).toBe(10) // 9+2+2=13 → 钳制 10
    expect(effectiveImportance(6, 0)).toBe(6) // 缺省第三参 = 0（旧调用点不变）
  })
})
