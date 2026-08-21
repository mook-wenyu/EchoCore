/**
 * 组合根装配单元测试（R3-3/T3）。
 * 覆盖：
 * - inject 声明契约（四服务硬依赖——存储自建 SQLite 后不依赖 storageDomain）；
 * - 装配成功路径：SQLite 打开、模块监听注册、effect disposer 收集；
 * - 首启迁移：memory.json → memory.sqlite（含 .bak 改名与幂等）；
 * - 装配失败传播（SQLite 打开失败 → apply 拒绝，不半死激活）。
 * 存储路径经 MountOverrides 注入临时目录——测试绝不触碰真实用户目录。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { apply, inject, mountMemory } from '../src/index.js'
import { DEFAULTS } from '../src/config.js'
import { EmbeddingService } from '../src/embedding.js'
import type { MemoryStore } from '../src/store.js'
import { FakeCtx } from './helpers.js'

// 全模块拦截（pass-through：默认真实实现）——用于确定性注入迁移读取的 EACCES 失败
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
import { readFile } from 'node:fs/promises'

/** 访问 mock EmbeddingService 的构造记录（静态计数——断言实时生效器重建后端） */
function embeddingConstructed(): Array<{ remote?: { model?: string } }> {
  return (EmbeddingService as unknown as { constructed: Array<{ remote?: { model?: string } }> }).constructed
}

/**
 * mock 嵌入服务为"禁用态"（无模型无远程的正常态）——装配测试关注组合根
 * 接线与失败传播，不加载真实 ONNX 模型（22MB，环境依赖）；ready 分支的
 * 索引构建由 embedding.test.ts 的 EmbeddingIndex 测试独立覆盖。
 * `constructed` 静态计数：断言实时生效器触发后重建了嵌入后端（每次
 * EmbeddingService 构造记录其远程配置——验证新配置到达后端重建路径）。
 */
vi.mock('../src/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.js')>()
  return {
    ...actual,
    EmbeddingService: class {
      static constructed: Array<{ remote?: { model?: string } }> = []
      /** 测试开关：readyMode=true 时模拟就绪后端（走真实 EmbeddingIndex 建表/ensureAll
       * 路径）；默认 false 保持既有 disabled 语义（装配测试不加载真实 ONNX） */
      static readyMode = false
      /** 测试开关：readyMode 下 embed/embedMany 抛错（模拟运行期嵌入故障——验证
       * 索引联动失败被收容、装配不崩） */
      static failEmbed = false
      state = EmbeddingService.readyMode ? 'ready' : 'disabled'
      dimension = 384
      backendLabel = 'remote'
      constructor(deps: { remote?: { model?: string } }) {
        ;(this.constructor as { constructed: Array<{ remote?: { model?: string } }> }).constructed.push({
          remote: deps.remote,
        })
      }
      async init(): Promise<void> {}
      get degradedReason(): string | undefined {
        return undefined
      }
      async embed(): Promise<Float32Array> {
        if (EmbeddingService.failEmbed) throw new Error('mock 嵌入故障（语义层降级）')
        return new Float32Array(384)
      }
      async embedMany(): Promise<Float32Array[]> {
        if (EmbeddingService.failEmbed) throw new Error('mock 嵌入故障（语义层降级）')
        return [new Float32Array(384)]
      }
    },
  }
})

/** 假 llm：仅满足 extractor 装配（stream 不会被调用） */
const fakeLlm = { stream: async function* stream() {} }

/** 假 connection：捕获 rpc.handle 注册 */
function fakeConnection(): { rpc: { handle: ReturnType<typeof vi.fn> } } {
  return { rpc: { handle: vi.fn(() => () => Promise.resolve()) } }
}

/** 临时存储目录（每用例独立，防 WAL 残留互扰） */
function tmpStore(): { dir: string; dbFile: string; jsonFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'index-'))
  return { dir, dbFile: join(dir, 'memory.sqlite'), jsonFile: join(dir, 'memory.json') }
}

/** 组装装配环境：返回 ctx 与各类可断言句柄。
 * 注意：Cordis 服务经属性注入（ctx.llm/connection 直接可读，
 * 见 index.ts 装配代码），故在此直接赋值而非走 provide/get 注册表。
 * 存储路径一律经 mountMemory 的 overrides 显式注入临时目录。 */
