# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-17（全面风险审查 + 六大优化工作包落地，用户拍板 Q1-Q7 全部推荐项）。

## 一、架构健康度

- 模块总数：22 源模块 + client 面板（本轮无新增模块；新增工程资产 `.github/workflows/ci.yml`）
- 依赖方向：`index.ts`（组合根）→ 各模块，无环；`reflect/causal` 仅被 index/tools/maintenance（结构类型）引用；`settings` 仅被 index 引用。新增/变更依赖：无新增包；`@photostructure/sqlite-vec` 由 `^1.2.0` 锁精确 `1.2.0`（防 npm 解析漂移）
- 单元测试 **472 个全绿**（25 文件，typecheck 干净；较上轮 441 +31）
- INFRA：新增 CI workflow（push/PR → install --frozen-lockfile → typecheck → test）；迁移单事务化；坏 SQLite 逐行容错；真 SQLite 集成测试补入（node:sqlite :memory:）
- 本轮实现均为 TDD（先写失败测试→实现→绿），每工作包独立提交（7 个 commit）

## 二、本次变更影响范围（全面风险审查 → 六大优化工作包）

**审查（8 并行子代理 + 2 网络调研 + 主代理交叉校验）**：P0 维度漂移/未处理拒绝、P1 迁移非事务/坏 SQLite 无降级/嵌入迁移无维度校验/字符预算失衡、P2 若干（重入互斥/窗口冗余/superseded 漏查/settings 状态漂移/EACCES 吞错/dead code/README 过时）。注入器键空间 agent.id/session.id 混用**经查 DSH 硬保证恒等（dsh-agent lib: 不匹配即 throw）→ 判为可读性改进非 bug**（诚实纠偏子代理高判）。

- **WP1（Q1/A + Q2/A + Q6②③⑫，最高危）**：
  - `embedding.ts`：**禁止跨维运行期降级**——运行期远程故障仅在本地维度==远程维度（384==384）时切本地顶班；跨维则**一次性显式降级** disabled + `runtimeDegraded`（可观测原因"已降级为关键词，需重新保存配置重建索引"），`backendLabel` 显示 `remote(运行期降级)`；消除"降级后索引维度错乱 → KNN 抛裸错 / onCreate 未处理拒绝 exit(1) 杀进程"（DSH installFailLoud 已实查）。
  - `index.ts`：**onCreate 索引联动 catch**（与 onArchive/onSupersede 同收容形态，附效果失败不 kill 主链路）；经 `embeddingDegradedReason` runtime getter 透出状态；迁移语义修正——**全坏/全跳过不 rename .bak**（保留原文件可修复重试）。
  - `embed-index.ts`：**loadLegacy 迁移按表维度校验**（错误维度向量跳过 + logWarn）；**dropOtherDimensionTables**（仅 DROP 纯维度表 `vec_memory_<digits>`，跳过 vec0 影子表 `_info/_rowid` 等——实测"may not be dropped"）。
  - `host-rpc.ts`/`tools.ts`：status 透传 `embeddingDegradedReason`；setConfig **持久化成功/生效失败中间态显式化**（"已保存、重启后自动生效"，非静默"保存失败"）。
- **WP4（Q4/A + Q6①）**：坏 SQLite 构造加载**逐行容错**（坏 value 行跳过 + `loadFailures` 计数 + warn，与坏 JSON D2 对称）；`migrateMemoryJson` **单事务化**（`migrateAll`：BEGIN→prepared upsert→COMMIT/ROLLBACK；cache 在 COMMIT 后一次性回填——中断保持空态可重试）。
- **WP6a（Q6④⑤⑥⑦）**：maintenance/reflect/causal 三处 `runOnce` **重入互斥**（并发合并为同一 promise，防重复审计/重复 LLM）；`CANDIDATE_WINDOW` 解耦（1000 vs BATCH_BUDGET 200，预算真实生效）；`archiveStale`/`normalizeTags` 补查 `supersededBy`；`selectReflectionPairs` **peer 仅限同 workspace**（跨域不喂 LLM）。
- **WP6b（Q6⑧⑩⑪）**：`applyConfigChange` 失败回滚 `active`（修复幂等门拦死自愈）；删除 `renderPack` 生产死代码；根 README 存储/备份描述修正。
- **WP7 / WP5**：真 SQLite 集成测试补强 + `failNextWrite` 覆盖 create/put + 弱断言修正 + `listByImportance/tokenJaccard/formatMemoryLineCondensed` 覆盖补盲；CI workflow + sqlite-vec 锁精确版本。
- **Q3/Q6⑨（补全）**：注入/快照预算注释**诚实化**（字符口径：中文 16384 字符≈16K token，不再写"≈4K token"误导）；`defaultHasLocalModel`/`loadLegacy` 区分 ENOENT（无模型/无迁移）与 EACCES 等（真实故障→上抛/告警，不静默掩盖）。
- **Q7（defer）**：importance 累积投票、反思质量度量**本轮不做**，记录为后续 A/B 候选（缺多方复现证据，YAGNI）。

