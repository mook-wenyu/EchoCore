# @echocore/dsh-memory 优化实现计划

> 深度审查产物。审查方法：4 个并行只读子代理（核心存储域 / 提取注入域 / 工具 RPC 快照客户端域 / 测试域）+ 主代理逐文件复核 + 上下文腐化专项网络调研（7 篇论文 + 3 份工程实践）。
> 状态：待用户裁决决策点后分阶段实施。每阶段独立 git 提交。

## 0. 背景与目标

当前项目功能完整（87 测试全绿、全局挂载），但深度审查暴露 **8 个高优先级缺陷**（含 3 个上下文腐化向量）、14 个中优先级问题与系统性测试缺口。本计划的目标：

1. 修复上下文腐化向量（反馈回路、级联失真、矛盾无裁决、信息丢失）——**最高优先**；
2. 修复生命周期与正确性缺陷（内存泄漏、装配失败不可见、去重索引漂移）；
3. 收敛死代码与接口（YAGNI：未接线的 restore/hardDelete/deleted 状态等）；
4. 补齐测试体系（去重核心、防回归、竞态、断言质量、FakeTable 保真）；
5. 明确论文驱动的演进决策点（需用户裁决，不在本期擅自实现）。

## 1. 审查发现总表（已交叉验证，含严重度与证据位置）

### 1.1 高优先级

| # | 问题 | 证据 | 类别 |
|---|------|------|------|
| H1 | **assistant 回述反馈回路**：注入消息被 `source.plugin` 过滤 ✓，但 assistant 对注入内容的**回述/改写会被再提取**成新记忆（"根据记忆 #abc…"） | extract.ts:68-80（只滤 user/message）；injector.ts:114 | 腐化 |
| H2 | **会话键 Map 泄漏**：extractor 的 `lastSeq/pending/chains`、injector 的 `pendingIds/injectedSeqs` 以 session.id 为键**从不清理**，不监听 agent/disposed；全局挂载下每个会话泄漏两条 Map 条目 | extractor.ts:55-59；injector.ts:59-61 | 生命周期 |
| H3 | **update 改 content 导致 dedupKey 索引漂移**：`{...current,...patch}` 直接覆盖 content 但不重算 dedupKey、不更新 byDedupKey | store.ts:146-157 | 正确性 |
| H4 | **装配失败无可见性**：`void mountMemory(...)` 丢弃 rejection，存储初始化失败时整插件静默失效 | index.ts:34 | 生命周期 |
| H5 | **增量提取摘录无上限**：batch.text 整包喂给 maxTokens=2048 的 LLM（无上限 → 质量下降 + token 成本） | extractor.ts:119-137；extract.ts:68-80 | 腐化/成本 |
| H6 | **归档条目被去重合并吞新信息**：create 命中 archived 条目时合并进归档（新内容不可见，检索不到） | store.ts:92-113（existing 未检查 status） | 腐化 |
| H7 | **同内容跨 kind 错误合并**：dedupKey 不含 kind，同一句先后记为 fact/todo 会错误合一，新 kind/tags/excerpt 丢失 | store.ts:98-101；types.ts:139 | 腐化 |
| H8 | **未达阈值批次会话结束时永失**：pending 批次无 flush，会话销毁即丢失 | extractor.ts:127-137 | 数据丢失 |

### 1.2 中优先级

