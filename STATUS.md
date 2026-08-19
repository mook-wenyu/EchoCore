# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-19（面板热修复 + 反思/因果/向量调优，C37-C40）。

## 一、架构健康度

- 模块总数：22 源模块 + client 面板（无新增模块；工程资产：`.github/workflows/ci.yml`）
- 依赖方向：`index.ts`（组合根）→ 各模块，无环。依赖变更：`@photostructure/sqlite-vec` 锁精确 `1.2.0`；新增 devDep `@vitest/coverage-v8@^3.2.7`（必须匹配 vitest 3.2.x）
- 单元测试 **544 个全绿**（26 文件，typecheck 干净；上轮 513，本轮 +31）
- **覆盖率基线**：Stmts 93.86% / Branch 90.93% / Funcs 94% / Lines 93.86%（保守阈值 lines80/functions75/statements80/branches70）
- 实现均 TDD（先红后绿），每逻辑变更独立提交（C33-C40 六件）

## 二、本次变更影响范围（全量优化 → 拍板落地）

**全量审查（3 并行子代理取证 + 主代理复核）**：新代码深审（跨维降级/migrateAll/runOnce/settings 回滚等验证无回归；发现 memory_status 未透出嵌入新字段、DROP×holder 竞态、死代码 MIN_RELEVANCE_SCORE 等）；测试审计（覆盖率从未配置、onCreate .catch 零测试等）；网络第二轮（importance 多因子、consolidation 度量等）。grilling 两轮 12 项拍板全部按推荐。

- **C33（语义向量持续分片补齐）**：`backfill(budget)`（预算批内生效）+ 维护周期每轮补一档（`BACKFILL_BUDGET 256→512`，限速防限流）；与 ensureAll 共用串行锁。背景：生产语义覆盖仅 18.7%（1534/8191→1900/8709 21.8%），检索质量受限于关键词路径。
- **C34（反思合并改语义门）**：对齐权威（ai-memory CONSOLIDATE_COSINE_THRESHOLD=0.75）——`selectReflectionPairs` 双侧有向量时以 cosine≥0.75 为主门（384维本地 0.72 宽松），任一侧无向量回退 token-Jaccard 带（0.08,0.85) + overlap≥2；`EmbeddingIndex.getVector` + `cosineSimilarity` 支撑。
- **C35（memory_causal 手动触发）**：新工具镜像 memory_reflect（force 共享维护批 runOnce；add-only/置信 0.6→0.55 语义不变）；维护批早已接线，0 边根因=6h 门控未过+无手动入口。在产验证：21:49 重启后 `memory_causal` 执行成功（审 30→50 条/0 边=候选多为近重复非真因果，诚实结果）。
- **C37（记忆面板高价值束 E+A+F，2026-08-18 拍板）**：ascetic-breaker 轮盘点面板（client.ts + RPC 面）→ 与权威（NN/g/W3C-APG/PatternFly/Carbon/Algolia/Android list-detail/MemLens）对照出 13 缺口，用户拍板 A 束：E 面板加“运行反思”按钮 + 统计区渲染反思累计/上次反思/因果行；A master-detail 并排分栏（窄屏叠层）；F 配置区默认折叠。TDD（红 3 例→绿）。
- **C38-40（面板热修复 + 调优深化，2026-08-19）**：
  - 热修复：`host-rpc` 对未运行的反思/因果显式发 `null`，而 `client.ts` 仅判 `!==undefined` 导致 `null.runs` 抛错整树卸载闪白。修复：`MemoryStatsView` 补 `| null` 联合类型，渲染守卫改为 `!=null`，`DetailPane` 防御畸形条目，新增 `PanelErrorBoundary` 兜底，并补 `embeddingDegradedReason` 契约对齐。TDD 新增“null 字段不白屏”用例。
  - 调优深化：`REFLECT_WINDOW 200→400`，`PEER_MIN_JACCARD 0.15→0.08` + `PEER_MIN_TOKEN_OVERLAP=2`，语义阈值按维度区分（384:0.72/其他:0.75），补充 few-shot 与 `semanticHitRate` 可观测；`CAUSAL_WINDOW 200→400`/`BUDGET 30→50`/`MIN_CONFIDENCE 0.6→0.55`，`truncateContent` 按句边界 200 截断；`CANDIDATE_WINDOW 1000→2000`，`BACKFILL_BUDGET 512`。新增 31 用例。

