# @echocore/dsh-memory 第二轮优化实现计划

> 深度审查产物（第二轮）。审查方法：3 个并行只读子代理（源码质量域 / 测试与防回归域 / 集成部署域）+ 主代理逐点复核（含 3 项契约查证 V5/V6/V7）。
> 状态：用户六项裁决已定，分阶段实施，每阶段独立 git 提交。
> 日期：2026-08-15。前置：第一轮优化（O1–O8+D-A，162 测试全绿）已完成。

## 0. 背景与目标

第一轮优化解决的是"功能正确性"（腐化防线、生命周期、存储语义）；本轮审查发现的问题集中在**结构性契约**与**测试基建保真度**：

1. 修复装配失败被吞（插件半死激活）等结构性缺陷；
2. 消除"兜底掩盖 bug"类代码（store 异常混吞、sessionId 伪造、connection 守卫死代码）；
3. 升级测试基建（FakeCtx 四份漂移、FakeTable 无失败注入、组合根与 schema 零测试）；
4. 实施记忆投毒轻量加固（用户裁决：本期实施）；
5. 修复部署漂移（`--dsw-*` 面板主题已提交但从未 build）。

## 1. 审查发现总表（主代理复核后定稿）

### 1.1 结构性缺陷（代码）

| # | 问题 | 证据 | 裁决 |
|---|------|------|------|
| B1 | 装配失败只 `logger.error` 不上抛，插件保持"已激活"但功能全缺 | index.ts:36-38 | **上抛**（V5：Cordis `ctx.plugin()` fiber "rejecting on config or startup errors"——apply 返回 rejected promise 即加载失败） |
| B2 | store `update`/`archive` 的 try/catch 把**真实存储异常**与"missing-key"混吞 | store.ts:221-247 | **按 `DomainError.code==='missing-key'` 精确转换，其余上抛**（V7：KvTable.update 缺失 key rejects `missing-key`；后端失败以 StorageError 原样传播） |
| B3 | connection 契约矛盾：index.ts 硬 inject vs host-rpc/client 双处 optional 守卫 | index.ts:31；host-rpc.ts:59；client.ts:63 | **删除守卫**（V6：inject 语义"缺失则不加载"——声明即必有，守卫是死代码） |
| B4 | `?? DEFAULTS` 死分支（schemastery 加载即填默认，注释自认"死分支"） | index.ts:52-84 | **删除**，直接读 `config.x` |
| B5 | `exec.agent?.id ?? DEFAULT_WORKSPACE`：workspace 键被伪造成 sessionId 写入来源数据 | tools.ts:276,282 | **缺失即抛**（DSH 契约保证工具执行必有 agent；兜底掩盖契约违例） |
| B6 | `existingId ?? ''` 伪造空串满足 output schema required | tools.ts:291 | **改 schema**：`mergedWithId` 仅在 merged=true 时有值，render 按 merged 分支取用 |
| B7 | 记忆行渲染格式两处重复（tools.ts 与 injector.ts `formatMemoryLine`） | tools.ts:130-134；injector.ts:204-208 | **抽公共模块 `src/render.ts` 单源** |
| B8 | `.slice(0, 400)` 硬编码，未复用 `EXCERPT_MAX_CHARS` | snapshot.ts:57,83 | **引用常量** |
| B9 | extractor 失败重试导致重复提取（重复 LLM 调用） | extractor.ts:198-200 | **修正认知**：`pending.delete` 在 `await` 之后，抛错不执行——数据不丢、水位不推进、下次重试；代价是重复 LLM 调用。**保留现状语义**（数据完整性优先），补注释说明成本权衡，不新增防抖复杂度（YAGNI） |

### 1.2 测试基建缺口