| # | 问题 | 证据 |
|---|------|------|
| M1 | restore/hardDelete 无生产调用点；`deleted` 状态永不可达；store.ts:189 注释宣称的"工具层约束"不存在 | store.ts:175,190；tools.ts:322；host-rpc.ts:46-50 |
| M2 | 提取 prompt 缺"不提 meta/总结/来自记忆#"排除规则 → 级联失真（summary→insight→注入→回述→再提取） | extract.ts:28-46；snapshot.ts:42-63 |
| M3 | 提取/注入不传播取消信号（runExtraction 的 signal 参数存在但调用处不传） | extractor.ts:148-150；extract.ts:141 |
| M4 | 客户端 inject 双声明不一致（client.ts `['slots','connection']` vs package.json `dsh.client.inject: []`）+ slots 缺失时面板静默消失 | client.ts:19,91；package.json:22 |
| M5 | RPC `status` 死端点（client 无消费）+ payload 被忽略违背"严格校验"注解 | host-rpc.ts:50,82-90 |
| M6 | config 双写默认值（schema default 与 index.ts `?? 默认值` 漂移风险；schema 加载即填充时 `??` 为死分支） | config.ts:37-44；index.ts:49-61 |
| M7 | 访问追踪写放大：每次 search 命中 topK 条 fire-and-forget 落盘（pre-step 每步最多 8 次持久化写） | store.ts:247-257 |
| M8 | 注入查询文本含工具结果噪声（textOfBatch 取批次全部文本，工具输出淹没关键词） | injector.ts:142-148 |
| M9 | 旧决策 vs 新决策无裁决语义（无 supersede/覆盖表达；仅时间衰减+手动 archive） | store.ts:11（合并保留先入内容） |
| M10 | client openDetail 无请求序号守卫（快速切换条目时旧响应覆盖） | client.ts:141-147 |
| M11 | 快照 catch+warn 合理（异步事件处理器必须自收容 rejection）但故障路径零测试、无重试无升级 | snapshot.ts:60-62,86-88 |
| M12 | 枚举三处双声明漂移风险（types.ts 与 memory-domain.ts zod schema） | types.ts:16-26；memory-domain.ts:17,35 |

### 1.3 低优先级（清理项）

| # | 问题 | 证据 |
|---|------|------|
| L1 | 死代码：`StreamChunk` 死导入；`AuditAction 'inject'` 预留未写；`SearchOptions.includeArchived` 无调用点；`MemoryStatus 'deleted'` 永不被写 | extract.ts:20；types.ts:23；store.ts:47 |
| L2 | createdAt 同毫秒排序不稳定（localeCompare 无 tie-breaker） | store.ts:234,267 |
| L3 | byDedupKey 跨 workspace 索引不确定（有 workspace 校验兜底） | store.ts:74 |
| L4 | tools.ts 464 行、formatMemoryLine 的 `as unknown as MemoryEntry` 绕行 | tools.ts:123-133 |
| L5 | store 层 `console.warn` 非 logger 通道 | store.ts:255 |
| L6 | tsconfig 全包统一 lib DOM（宿主半区被放大类型面） | tsconfig.json:6 |
| L7 | 注入回填竞态（pendingIds 未回填前连续两步可能重复注入）；pendingIds 多批错挂风险 | injector.ts:105-121 |

### 1.4 测试体系缺口（子系统 D 详报）

- **types.ts / config.ts / index.ts 完全无测试**：去重键规范化（dedupKeyOf 空白/大小写折叠）从未断言；16384 预算默认、inject 声明、400K 键移除三个历史修复点**无回归测试**；
- **异步竞态未测**：extractor 串行链从未"堆积"（全部测试顺序 await）；injector pendingIds 累积态未测；
- **条件断言静默跳过**：injector/host-rpc 大量 `if (kind==='enter')`/`if (ok)` 守卫，失败路径下测试可无断言通过；
- **FakeTable 契约失真**：live Map 迭代 vs 真实快照迭代、无写链串行、无持久化失败回滚、无事件发射；`.keys()/.size` 实现但 src 未用；
- **tools 6 个 render 纯函数全未测**；`workspaceOf` 缺 agent 回退未测；zod schema 校验零覆盖；`runExtraction` error finish 分支未测。

## 2. 上下文腐化专项分析（论文对照）