**接口契约变更（本轮）**：`EmbeddingService` +`runtimeDegraded`/`degradedReason`/backendLabel `remote(运行期降级)`；`EmbeddingIndex` +`dropOtherDimensionTables()`、`parseJsonVec` 可选维度校验；`RuntimeHealth` +可选 `embeddingDegradedReason`；host-rpc status 透传该字段、setConfig 中间态错误文案；maintenance/reflect/causal `runOnce` 外层改非 async（并发返回同一 promise 身份）；maintenance `CANDIDATE_WINDOW=1000`（原 200）。

## 三、已知风险点（诚实自曝）

1. **跨维运行期降级由"切本地"改为"显式降级关键词"**（Q1/A）：远程运行期故障且本地维度≠远程维度时，语义能力停用直到重新保存配置/重启——这是设计取舍（保索引维度一致、防检索抛裸错）；同维（384==384）仍可本地顶班。面板经 `embeddingDegradedReason` 可见。
2. **onCreate 联动的集成级测试缺口**：index.test 用 ready+fail 嵌入覆盖 ensureAll 收容，未直接覆盖"store.create 触发 onCreate 失败"（mountMemory 无 store 句柄 seam）；闭包与 onArchive/onSupersede 同形态、typecheck 通过——已显式记录。
3. **memory.json 迁移 readFile 仍吞 EACCES**（`migrateMemoryJson` 的 catch 一律视"无旧文件"）：Q6⑨ 只覆盖 embed 侧（hasLocalModel/loadLegacy）；记忆库迁移侧同类区分未做（低，记录）。
4. **reflect workspace 预过滤后**：applyDecision 的跨域守卫保留为竞态兜底（选择与执行间的 workspace 变化）。
5. **sqlite-vec 影子表**：DROP 已安全过滤纯维度表名；影子表随 vec0 表生命周期管理（SQLite 托管），非本插件清理范围。
6. **CI 尚未实际触发**：仓库若不在 GitHub 此 workflow 不运行（文件已备好）；覆盖率门槛未设（保守，避免 CI 红；后续按基线补充）。
7. **残余历史风险**：400K 自动压缩策略漂移为宿主配置域（用户环境已补位）；extractor 失败重试重复 LLM 调用为已知成本；反思/因果 LLM 成本与 ~68% 精度为 v1 保守取舍。

## 四、下次最该做的事

1. **重启 3080 实例验证**：面板保存配置后状态行为新契约（远程 ready；无跨维顶班场景；`memory.sqlite` 旧维度表清理日志）。
2. **CI 真实接线**（若仓库上线 GitHub）：触发 workflow 验证 typecheck+test 门；按需补覆盖率阈值。
3. **Q7 候选预研**：importance 累积投票（arXiv:2606.12945）需要多轮信号源设计；反思质量度量钩子（consolidation 预算依赖）。
4. **onCreate 集成测试补强**：若后续给 mountMemory 提供 store 句柄 seam 或经 extractor 驱动写路径，补"create→索引失败→不崩"集成用例。
5. **memory.json 迁移侧 ENOENT 区分**（风险点 3，微改）。
6. 既有"下次"项延续：备份脚本配计划任务；缓存命中率基线实测；memory.sqlite 维护效果观察。