**接口契约变更**：`MemoryStatsView` 新增 `embeddingDegradedReason?: string`、`reflection: ... | null`、`causal: ... | null`、`lastCausalAt`；`MemoryPanelApi` 新增 `reflect()`；`selectReflectionPairs` 新增可选 `embedding` 参数（向后兼容）；`ReflectionSummary` 新增 `semanticHitRate?`。

## 三、已知风险点（诚实自曝）

1. **关键词噪声下限为检索行为变更**：零重合条目在关键词路径被过滤（即使 minScore=0）；语义单榜仍可独立召回。若未来发现“弱但真实”的关键词召回受损，需重评下限值（benchmark 契约已同步）。
2. **反思焦点策略变化**：焦点按“带内重合度/语义相似度优先”——无 peer 的孤条目不进被审集；同对两端会各作焦点（可能重复喂 LLM，由 PEERS_PER_FOCUS=3 限流）。
3. **Q5 修复只覆盖已发现两处**：未来新增/修改工具输出必须保持“不得含 undefined 属性值”纪律（宿主 lossless-JSON 校验；否则记忆已入库但工具误报失败）。
4. **2b 累计为进程内态（重启归零）**：跨轮收敛判断需累积多轮才有意义；“被反思归档条目的后续推翻”追踪未做（显式边界）。
5. **换维热换 DROP 与旧 holder 飞行写竞态**：低概率（同连接同步 SQL），已被 onCreate catch 收容，向量丢不崩。
6. **CI/覆盖率门槛未实际触发**：仓库未上线 GitHub 前 workflow 不运行；阈值保守（按基线留余量）。
7. **因果进检索仍未决策**：当前边仅审计不入检索、已有 confidence 0.55 建边校验——“置信≥阈值才入检索”是待决策的 A/B 候选。
8. **W2 selfRelevance 依赖 LLM 一次性打分质量**：档位（≥8→+2 / ≥6→+1）与封顶 +2 为保守参数；需实机观察。
9. **生产已为最新代码（盘上已最新，待重启生效）**：`BAILIAN_API_KEY` 已字面化进 settings.yaml——重启不再依赖 shell env。残余：语义向量覆盖 21.8%（1900/8709，C33 分片补齐收敛中，约 13.5h 补齐）；C34 语义门在双侧有向量时生效（随覆盖扩大）。
10. **8705 规模下维护采样**：即使 CANDIDATE_WINDOW 2000 仍仅覆盖 23%，尾部 6709 条需多周期轮询收敛（已注释游标分片预留位）。
11. **压缩失败待查**：8705 条注入可能导致上下文溢出，需排查 injector 注入预算与 compaction 阈值 400K 的交互。

## 四、下次最该做的事

1. **重启后复验面板与反思/因果**：新宿主加载最新 client.js 与调优后阈值，刷新面板验证白屏修复、反射按钮、并排布局、折叠配置；复跑 `memory_reflect`/`memory_causal` 观察新阈值与窗口下的产出。
2. **观察语义补齐收敛**：1h 维护周期 backfill 512/周期，覆盖 21.8%→100% 约 13.5h；覆盖过半后复验语义门效果。
3. **selfRelevance 实机观察**：抽样 `memory_detail` 检查 LLM 评分分布与档位边际。
4. **CI 真实接线**（上线 GitHub）：typecheck+test+覆盖率门跑通；按需收紧阈值。
5. **Q7 探测集 delta 立项**：consolidation 质量度量（contradiction/staleness/recall@k/precision@k 只读探测集）。
6. **压缩根因排查**：确认 8705 条注入对 400K 压缩阈值的影响，必要时调小注入预算或增大阈值。