| 腐化向量 | 项目现状 | 论文依据 | 本计划对策 |
|---------|---------|---------|-----------|
| 矛盾/过期记忆 | 无 supersede 语义；旧决策与新决策同时注入 | STALE（隐性冲突，最佳模型仅 55.2%）；Memory Write Policies（2026 收敛：写时不做裁决、写新事实+后向引用、读时重排）；TOKI（裁决谱系） | O8 决策点（读时裁决 vs 后向引用标记），O3 合并粒度修正 |
| 抽象失控（级联失真） | compaction summary(LLM)→insight→注入→回述→再提取 | Useful Memories Become Faulty（GPT-5.4 整合后同题失败率 46%；原始 episode 一等证据、抽象应选择性/延迟/锚定轨迹） | O1：prompt meta 排除 + 回述回路 + 摘要登记节制 |
| 错误传播/经验跟随 | 记忆只增不删（手动 archive 之外无淘汰） | Memory Management Impacts（选择性添加+删除比朴素增长 +10% 绝对性能） | O8 决策点（选择性遗忘），O3 合并修正减少污染源 |
| 注入噪声/注意力稀释 | minScore 0.15 过滤 + 预算截断 ✓；但查询文本含工具结果 | Distracting Memory is Harmful（表面相似错误内容严重误导）；RAG Robust（NLI 过滤） | O5：查询文本清洗；O3 合并修正 |
| 信息丢失 | 归档条目吞新信息（H6）；excerpt 不合并（H7） | 溯源锚定（excerpt+eventSeqs 已实现，属项目优势） | O3 修复 |
| 记忆膨胀 | 无上限、近义不合并（已知限制） | 智能衰减（recency×relevance×utility 复合分） | O8 决策点 |

## 3. 实施阶段（每阶段独立验收 + git 提交）

### O1 腐化防线修复（最高优先）

**目标**：斩断三条腐化链（回述回路、级联失真、批次丢失）。

1. **提取 prompt 强化**（extract.ts:28-46）：
   - 新增规则："忽略会话摘要/总结性内容、'来自记忆#xxx'的引用、'参考记忆'包裹的文本——这些不是原始对话事实"；
   - 新增规则："保持具体：保留时间、数值、标识符与限定条件；禁止把多条具体事实概括为一句抽象结论"（依据：Faulty Memories——抽象应延迟且锚定原始轨迹）；
   - 新增规则："识别状态变化：若摘录显示既有事实已被更新/推翻（如'改用 X 替代 Y'），按新状态提取并标注'更新了此前认知'"。
2. **回述回路**（extract.ts:68-80）：
   - 先验证：`source.plugin` 是否透传进会话日志（查 dsh-session 日志规范；若透传则 assistant 消息也可按插件来源过滤——**待验证项 V1**）；
   - 无论透传与否，prompt 排除规则（1）兜底 assistant 回述；
   - renderEventsText 增加过滤：跳过 content 以 `[参考记忆]` 开头的段落（注入消息的文本标记，双保险）。
3. **batch.text 上限**（extractor.ts:119-137 + config.ts）：
   - 新增配置 `maxExtractChars`（默认 12000 字符 ≈ 3K token，低于 extractMaxTokens 2048×4 的可用空间）；
   - 超限时取**最新** N 字符（截头保尾——近期信息优先），并记录 truncation 审计于 extractor 日志；
   - 不拆分多轮（KISS：单次提取取尾部窗口）。
4. **pending 批次 flush**（extractor.ts + snapshot 模式复用）：
   - 监听 `agent/disposed`：若该会话存在未达阈值的 pending 批次，直接触发提取（不再等阈值）后清理；
   - 同时清理该会话的全部键（见 O2，合并实现）。
5. **测试**（先写失败测试）：
   - `extract prompt 不含 meta 规则时回述文本可提取 → 含规则后跳过`（直接测 renderEventsText 的段落过滤 + prompt 文本断言）；
   - `batch.text 超 maxExtractChars 截尾保留`；
   - `agent/disposed 触发 pending flush`；
   - `归档条目合并守卫`（H6，见 O3 但测试先立）。

**验收**：新测试全绿；renderEventsText 对含 `[参考记忆]` 段落的输入输出为空；prompt 含三条新规则断言。

### O2 生命周期与错误可见性

**目标**：内存零泄漏、装配失败必见。