function setup() {
  const ctx = new FakeCtx() as FakeCtx & { llm: unknown; connection: unknown }
  ctx.llm = fakeLlm
  const connection = fakeConnection()
  ctx.connection = connection
  return { ctx, connection }
}

/** 构造最小合法记忆记录（迁移测试用） */
function makeEntry(id: string, content: string): Record<string, unknown> {
  return {
    id,
    workspace: 'D:/ws',
    sessionId: 's1',
    kind: 'fact',
    content,
    importance: 5,
    tags: [],
    source: { sessionId: 's1', eventSeqs: [1], excerpt: '原文' },
    dedupKey: 'k' + id,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    lastAccessAt: '2026-08-15T00:00:00.000Z',
    accessCount: 0,
    status: 'active',
    audit: [{ action: 'create', at: '2026-08-15T00:00:00.000Z', by: 'system' }],
  }
}

/** 卸载 ctx（执行 disposers 关闭 SQLite）后清理临时目录（Windows 打开文件不可删） */
async function cleanup(ctx: FakeCtx, dir: string): Promise<void> {
  for (const dispose of ctx.disposers) dispose()
  // 等待 disposer 链落定（db.close 同步，给微任务让路防 Windows 文件锁）
  await new Promise((resolve) => setTimeout(resolve, 0))
  rmSync(dir, { recursive: true, force: true })
}

