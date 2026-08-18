# dsh-memory 生产环境可用性验证报告（2026-08-18）

> 验证方式：只读取证（宿主目录/配置/进程/DB/部署包）+ 只读线上 GUI 实机探针。除面板一次检索触发的 accessCcount 回写外，未对生产做任何写操作；未改任何生产文件、未重启宿主、未保存配置。
> 上层结论先行：**生产宿主运行健康、核心链路可用，但 ① 部署的是陈旧构建（缺 WP1 起全部风险修复，Q5 已修缺陷在产仍存在）；② 语义向量索引仅覆盖 ~9% 老条目——生产语义检索实际近乎不可用；③ 反思/因果/维护产出≈0。**

---

## 一、验证对象与范围

| 项目 | 值 |
|---|---|
| 宿主 | `@deepseek-ai/dsh` `bin.js web`（PID 22644，2026-08-18 12:26 启动），GUI `http://127.0.0.1:3080` |
| 部署插件 | `C:\Users\WenYu\.dsh\profiles\web\node_modules\@echocore\dsh-memory`（pnpm store 符号链接） |
| 生产库 | `~/.dsh/storages/memory.sqlite` 29MB（WAL 活跃、今日仍在写）；`memory.json.bak` 11.8MB（迁移已完成） |
| 生产配置 | `settings.yaml` → memory: `embeddingBaseUrl=阿里云MaaS-compatible / model=qwen3.7-text-embedding / dimension=2560 / key=env:BAILIAN_API_KEY` |
| 对照基线 | 仓库最新（485 测试全绿、typecheck 0、覆盖率 Stmts93.9/Branch90.8） |

验证面：插件装配、GUI 面板、面板检索链路、存储健康、提取写入、去重/supersede、归档、语义索引、反思/因果/维护、嵌入状态与密钥解析、部署版本一致性。

## 二、逐功能域可用性判定

| 功能域 | 判定 | 证据 |
|---|---|---|
| 插件装配/加载 | ✅ 可用 | 宿主 12:26 启动无 fatal 证据（DB 今日持续写入、面板可渲染）；GUI「设置→记忆」面板加载成功 |
| 面板（client slots） | ✅ 可用 | GitHub 3080 实测：设置→记忆页正常渲染，搜索框/分类/工作区下拉/配置区齐全 |
| 面板检索链路（UI→工具→store→展示） | ✅ 可用 | 实测输入“prompt-builder QC 一致性”点搜索 → 50 条命中，首条即高度相关（F2 契约漂移/QC 死引用） |
| 嵌入就绪性 | ✅ 可用 | 面板实测「嵌入状态：ready（后端：remote）」；配置区「远程 API Key 状态：已解析可用」（历史“ready 但远程未生效”在生产不复发） |
| 远程嵌入维度一致性 | ✅（声明侧）| 配置 2560，表 `vec_memory_2560` + 全套影子表存在（对齐）；0 坏 JSON |
| 存储健康 | ✅ | DB 只读审计：entries 7256→7318（并发写中）、0 坏 JSON、WAL/shm 正常、migration 完成（.bak 在） |
| 提取/写入 | ✅ | 全 5 类 kind 均有量；今日 04:36 持续新增（fact 5297 / insight 924 / decision 543 / todo 324 / preference 168） |
| create 去重（同内容合并） | ✅ | 7256 中 468 条被 supersede（去重链工作） |
| 归档 | ⚠️ 低活跃 | 仅 3 条 archived（反映反思/维护层面产出生生 ≈0，见下） |
| 关键词检索 | ✅ | 面板检索命中正常（关键词榜独立工作） |
| 语义检索（语义榜） | ❌ 近乎不可用 | 见「三、关键异常 ②」：向量仅覆盖 8-15 08:16 前 ~750 条（9%），语义榜实际只能命中极小旧子集 |
| 反思（LLM 语义盲区） | ⚠️ 产出≈0 | 无进程内观测点；但 archived=3 + maintenance/reflect 无可见产物（语义索引侧面印证重构未跑全） |
| 因果链 | ❌ 产出 0 | `memory_causal_edges` 表 0 行——因果建边在生产从未产出 |
| 维护（合并/老化/标签） | ⚠️ 未观测到效果 | 库中 468 superseded 偏“create 去重”驱动；维护批无独立证据 |
| 配置持久化 | ✅ | settings.yaml memory 段与面板配置区一致（baseURL/model/dim=2560/key env 引用） |
| **部署版本与最新代码一致性** | ❌ **陈旧** | 见「三、关键异常 ①」 |

## 三、关键异常（决定性取证）