1. **agent/disposed 统一清理**（新增 `src/lifecycle.ts` 或并入 snapshot.ts）：
   - extractor：`lastSeq/pending/chains` 三 Map delete；
   - injector：`pendingIds/injectedSeqs` 两 Map delete；
   - 注册一个 `agent/disposed` 监听器集中处理（与 snapshot 的 recordSessionEnd 并存，互不干扰）。
2. **装配失败可见**（index.ts:34）：
   - `mountMemory` 改为显式错误传播：`mountMemory(...).catch(error => logger.error('记忆插件装配失败：', error))`；
   - 装配失败不再静默：日志错误级别 + 工具/RPC 不注册（现状已是：失败即不注册，但无可见性）。
3. **取消信号传播**（extractor.ts:148-150）：
   - `extractAndStore` 传入会话级 AbortSignal：取 `agent.cancel`（Agent 接口的取消 cause）构造 signal；不可得时用无信号（保持现状）；
   - runExtraction 已支持 signal（extract.ts:163），仅接线。
4. **测试**：`agent/disposed 清理五张 Map`（构造会话、注入 pending、dispose、断言空）；`mountMemory 失败日志`（装配测试需 Cordis ctx——以可注入失败工厂的方式测）。

**验收**：disposed 后各 Map size 为 0；装配失败时 logger.error 调用一次。

### O3 存储正确性

**目标**：去重合并语义无信息丢失、索引无漂移。

1. **update 白名单剔除 content**（store.ts:146）：`update` 只允许 `kind/importance/tags` 变更；content 变更走 create（新条目）或明确的重建路径（当前无调用点，直接收紧签名；若未来需要改内容，另设计）。同时删除"重算 dedupKey"复杂性（KISS：不允许改 content 就没有漂移）。
2. **合并粒度加 kind**（store.ts:89-114）：`byDedupKey` 索引键改为 `workspace::kind::dedupKey`；同内容不同 kind 不再合并（各自成条）。
3. **归档条目不参与合并**（store.ts:92-94）：existing.status === 'archived' 时跳过合并 → 新建条目（新信息可见）；合并时 `source.excerpt` 取新来源（信息更新而非丢弃）。
4. **排序 tie-breaker**（store.ts:234,267）：`createdAt` 相同时按 `id` 稳定排序。
5. **byDedupKey 带 workspace**（与 2 合并实现，索引键 `workspace::kind::dedupKey`）。
6. **测试**：`update 拒绝 content 变更`（编译级 + 运行级）；`同内容跨 kind 不合并`；`归档条目不吞新信息`；`同毫秒排序稳定`；`excerpt 更新为新来源`。

**验收**：上述五条新测试全绿；原 87 测试不回归（store.test 中 update 改 content 的用例需改写为断言拒绝）。

### O4 接口收敛（YAGNI）

**目标**：无死方法、无死状态、无死端点、无双写。

1. **restore/hardDelete 决策**（需用户裁决，见 §4）：默认建议——删除 `restore`/`hardDelete`/`deleted` 状态（无调用点，YAGNI；archive 已满足"忘记"语义）；若用户要"恢复"能力，补 RPC `restore` 端点 + 面板按钮（不补模型工具——模型不该有恢复权力，OWASP 保守立场）。
2. **RPC status 端点**：client 补 `status()` 方法并展示（统计行）或删除端点；建议**补消费**（面板顶部显示记忆统计，低成本高可见）。
3. **死代码清理**：`StreamChunk` 导入、`AuditAction 'inject'`、`includeArchived`、`MemoryStatus 'deleted'`（若 1 通过）、`memoryScore` 包装层（store 直接用 scoreEntry）。
4. **config 单源默认值**（M6）：删除 index.ts 中 `?? 默认值` 的冗余分支（schemastery 加载即填充——**待验证项 V2**：确认 loader 对组合行 config 的解析是否经 schemastery default 填充；若确认则 index.ts 直接读字段）。
5. **枚举单源**（M12）：types.ts 导出 `MEMORY_KINDS/MEMORY_STATUSES/AUDIT_ACTIONS` 常量数组，memory-domain.ts zod 从常量派生（`z.enum(...)` 或 `.refine`）。
6. **测试**：`RPC status 返回统计并被 client 消费`；`config 无传时默认值生效且 index 无死分支`（经导出常量断言）。