| # | 缺口 | 证据 | 处置 |
|---|------|------|------|
| T1 | FakeCtx 四份漂移（injector/extractor/tools/host-rpc 各自实现），缺 effect/get/logger/多监听者 | 各 test 文件 | 统一入 helpers.ts |
| T2 | FakeTable 无失败注入、无 schema 校验、时序与真实"写链持久化"不符 | helpers.ts:11-49 | 加 `failNextWrite`（可抛 DomainError missing-key / StorageError）、zod 校验钩子 |
| T3 | index.ts 装配链路零测试（inject 声明、mountMemory 顺序、B1 上抛行为） | — | 新增 index.test.ts |
| T4 | memory-domain zod schema 零测试 | — | 新增 schema 拒绝非法枚举测试 |
| T5 | MemoryPanel 组件零测试（只测 createMemoryApi） | client.test.ts | 补渲染/加载/错误/分页用例 |
| T6 | 条件断言残留（`if (kind!=='enter') return` 后置断言静默跳过） | injector.test:103,153,165 等 | 去守卫，改先行 `expect(decision).toMatchObject(...)` |

### 1.3 部署漂移（事实问题）

| # | 问题 | 证据 | 处置 |
|---|------|------|------|
| D1 | `--dsw-*` 主题修复已提交（518663f，15:16）但从未 build：仓库 lib/ 与部署副本均为 14:09 旧产物，**面板实际运行旧样式** | lib mtime 14:09:59 vs src/client.ts 15:14:19 | R5 末尾：build + profile `pnpm install` + 真机验证 |
| D2 | `.agent-presets/` 为空——preset 方案已被"宿主组合行全局挂载"取代（8c042e8） | ~/.dsh 实测 | 确认宿主组合行为最终方案（README 已对齐），不重建 preset |

### 1.4 文档问题

| # | 问题 | 证据 | 处置 |
|---|------|------|------|
| W1 | README 表格"溯源审计/模型工具/会话快照/记忆面板"四行重复两次 | README.md:13-27 | 去重 |
| W2 | README "87 个"测试数过时 | README.md:93 | 更新为实际数 |

### 1.5 维护性（子代理发现，主代理复核）

| # | 问题 | 证据 | 处置 |
|---|------|------|------|
| M1 | maintenance `mergeDuplicates` O(n²) 每对重读 store | maintenance.ts:198-221 | 单次快照 + 按 id 排序线性扫描（R2 顺带） |
| M2 | `Math.max(1, hours)` 配置兜底改写语义 | maintenance.ts:139 | config schema 加 `minimum: 1` 校验，运行时删除夹逼 |
| M3 | extract.ts 贪婪正则 `/\{[\s\S]*\}/` 可能截错多对象输出 | extract.ts:112 | 改为首个 `{` 到匹配闭合 `}` 的平衡扫描（轻量） |
| M4 | extract.ts `resolveRoute` 每次全量 `[...session.events].reverse()` | extract.ts:148 | 逆序遍历不构造数组（`for` 倒序） |
| M5 | tools.ts `bind` 强转类型掩盖签名漂移 | extractor.ts:88 | 以类型化监听器声明替代强转（若 DSH 类型允许） |
| M6 | types.ts 字段与 zod schema 双源 | types.ts vs memory-domain.ts | 保持现状（第一轮已做枚举单源；字段级派生收益低，YAGNI——记录不实施） |

## 2. 实施阶段（每阶段：先写失败测试 → 实现 → 全量测试 → git 提交）

### R2 结构性缺陷修复（代码域）

**R2-1 装配失败上抛（B1）**
- `src/index.ts`：`apply` 改为 `return mountMemory(ctx, config, logger)`（async 函数返回 promise；失败经 Cordis fiber 拒绝暴露为加载失败），删除 `.catch(logger.error)` 包裹；mountMemory 内部的失败日志保留在抛出点（logger.error 一次后 rethrow 或让错误自然传播——选后者，宿主统一处理）。
- 失败测试：`mountMemory` 在 `storageDomain.open` 拒绝时（FakeCtx 注入失败工厂）返回 rejected promise。
- 注意：`ctx.effect` 注册的 `domain.close` 在 open 失败时不应执行——open 失败即无句柄，现有代码 open 成功后才注册 effect，天然正确（保持）。