### ① 部署的是陈旧构建（缺 WP1 起全部风险修复）
部署 `lib/*.js` 时间戳 2026-08-17 20:41；对照标记检索（grep 部署 lib）：
- ❌ 无 `runtimeDegraded` / `embeddingDegradedReason`（WP1 跨维降级观测面）
- ❌ 无 `dropOtherDimensionTables` / 迁移维度校验（Q2）
- ❌ 无 `migrateAll`（Q4 迁移单事务）
- ❌ 无 `reflectionCumulative` / `effectiveImportance` / `exposeStore`（C10/C13/C9）
- ✅ `tools.js:280` 仍是 `mergedWithId: result.outcome.merged ? result.outcome.existingId : undefined` —— **Q5 已修的 lossless-JSON 缺陷在生产仍存在**（memory_note 未合并时输出会被宿主拦截、工具误报失败）
- `maintenance.js` 含一个 WP6a 标记（待精确匹配，但不改总体结论）

结论：**485 测试验证的是仓库最新代码；生产运行的是更早构建**——本轮之前的修复（跨维降级显式化、旧表 DROP、迁移事务化、EACCES、settings 回滚、onCreate 收容、lossless 修复等）**均不在生产生效**。

### ② 语义向量索引近乎冻结（覆盖 ~9% 老条目）
只读审计 `vec_memory_2560_rowids`（704 向量，全 active）：
- 按 rowid 分桶：`[1-500] vec=464 / [501-1000] vec=240 / [1001-7318] vec=0`
- 向量创建时间全落在 **2026-08-15 04:11 ~ 08:16**（库首日的约 4 小时内）
- 其后 6600+ 条（含最近三日全部新记忆）**零向量**；向量计数在验证期间略增长（646→704），说明宿主仅在极低速补少量。

影响：RRF 语义榜实际上只能命中首日 ~750 条的极小子集；**最近记忆的召回完全依赖关键词榜**——语义增强检索在生产等于虚设。

### ③ 反思/因果/维护产出≈0
- `memory_causal_edges` = 0 行（因果建边零产出）
- archived 仅 3（反思/矛盾归档未发生；可能与陈旧构建+未触发 LLM 反思有关，或从未显式运行 memory_reflect）

## 四、输入侧确认
- `~/.dsh/settings.yaml` memory 段与面板一致；`embeddingDimension: 2560` 符合 schema（`z.number().min(1)` → 合法）。
- 嵌入密钥 `env:BAILIAN_API_KEY` 在宿主侧**已解析可用**（面板断言）；本地 shell 的 `$env:BAILIAN_API_KEY` 为空属正常（密钥由宿主进程注入，非我的 shell 环境）——已交由宿主子代理进一步核实注入链。

## 五、残余风险与建议（按优先级）

1. **【高】热更生产到最新代码**：重建 `lib`（`pnpm build`）+ 让 profile 指向最新（pnpm 重装 file 依赖 → 新 store 快照）+ 重启 `dsh web`。**这是破坏性/会话中断操作，需用户拍板**（影响当前运行中会话与其它项目会话）。
2. **【高】补齐语义索引**：最新构建下 `ensureAll` 会一次补齐缺失向量（约 6600 条 × 2560 维远程嵌入，成本/时间需预算：约 52 批 × BATCH 请求，可能数分钟-数十分钟 + API 花费；或考虑默认降本策略，需拍板）。
3. **【中】因果/反思全链路验证**：最新构建 + 手动触发 `memory_reflect` 后复查 `memory_causal_edges` 与 archived 是否产生。
4. **【低】部署闭环制度化**：改动→`pnpm build`→重装→重启的 repo 内脚本/文档（生产重启需用户确认）。
5. **【中】向量覆盖监控**：status 增加“向量覆盖/总数”观测（当前 9%），避免“ready 但语义虚设”再次静默。

## 六、证据清单
- 宿主：`Get-Process`（PID 22644 `@deepseek-ai/dsh/lib/bin.js web`）+ `Get-CimInstance` 命令行
- 配置：`~/.dsh/settings.yaml` memory 段；面板配置区读数（baseURL/model/2560/“已解析可用”）
- 部署包：`profiles/web/node_modules/@echocore/dsh-memory/lib/*.js` 时间戳 + 标记 grep 结果
- 数据层：只读 `node:sqlite` 脚本输出（表结构/7256→7318 行/0 坏 JSON/468 superseded/3 archived/kinds 分布/向量分桶/因果 0）
- GUI：3080「设置→记忆」面板快照（共 7305 条/7302 活跃；嵌入 ready+remote；检索 50 命中）

## 七、待补充（背景取证子代理回流后并入）
- 宿主日志有无插件报错（嵌入批次失败/未处理拒绝）→ 用于界定③根因
- 密钥 `env:BAILIAN_API_KEY` 注入链确认
- 网络权威实践对照（SQLite/向量一致性审计、热更部署、嵌入就绪探测）