**验收**：grep 确认无死导出；config 默认值仅存一处；zod 拒绝非法枚举（新增测试）。

### O5 客户端与注入质量

**目标**：客户端注入一致性、面板无竞态、注入查询无噪声。

1. **inject 对齐**（M4）：核实客户端加载器以哪套 inject 为准（**待验证项 V3**：dsh.client.inject vs client.ts 导出 inject）；统一为 client.ts 的 `['slots','connection']`（并把 package.json 同步）；slots 缺失时不再静默——logger.warn 一次（若加载器提供 console）或保留静默但文档明示（低影响，随 V3 结果定）。
2. **openDetail 竞态守卫**（client.ts:141-147）：自增请求序号，响应回来时序号不匹配则丢弃。
3. **注入查询文本清洗**（injector.ts:142-148）：textOfBatch 只取**用户消息**文本（payload 中区分 user/assistant/tool 块——**待验证项 V4**：pre-step payload.messages 的块类型语义），排除工具结果块。
4. **测试**：`createMemoryApi`（RPC 客户端逻辑，可注入假 connection）；`openDetail 竞态`（组件级，若可行）。

**验收**：client 可单测部分有测试；竞态修复后快速切换不覆盖。

### O6 性能（访问追踪）

**目标**：消除每步最多 8 次持久化写的写放大。

1. **节流**（store.ts:247-257）：访问追踪合并为"每会话每记忆最多每 60s 一次"（内存 Map `lastTrackedAt`，到期才落盘；会话清理随 O2）；或降级为"仅在注入路径计数、浏览路径不计数"——选**节流**（语义完整）。
2. **测试**：`60s 内重复命中只写一次`（注入固定时钟）。

**验收**：节流生效；原访问计数测试适配。

### O7 测试加固（防回归）

**目标**：补全体系缺口（子代理 D 详报），全部先写失败测试。

1. **types.ts 测试**（新增 types.test.ts）：`normalizeContent` 空白/大小写折叠、`dedupKeyOf` 同键/异键、`fnv1a` 确定性、`newMemoryId` 唯一性。
2. **config.ts 测试**（新增 config.test.ts）：默认值落位（16384/8/0.15/2000/2048/true/true）、未知键拒绝、**400K 键不在 schema**（历史迁移防回归）。
3. **index.ts 装配测试**（新增 index.test.ts）：inject 声明含四服务、mountMemory 顺序（可注入假 ctx）。
4. **竞态测试**：extractor 串行链并发入队（不 await 连续两事件 → settle → 断言处理两次且水位按序）；injector pendingIds 累积态。
5. **条件断言去守卫**（injector.test.ts:117-135、host-rpc.test.ts:49-97）：失败路径改为无条件断言（`expect(decision.kind).toBe('enter')` 先行）。
6. **FakeTable 快照保真**（helpers.ts）：`entries()/keys()` 改为快照数组返回（对齐真实契约）；新增 `failNextWrite` 钩子模拟持久化失败（测 byDedupKey 原子性）。
7. **tools render 测试**：6 个 render 纯函数直接测（构造规范值断言输出文本）。
8. **zod schema 测试**：memoryEntrySchema 拒绝非法 kind/status。
9. **runExtraction error finish 分支**。
10. **防回归三件套**：16384 默认、inject 声明、400K 键拒绝（含 1-2 已覆盖）。

**验收**：新增测试全部通过；原 87 测试改造后全绿；覆盖率显著提升（目标：src 函数级 ≥85% 关键路径）。

### O8 演进决策点（已裁决 2026-08-15，含具体实现细节）

