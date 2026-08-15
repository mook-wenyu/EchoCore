/**
 * 组合根装配单元测试（R3-3/T3）。
 * 覆盖：
 * - inject 声明契约（四服务硬依赖——存储自建 SQLite 后不依赖 storageDomain）；
 * - 装配成功路径：SQLite 打开、模块监听注册、effect disposer 收集；
 * - 首启迁移：memory.json → memory.sqlite（含 .bak 改名与幂等）；
 * - 装配失败传播（SQLite 打开失败 → apply 拒绝，不半死激活）。
 * 存储路径经 MountOverrides 注入临时目录——测试绝不触碰真实用户目录。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { apply, inject, mountMemory } from '../src/index.js'
import { DEFAULTS } from '../src/config.js'
import { FakeCtx } from './helpers.js'

/**
 * mock 嵌入服务为"禁用态"（无模型无远程的正常态）——装配测试关注组合根
 * 接线与失败传播，不加载真实 ONNX 模型（22MB，环境依赖）；ready 分支的
 * 索引构建由 embedding.test.ts 的 EmbeddingIndex 测试独立覆盖。
 */
vi.mock('../src/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embedding.js')>()
  return {
    ...actual,
    EmbeddingService: class {
      state = 'disabled'
      dimension = 384
      backendLabel = 'local'
      async init(): Promise<void> {}
      async embed(): Promise<Float32Array> {
        throw new Error('mock 嵌入未就绪（index.test 不测 ready 路径）')
      }
      async embedMany(): Promise<Float32Array[]> {
        throw new Error('mock 嵌入未就绪（index.test 不测 ready 路径）')
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
  it('inject 声明四服务硬依赖（存储自建 SQLite——不依赖 storageDomain）', () => {
    expect(inject).toEqual(['llm', 'tools', 'connection', 'systemPrompt'])
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
    // RPC 已注册；六个工具已注册
    expect(connection.rpc.handle).toHaveBeenCalledWith('/memory', expect.any(Function), { authority: 'loopback' })
    expect(ctx.toolDefs.size).toBe(6)
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
})