**R2-2 store 异常语义精确化（B2）**
- `src/store.ts` `update`/`archive`：catch 改为
  ```ts
  catch (error) {
    if (error instanceof DomainError && error.code === 'missing-key') return undefined/false
    throw error  // 真实异常（IO/校验/closed）原样传播
  }
  ```
- `DomainError` 从 `@deepseek-ai/dsh-storage-domain` 导入（查证：error.d.ts 导出 `DomainError` 类 + `DomainErrorCode`）。
- 失败测试：FakeTable `failNextWrite(new DomainError('missing-key', ...))` → update 返回 undefined；`failNextWrite(new StorageError(...))` 或普通 Error → update 上抛。

**R2-3 connection 守卫删除（B3）**
- `src/host-rpc.ts`：`registerMemoryRpc` 删除 `ctx.get('connection')` undefined 守卫与告警分支，直接 `ctx.connection.rpc.handle(...)`。
- `src/client.ts`：`createMemoryApi` 删除 connection 缺失时的假 RpcResult 分支，直接 `ctx.connection.rpc.call`。
- 失败测试：删除后无告警路径可测——改为测试"契约"：index.test.ts 断言 inject 声明含 'connection'（T3 覆盖）。

**R2-4 `??` 死分支删除（B4）**
- `src/index.ts`：extractorConfig/injectorConfig/maintenanceConfig 直接引用 `config.x`（DEFAULTS 仍单源在 config.ts 供 schema 用）。
- 回归测试：config.test.ts 已有"默认值落位"断言（schemastery 填充），补"无传配置时装配使用默认值"（index.test.ts 装配测试，T3）。

**R2-5 sessionId 缺失即抛（B5）**
- `src/tools.ts`：工具 execute 内 `exec.agent` 缺失时抛错（明确错误信息"工具执行缺少 agent 上下文"）。需先查证 `exec` 类型：`exec.agent` 是否恒有（dsh-tools 的 ToolExecutionContext）。若类型上恒有，删 `?.` 直接 `exec.agent.id`，编译器即保证（更优——类型即契约）。查证 V8。
- 失败测试：构造缺 agent 的 exec（若类型允许）断言抛错；类型不允许则编译级保证 + 注释。

**R2-6 existingId 语义修正（B6）**
- `src/tools.ts` memory_note output schema：`existingId` 改为 `mergedWithId`（语义化命名），render 按 `value.merged` 分支：merged=true 时用 `value.mergedWithId.slice(0,8)`；false 时文本不含 id 引用。schema 仍 required（若 TS 推断要求）但值语义真实（merged=false 时传 `''` 改为**不传**——若 required 强制则用 `mergedWithId: value.merged ? result.outcome.existingId : ''` 且 render 只在 merged 时读取——需在实施时验证 defineTool 的 output schema 是否强制 required；查证 V9）。
- 失败测试：note 合并时 render 含合并 id；不合并时不含。

**R2-7 渲染单源（B7）**
- 新建 `src/render.ts`：导出 `renderMemoryLine(entry, opts?)`（原 injector.formatMemoryLine 与 tools 的 bullet 渲染合并，统一短 id/重要度/来源标记格式）。
- `src/injector.ts`、`src/tools.ts` 改引用；删除各自重复实现。
- 回归测试：现有 injector/tools 渲染断言迁移到 render.test.ts（新文件），两处输出与旧行为逐字节一致。

**R2-8 snapshot 常量复用（B8）**
- `src/snapshot.ts`：`.slice(0, 400)` → `.slice(0, EXCERPT_MAX_CHARS)`。
- 回归测试：现有 snapshot 测试保持通过（值同为 400）。