| 决策点 | 裁决 | 实现落点 |
|--------|------|---------|
| D-A 矛盾裁决 | **后向引用标记**：新事实写入时给同类旧事实打 `superseded` 后向引用，检索时排除被覆盖条目 | 并入 **O3**（存储域） |
| D-B 记忆整理 | **后台整理任务**（用户选择，非自动降级） | 新增 **O8-M 阶段**（独立实现，依赖 D-A 标记数据） |
| D-C 提取质量 | **规则门**：prompt 强化 + 轻量规则校验（标识符保留率/长度下限） | 并入 **O1**（腐化防线） |
| D-D restore 入口 | **删除** `restore`/`hardDelete`/`deleted` 状态（YAGNI；归档后需恢复时重建记忆，审计可溯源） | 并入 **O4**（接口收敛） |

#### D-A 后向引用标记（并入 O3 的实现细节）

- `MemoryEntry` 新增可选字段 `supersededBy?: string`（被哪条记忆覆盖）与 `supersedes?: string`（覆盖了谁，双向可查）；
- 写入裁决（`store.create`，纯规则零 LLM）：
  1. 命中同 workspace 同 kind 且 dedupKey 相同的 → 既有合并逻辑（保留）；
  2. 新增 `supersedeCandidates(workspace, kind, content)`：同 workspace 同 kind 的 active 条目中，与 content **关键词重合度 ≥ 0.7**（复用 scoring.tokenize 的 Jaccard）且**创建时间早于新条目** → 标记 `supersededBy = newId`；
  3. 被标记条目的 `status` 不变（仍 active，可被 audit 追问），仅检索/注入时**默认排除** `supersededBy !== undefined` 的条目；
- 检索侧：`search`/`listRecent`/注入路径默认过滤 `supersededBy` 非空条目；`memory_search` 提供 `includeSuperseded: true` 选项供审计；
- 追溯：被覆盖条目的 audit 追加 `{ action: 'supersede', detail: '被记忆 #xxx 覆盖' }`；`memory_audit` 展示 superseded 链；
- 手动覆盖：`memory_note` 写"改用 X"类内容时同一规则生效（模型显式记录的新决策自然覆盖旧决策）；
- 测试：`新决策覆盖旧决策（关键词重合≥0.7）`、`重合度不足不覆盖`、`检索默认排除被覆盖条目`、`includeSuperseded 可见`、`supersede 链审计`。

#### D-B 后台整理任务（O8-M 阶段实现细节）

- **目标**：定期回顾记忆库，合并重复、复核 supersede 标记、整理标签——对抗记忆膨胀与陈旧（论文：经验跟随/选择性删除 +10%；mc dreamer 同构）。
- **触发**：进程内定时器，`maintenanceIntervalHours` 配置（默认 6 小时）+ 仅在**本进程有活跃会话事件后**才启动计时（无活动不跑，省成本）；运行窗口内按批次推进，可被会话事件打断（让出主循环）。
- **执行者**：复用当前模型路由（与提取器一致，`resolveRoute` 从最近会话取；无路由则跳过本批）。
- **每批任务集**（最小完备集，KISS）：
  1. **合并重复**：同 workspace 同 kind 内，tokenize Jaccard ≥ 0.85 且重要度差距 ≤ 2 的条目对 → 保留新者（内容+高重要度+并集 eventSeqs），旧者 archive + 审计 `merge`；
  2. **复核 supersede**：被 D-A 标记的条目中，若 supersededBy 条目已 archived → 解除标记（恢复可见，防误杀）；
  3. **过期降级**：`updatedAt` 超 90 天 + `accessCount` 为 0 + 重要度 ≤ 3 的条目 → 自动 archive + 审计 `archive`（reason: stale）；
  4. **标签整理**：同 workspace 内标签同义合并（精确匹配小写化后相同才合并，不做语义推断——防误合并）。
- **批次预算**：每批最多 20 条候选 / 一次 LLM 调用（合并裁决经 LLM 输出严格 JSON，与提取同解析模式）；超时 60s 中断。
- **并发与失败**：与提取器串行链**独立**（互不依赖）；store 写链天然串行；失败 warn + 下批重试（水位式推进，不无限重试同一候选）。
- **开关**：`enableMaintenance: true` 默认开（低频低成本）；`maintenanceIntervalHours: 6`。
- **测试**：`定时触发与活动门`、`合并重复对（≥0.85）`、`supersede 复核解除`、`过期降级条件`、`标签精确合并`、`LLM 解析失败收容`、`批预算截断`。