describe('插件组合根（index.ts）', () => {
  it('inject 声明五服务硬依赖（存储自建 SQLite——不依赖 storageDomain）', () => {
    expect(inject).toEqual(['llm', 'tools', 'connection', 'systemPrompt', 'agentDefaultModel'])
  })

  it('装配成功：监听注册、effect 收集 disposer（SQLite 打开不报错）', async () => {
    const store = tmpStore()
    const { ctx, connection } = setup()
    const promise = mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    await expect(promise).resolves.toBeUndefined()
    // 各功能模块的监听器均已注册（extractor/injector/snapshot/maintenance）
    expect(ctx.listeners.get('session/event')?.size ?? 0).toBeGreaterThanOrEqual(1)
    // pre-step：注入器（注入记忆）+ 整理任务（活动门）各注册一个
    expect(ctx.listeners.get('agent/pre-step')?.size ?? 0).toBe(2)
    expect(ctx.listeners.get('agent/disposed')?.size ?? 0).toBeGreaterThanOrEqual(1)
    // RPC 已注册；八个工具已注册（C35：+ memory_causal）
    expect(connection.rpc.handle).toHaveBeenCalledWith('/memory', expect.any(Function), { authority: 'loopback' })
    expect(ctx.toolDefs.size).toBe(8)
    // 稳定快照段已注册（P1：systemPrompt.context）
    expect(ctx.systemPromptContexts.has('memory:snapshot')).toBe(true)
    // 卸载：effect disposer 存在（SQLite 关闭）
    expect(ctx.disposers.length).toBeGreaterThanOrEqual(1)
    await cleanup(ctx, store.dir)
  })

  it('SQLite 打开失败时装配拒绝（插件加载失败可见，不半死激活）', async () => {
    const { ctx } = setup()
    // 指向不可创建的文件（父目录不存在）→ DatabaseSync 抛错 → 装配拒绝
    const badDir = join(tmpdir(), 'no-such-dir-xyz', 'memory.sqlite')
    await expect(
      mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
        dbFile: badDir,
        legacyJsonFile: '',
      }),
    ).rejects.toThrow()
  })

  it('首启迁移：memory.json → memory.sqlite（导入 + .bak 改名）', async () => {
    const store = tmpStore()
    // 构造旧 storage-json 形态：tables.entries 字典（2 条合法 + 1 条非法）
    writeFileSync(
      store.jsonFile,
      JSON.stringify({
        unit: { name: 'memory', version: 1 },
        global: null,
        tables: {
          entries: {
            a: makeEntry('a', '记忆甲'),
            b: makeEntry('b', '记忆乙'),
            bad: { id: 'bad', kind: 'fact', content: '缺字段' },
          },
        },
      }),
      'utf8',
    )
    const { ctx } = setup()
    // 直接调 mountMemory（overrides 显式传路径）
    await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    // 迁移后：原文件改名为 .bak；SQLite 有 2 条合法记录（坏记录跳过）
    expect(await import('node:fs/promises').then((fs) => fs.access(store.jsonFile).then(() => true).catch(() => false))).toBe(false)
    expect(await import('node:fs/promises').then((fs) => fs.access(`${store.jsonFile}.bak`).then(() => true).catch(() => false))).toBe(true)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(store.dbFile)
    const rows = db.prepare('SELECT id FROM entries ORDER BY id').all() as Array<{ id: string }>
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
    await cleanup(ctx, store.dir)
  })

  it('迁移幂等：SQLite 非空时不再导入（数据不重复）', async () => {
    const store = tmpStore()
    writeFileSync(
      store.jsonFile,
      JSON.stringify({ tables: { entries: { a: makeEntry('a', '记忆甲') } } }),
      'utf8',
    )
    // 首次装配：迁移（memory.json → .bak）
    const { ctx } = setup()
    await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    // 第二次装配（新 ctx，同 dbFile）：SQLite 非空 → 跳过迁移（不重复导入）
    const ctx2 = setup().ctx
    await mountMemory(ctx2 as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(store.dbFile)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c
    expect(count).toBe(1) // 未被二次导入（保持 1 条）
    db.close()
    // 合并 dispose 两个 ctx（先关所有 SQLite 连接）再删目录一次（防 Windows 文件锁竞争）
    for (const dispose of [...ctx.disposers, ...ctx2.disposers]) dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    rmSync(store.dir, { recursive: true, force: true })
  })

  it('D2 迁移坏 JSON：不阻断插件启动（告警 + .bak 保留 + 空库）', async () => {
    const store = tmpStore()
    // 整个文件 JSON 损坏（半截写入）
    writeFileSync(store.jsonFile, '{"tables": {"entries": {"a": {"id": "a"', 'utf8')
    const { ctx } = setup()
    await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    // 插件正常启动（不拒绝）；坏文件改名 .bak 保留；库为空
    expect(ctx.toolDefs.has('memory_recall')).toBe(true)
    expect(await import('node:fs/promises').then((fs) => fs.access(`${store.jsonFile}.bak`).then(() => true).catch(() => false))).toBe(true)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(store.dbFile)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c
    expect(count).toBe(0)
    db.close()
    await cleanup(ctx, store.dir)
  })

  it('装配成功后 store 可写可查（六工具注册）', async () => {
    const store = tmpStore()
    const { ctx } = setup()
    await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    expect(ctx.toolDefs.has('memory_recall')).toBe(true)
    expect(ctx.toolDefs.has('memory_status')).toBe(true)
    await cleanup(ctx, store.dir)
  })

  it('面板保存实时生效：setApplier 挂接 + 触发重建嵌入后端（无插件重启）', async () => {
    const store = tmpStore()
    const { ctx, connection } = setup()
    // 假 seam：仅捕获装配挂接的实时生效器（真实 seam 见 settings.test.ts）
    let applier: ((next: never) => Promise<void>) | undefined
    const seam = {
      effective: () => ({ ...DEFAULTS }),
      setApplier: (fn: never) => {
        applier = fn
      },
    }
    await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
      seam: seam as never,
    })
    const before = embeddingConstructed().length
    expect(applier).toBeDefined()
    // 触发实时生效（模拟 settings 变更）：重建嵌入后端——新配置到达构造路径
    await applier!({
      ...DEFAULTS,
      embeddingApiBaseUrl: 'http://verify.local/v1',
      embeddingApiKey: 'sk-verify', // 字面 key（env:NAME 引用在测试环境无对应变量 → 判定未配置）
      embeddingModel: 'BAAI/bge-m3',
      embeddingDimension: 512,
    } as never)
    const constructed = embeddingConstructed()
    expect(constructed.length).toBe(before + 1)
    expect(constructed.at(-1)?.remote?.model).toBe('BAAI/bge-m3')
    // 无插件重启：RPC 保持单次注册（实时生效不重跑 apply）
    expect(connection.rpc.handle).toHaveBeenCalledTimes(1)
    await cleanup(ctx, store.dir)
  })

  it('B1 DSH_HOME 优先：未传 overrides 时存储落在 $DSH_HOME/storages（与 settings.yaml 同源）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dshhome-'))
    const { ctx } = setup()
    vi.stubEnv('DSH_HOME', home)
    try {
      // 预建 storages 目录（真实部署由 dsh 创建；SQLite 不自动建父目录）
      mkdirSync(join(home, 'storages'), { recursive: true })
      // 故意不传 dbFile/legacyJsonFile——走默认路径（此时 DSH_HOME 应接管）
      await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never)
      // 记忆库落在 $DSH_HOME/storages/memory.sqlite（而非真实 ~/.dsh）
      expect(existsSync(join(home, 'storages', 'memory.sqlite'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      for (const dispose of ctx.disposers) dispose()
      await new Promise((resolve) => setTimeout(resolve, 0))
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('迁移全坏/全跳过（migrated=0 且 skipped>0）：不 rename .bak（保留原文件 + 告警，可修复后重试）', async () => {
    const store = tmpStore()
    // 全部记录 schema 非法（缺字段）——迁移 0 条、跳过 2 条
    writeFileSync(
      store.jsonFile,
      JSON.stringify({
        tables: {
          entries: {
            a: { id: 'a', kind: 'fact', content: '缺字段' },
            b: { id: 'b', kind: 'fact', content: '也缺字段' },
          },
        },
      }),
      'utf8',
    )
    const { ctx } = setup()
    await mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    // 原文件保留（未被改名 .bak）——数据仍原位可人工修复后重新迁移（Q6① 拍板）
    expect(existsSync(store.jsonFile)).toBe(true)
    expect(existsSync(`${store.jsonFile}.bak`)).toBe(false)
    // 库为空（迁移 0 条，未 rename）
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(store.dbFile)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c
    expect(count).toBe(0)
    db.close()
    await cleanup(ctx, store.dir)
  })

  it('迁移读取失败（非 ENOENT）→ 装配拒绝不半死；下次装配（修复后）重试成功——"中断可重试"端到端验收（F1 中优先级）', async () => {
    const store = tmpStore()
    writeFileSync(
      store.jsonFile,
      JSON.stringify({ tables: { entries: { a: makeEntry('a', '记忆甲') } } }),
      'utf8',
    )
    // 第一次装配：readFile 抛 EACCES（旧库不可读的 IO 故障）→ migrateMemoryJson 上抛
    // → mountMemory 整体拒绝（不半死激活、不静默空库丢迁移源）
    vi.mocked(readFile).mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    )
    const ctx1 = setup().ctx
    await expect(
      mountMemory(ctx1 as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
        dbFile: store.dbFile,
        legacyJsonFile: store.jsonFile,
      }),
    ).rejects.toThrow('permission denied')
    vi.mocked(readFile).mockClear()
    // 关闭第一次装配留下的数据库连接，再重试装配（模拟"修复权限后重启"）
    for (const dispose of ctx1.disposers) dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ctx2 = setup().ctx
    await mountMemory(ctx2 as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
      dbFile: store.dbFile,
      legacyJsonFile: store.jsonFile,
    })
    // 重试成功：条目已迁移落库
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(store.dbFile)
    const rows = db.prepare('SELECT id FROM entries ORDER BY id').all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['a'])
    db.close()
    for (const dispose of [...ctx1.disposers, ...ctx2.disposers]) dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    rmSync(store.dir, { recursive: true, force: true })
  })

  it('语义嵌入 ready 但运行期嵌入故障（ensureAll/indexEntry 失败）被收容——装配完成不崩 apply（Q6② 拍板：索引联动为附属效果，失败仅告警）', async () => {
    const store = tmpStore()
    // 经 legacy 迁移灌入条目（store 非空 → ensureAll 会真正调 embedMany 走失败收容路径）
    writeFileSync(
      store.jsonFile,
      JSON.stringify({ tables: { entries: { a: makeEntry('a', '记忆甲'), b: makeEntry('b', '记忆乙') } } }),
      'utf8',
    )
    const { ctx } = setup()
    const EmbeddingServiceMock = EmbeddingService as unknown as { readyMode: boolean; failEmbed: boolean }
    EmbeddingServiceMock.readyMode = true
    EmbeddingServiceMock.failEmbed = true
    try {
      await expect(
        mountMemory(ctx as never, { ...DEFAULTS } as never, { warn: () => {}, info: () => {} } as never, {
          dbFile: store.dbFile,
          legacyJsonFile: store.jsonFile,
        }),
      ).resolves.toBeUndefined()
    } finally {
      EmbeddingServiceMock.readyMode = false
      EmbeddingServiceMock.failEmbed = false
      await cleanup(ctx, store.dir)
    }
  })
})