**R2-9 extractor 语义注释（B9）**
- `src/extractor.ts` extractAndStore 失败路径补注释：明确"pending/水位保留 → 重试重复提取 → dedup 合并兜底；重复 LLM 调用是完整性优先的已知成本"。不加代码。

**R2-10 maintenance 性能与配置（M1/M2）**
- `src/maintenance.ts` mergeDuplicates：先 `listActiveSnapshot()`（单次 entries 快照）再按 id 排序线性扫描，消除每对重读。
- `src/config.ts`：`maintenanceIntervalHours` schema 加 `minimum: 1`；maintenance.ts 删除 `Math.max(1, hours)`。
- 失败测试：`interval 0 配置被 schema 拒绝`（config.test.ts）；合并逻辑在快照语义下行为不变（maintenance.test.ts 现有用例回归）。

**R2-11 extract 解析与路由（M3/M4）**
- `src/extract.ts`：平衡花括号扫描替代贪婪正则；`resolveRoute` 倒序 for 遍历不构造数组。
- 失败测试：`parseExtractionOutput` 多对象/含花括号文本用例。

### R3 测试基建（测试域）

**R3-1 FakeCtx 统一（T1）**
- `test/helpers.ts` 新增 `createFakeCtx(overrides)`：含 `effect`（收集 disposers）、`get`（服务注册表）、`logger`（warn/error 收集）、`on`（多监听者 Map）、`tools.register`、`storageDomain.open`（可注入失败工厂）、`llm.stream`（可注入）、`connection.rpc`（可注入）。四份漂移 FakeCtx 全部替换为 helpers 版。
- 迁移后既有测试不改断言语义，仅改构造方式。

**R3-2 FakeTable 增强（T2）**
- helpers FakeTable：`failNextWrite(error)` 钩子（下次 put/update/delete 抛 error，之后恢复）；`schema` 可选校验钩子（写入前校验，拒绝时抛 DomainError('invalid-record')）；entries/keys 保持快照语义（第一轮已做）。
- 新测试：store 的 missing-key 精确转换（R2-2）、schema 拒绝畸形记录。

**R3-3 index 装配测试（T3）**
- 新增 `test/index.test.ts`：inject 声明含四服务；mountMemory 顺序（open→store→extractor→injector→tools→snapshot→rpc→maintenance）；open 失败时 apply 返回 rejected promise（B1）；disposed 时 effect 收集的 domain.close 被调用。

**R3-4 schema 测试（T4）**
- 新增 memory-domain schema 用例：非法 kind/status/importance 范围拒绝；合法记录通过。

**R3-5 MemoryPanel 组件测试（T5）**
- client.test.ts 扩充：渲染列表、加载中/错误态、分页参数、归档按钮调用 RPC。需要 react 渲染（现有 client.test 已 vi.mock('react') 或真实渲染？——查证现有测试方式后决定；若环境限制组件渲染，降级为 createMemoryApi 全方法 + 渲染纯函数抽取测试）。

**R3-6 条件断言清理（T6）**
- injector.test.ts / host-rpc.test.ts / extractor.test.ts：`if (kind!=='enter') return` 守卫改为先行 `expect(decision.kind).toBe('enter')`；`if (ok)` 同理。

### R4 安全轻量加固（用户裁决：本期实施）

依据论文：MemPoison（arXiv:2607.14651：持久记忆投毒的结构性盲区）、SMSR（arXiv:2606.12703：运行时记忆投毒认证防御）、Injection–Execution Dissociation（arXiv:2605.08442：记忆攻击与防御的机制评估）。轻量加固 = 成本可控、不引入新依赖、不改变注入主流程。

**R4-1 source 完整性校验（读路径防篡改）**
- `src/store.ts`：`search`/`listRecent`/`getById`（注入与工具共用读路径）对每条 entry 校验 `source` 结构（`sessionId` 非空字符串、`eventSeqs` 为数组、`excerpt` 为字符串）；畸形条目**跳过**并在注入路径 warn 一次（不静默，可发现手工篡改 memory.json 的伪记忆）。
- 校验函数抽纯函数 `isSourceWellFormed(source)`（放 store.ts 或 types.ts 旁，可单测）。
- 失败测试：畸形 source 条目不出现在检索结果；注入路径 warn 一次。