## 4. 待验证项（实施前必须查证，禁止猜测）

- V1：`source.plugin` 是否透传进会话日志（决定回述回路修复的过滤强度；查 dsh-session 日志规范与 user/message 事件载荷）；
- V2：组合行 config 经 schemastery 加载时是否填充 default（决定 config 单源方案）；
- V3：客户端加载器以 dsh.client.inject 还是 client.ts 导出 inject 为准（决定 inject 对齐方向）；
- V4：agent/pre-step payload.messages 的块类型语义（user/assistant/tool 如何区分，决定查询文本清洗）。

## 5. 执行顺序与依赖

```
O1（腐化防线，含 D-C 规则门）→ O2（生命周期）→ O3（存储，含 D-A 后向引用）
→ O4（接口收敛，含 D-D 删除）→ O5（客户端）→ O6（性能）→ O7（测试加固）
→ O8-M（后台整理任务，依赖 D-A 标记数据，最后实现）
每阶段：先写失败测试 → 实现 → 全量测试 → git 提交（feat/fix/test 语义）
```

## 5.1 实施记录（2026-08-15 全部完成，162 测试全绿）

| 阶段 | 提交 | 要点 |
|------|------|------|
| 地基 | 79564d9 | 枚举单源、DEFAULTS 常量、D-D 删除、归档守卫；V1-V4 查证完成 |
| O1+O2 | 96492bb | prompt 三规则、回述双层过滤、摘录上限、批次 flush、Map 清理、装配可见、M8 查询清洗 |
| O8-M | 15da3b7 | maintenance.ts：活动门、批预算 20、三任务纯规则；supersede 复核裁剪（store 域限制） |
| O3+D-A+O6 | 0b7a94e | update 白名单、合并粒度加 kind、supersededBy 后向引用、tie-breaker、访问节流 |
| O4+O5 | 18ab29a | status 消费、inject 对齐、竞态守卫、短 id 使用点 |
| O7 | d5ac162 | FakeTable 快照保真、条件断言去守卫、串行链竞态测试 |

未决项（记录在 STATUS.md 风险节）：supersede 复核需 store 专用方法；LLM 合并裁决留待未来；部署副本需 `pnpm install` 刷新。

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 提取 prompt 规则强化后提取量骤减（过度抑制） | prompt 规则只排除"明确标记的元内容"；O7 用现有会话样本回归 |
| 合并粒度加 kind 后记忆库重复条目增加 | 近义去重本就不支持（已知限制）；kind 分层是正确性优先 |
| config 单源依赖 V2 结论 | V2 未确认前保留双写并加一致性测试 |
| 访问追踪节流改变访问计数语义 | 计数语义为"近似的活跃度信号"，节流不改变注入行为 |
| 测试改造（去条件断言）暴露既有静默失败 | 正是目的：改造过程中修复暴露的真实缺陷，逐项记录 |

## 7. 交付物

- 每阶段：代码 + 测试 + 提交（`fix(dsh-memory): ...` / `test(dsh-memory): ...` / `refactor(dsh-memory): ...`）
- 本计划文档随阶段实施更新（勾选完成项、记录裁决结果）
- 收尾：STATUS.md 更新

## 参考来源

- 论文：STALE (arXiv:2605.06527)；Useful Memories Become Faulty (arXiv:2605.12978)；Memory Management Impacts LLM Agents (arXiv:2505.16067)；Memory Management and Contextual Consistency (arXiv:2509.25250)；MemoryAgentBench (arXiv:2507.05257)；TOKI (arXiv:2606.06240)；Reflective Memory Management (ACL 2025)；Distracting Memory is Harmful (arXiv:2606.25361)
- 工程实践：Memory Write Policies (jatinbansal.com/ai-engineering/memory-write-policies/)；Letta MemFS；magic-context CONFIGURATION.md
- 审查证据：4 个并行子代理报告（本会话）+ 主代理逐文件复核（store/injector/extract/extractor/types/config/tools 全文）