**R4-2 注入声明强化（对抗经验跟随/过时记忆）**
- `src/injector.ts` 注入块头尾声明追加："记忆可能过时或被覆盖，以当前对话与代码库为准"。
- 回归测试：注入文本包含新声明断言（更新现有断言）。

**R4-3 注入隔离钉住（结构分离）**
- 测试断言：注入块始终是独立 `user/message`（form: 'recall'、source: plugin），从不与用户指令同块——现有实现已满足，补测试钉住防回归。

### R5 文档与部署收尾

- R5-1 README：去重（W1）、测试数更新（W2）、补安全声明（记忆视为未受信输入 + source 完整性校验）、补"第二轮优化"说明。
- R5-2 本计划文档追加实施记录表（勾选完成项、记录 V8/V9 查证结果）。
- R5-3 STATUS.md 更新（架构健康度、变更影响、风险、下次该做的事）。
- R5-4 部署同步（D1）：`pnpm --filter @echocore/dsh-memory build` → profile `pnpm install` 刷新副本 → `dsh web --port 0` 真机验证面板（`--dsw-*` 生效、记忆面板可用、无 console 错误）。

## 3. 待验证项（实施前必须查证，禁止猜测）

- V8：`exec.agent` 的类型是否恒有（dsh-tools 的 ToolExecutionContext 定义）——决定 B5 是"删 `?.` 编译级保证"还是"运行期显式抛错"。
- V9：defineTool 的 output schema 是否强制所有属性 `required`——决定 B6 的 schema 形态（mergedWithId 可选 vs 必须传空串）。
- V10：client.test.ts 现有 react 测试方式（vi.mock 还是真实渲染）——决定 R3-5 MemoryPanel 测试策略。

## 4. 执行顺序与依赖

```
R2（结构性，代码）→ R3（测试基建，含 R2 全部回归）→ R4（安全加固）
→ R5（文档 + 部署同步）
每阶段：先写失败测试 → 实现 → pnpm --filter @echocore/dsh-memory test 全绿 → git 提交
```

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| B1 上抛后插件加载失败影响宿主启动 | 仅在存储打开失败时发生（当前现实是成功）；失败可见优于半死激活——正是本轮目标 |
| R3 FakeCtx 统一引入测试回归 | 迁移不改断言语义，仅改构造；全量测试逐阶段跑 |
| R2-7 渲染单源改变输出字节 | render.test 钉住旧输出逐字节一致 |
| R4-1 source 校验误伤合法旧数据 | 校验只要求字段存在与类型（宽容），不校验内容格式；畸形才跳过 |
| 部署同步后真机异常 | R5-4 真机验证清单：面板可见、列表可查、注入消息带声明、无 console error |

## 6. 交付物

- 每阶段：代码 + 测试 + 提交（`fix(dsh-memory): ...` / `test(dsh-memory): ...` / `refactor(dsh-memory): ...` / `docs(dsh-memory): ...`）
- 本计划文档随阶段更新（实施记录）
- 收尾：README / STATUS.md 更新

## 参考来源

- 论文：MemPoison（arXiv:2607.14651）；SMSR（arXiv:2606.12703）；Injection–Execution Dissociation（arXiv:2605.08442）
- 本地契约：@deepseek-ai/cordis registry.d.ts（fiber 拒绝语义、inject 加载语义）；@deepseek-ai/dsh-storage-domain domain.d.ts（KvTable.update missing-key reject）、error.d.ts（DomainError code 判别、StorageError 不重包）
- 审查证据：3 个并行子代理报告（源码/测试/集成部署）+ 主代理逐点复核（index/tools/extractor/store/client 全文 + V5/V6/V7 契约查证）
