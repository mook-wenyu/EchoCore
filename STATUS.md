# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-18（自我学习 S1/S2 + 生产验证与停盘部署，C17-C21）。

## 一、架构健康度

- 模块总数：22 源模块 + client 面板（无新增模块；工程资产：`.github/workflows/ci.yml`）
- 依赖方向：`index.ts`（组合根）→ 各模块，无环。依赖变更：`@photostructure/sqlite-vec` 锁精确 `1.2.0`；新增 devDep `@vitest/coverage-v8@^3.2.7`（必须匹配 vitest 3.2.x）
- 单元测试 **497 个全绿**（26 文件，typecheck 干净；上轮 483，本轮 +14）
- **覆盖率基线**：Stmts 93.89% / Branch 90.83% / Funcs 94% / Lines 93.89%（保守阈值 lines80/functions75/statements80/branches70）
- 实现均 TDD（先红后绿），每逻辑变更独立提交（C17-C21 五件）

## 二、本次变更影响范围（二轮复查 → 拍板落地）

**二轮审查（3 并行子代理取证 + 主代理复核）**：新代码深审（跨维降级/migrateAll/runOnce/settings 回滚等**验证无回归**；发现 memory_status 未透出嵌入新字段、DROP×holder 竞态、死代码 MIN_RELEVANCE_SCORE/EmbeddingFallbackLogger、注释漂移）；测试审计（覆盖率从未配置、onCreate `.catch` 零测试、ENOENT/EACCES 分支零测）；网络第二轮（importance 多因子实证 0.770 vs 0.518 改判、consolidation 度量、因果建边证据、BM25 噪声下限）。grilling 两轮 12 项拍板全部按推荐。

- **C9（1a/1b/4c/测试补强）**：`migrateMemoryJson` readFile **ENOENT 与其他 IO 区分**（非 ENOENT 上抛，迁移不被静默跳过丢源）；`mountMemory` 加 `MountOverrides.exposeStore` test seam + **onCreate 集成测试**（create→索引联动失败→不崩、无未处理拒绝——堵住 F2 P0 缺口）；embed-index `ensureAll` **批次写包单事务**（批内全有或全无，中途写败整批回滚）；补测 defaultHasLocalModel/loadLegacy 的 ENOENT vs EACCES、reflect/causal **批次结束后可重开**（防 running 复位死锁）。
- **C10（Q5 真实 bug + 2b + Q3）**：**Memory 工具输出含 `undefined` 属性值 → 宿主 lossless-JSON 校验整体拒绝**（`tools.ts:392` memory_note 未合并时 `mergedWithId: undefined`；`:565` memory_detail 未命中 `entry: undefined`）。**记忆实际已入库，仅输出回传被拦、工具误报失败**（会诱导重复写入）——改为安全省略键。`ReflectionCumulative`（runs/裁决/合并/归档/跳过跨轮累计，仅成功路径计数）经 memory_status/RPC status 透出（轻量质量钩子）；`memory_status` 补透出 `embeddingBackend/embeddingInitError/embeddingDegradedReason`（约定 `'json' required:true` 承载 null）——模型不再靠猜。
- **C11（Q4 死代码/下限束）**：`MIN_RELEVANCE_SCORE=0.3` 从死常量**接线为关键词路径噪声下限**（rel<0.3 弱命中不入检索；语义单榜独立召回不受影响——两条独立门槛，修 0.3/0.15 注释漂移）；删除零引用死 type `EmbeddingFallbackLogger`；benchmark「稀有词权重」契约随之下拨（零重合条目在 minScore=0 下也不返回）。
- **C12（Q6 覆盖率）**：装 `@vitest/coverage-v8@3.2.x` + vitest.config thresholds + `test:coverage` 脚本 + CI 覆盖率步骤（首度可量化防回归门）。
- **C13（Q1 轻量融合）**：`effectiveImportance(importance, accessCount)`——存储 LLM 1-10 主因子 + 对数式访问频率证据（1 次=+1 / ≥3 次=+2，封顶 +2，不训学习权重）；仅作用于 `listByImportance`（快照/保留决策），**不动检索主路径**（search 评分仍用存储 importance + 半衰期访问调制，避免同一证据双重计入）。依据 arXiv:2606.12945 LexWisdom 0.770 vs 0.518。
- **F3 证据报告** 落盘 `docs/reports/research-report-round2-enhanced-candidates.md`（Q7 候选预研素材）。

**三/四轮（自学习 + 生产验证，2026-08-18）**：

- **C17-C19（生产验证/部署）**：只读生产审计报告 `docs/reports/production-validation-report-2026-08-18.md`——部署落后仓库 14 提交（缺 `a021648` 至 `b8f77e0`，Q5 缺陷与旧版无条件 384 顶班在产仍存活）、语义向量仅 9% 覆盖、因果 0 产出；用户授权「不停 dsh 停盘部署」①（build lib → 离线直拷 profile store，C19 完成，盘上已为最新，运行进程旧码待重启生效）。
- **C25-C26（文档架构重构，2026-08-18）**：按 Diátaxis 全文档重构——新增 `docs/README.md`（文档地图）、`docs/DEPLOYMENT.md`、`docs/DEVELOPMENT.md`；两份报告移入 `docs/reports/`；包 README 瘦身为 Reference（部署/运维/开发移至 How-to 指针）；根 README（EN/zh）修复 `docs/` 断链并指向文档地图。
- **C20/S1（自我学习契约锁线）**：`test/self-learning-contract.test.ts` 锁死三条红线（Echo-Gap 不在检索/保留使用证据改写 stored importance、supersede/archive 不物理删、检索命中→保留提升链路）——均为既有正确行为的可复现断言。
- **C21/S2（W2 self/user 相关性信号）**：`selfRelevance?`（1-10）从提取 LLM 一次性评定 → 落库（types:75/111/123、schema memory-domain:45 可选向后兼容）→ 并入 `effectiveImportance`（scoring:295，档位 ≥8→+2 / ≥6→+1，封顶 +2）→ 仅 listByImportance（store:669-670）消费 → `memory_detail` 安全省略键透出（tools:91/123）。Echo-Gap 安全：创建期一次性因子、绝不重写；不训权重。
- **C28（docs-as-code 校验，2026-08-18）**：`scripts/check-docs.mjs`（断链+中英结构一致性，零依赖）+ markdownlint-cli2（根 devDep + `.markdownlint-cli2.jsonc`）接线 CI；存量 29 处空白错误 `--fix` 清理。
- **C29（反思实证修复 + 生产热载，2026-08-18）**：生产 `memory_reflect` 端到端验证暴露两盲区——①焦点按重要度 top-20 漏检 imp6-7 真重复（生产 267 带内候选、逐字同文对全被 imp≥8 挤出被审集，实证）；②LLM 畸形输出静默当 0。修复：焦点改为**带内重合度优先**（maxBandJ 降序→重要度次级；无 peer 孤条目不占焦点，同对两端双向进集）+ `callLlm` 对无 `decisions` 字段输出显式 warn。TDD（先红 3 例→绿）。已 build+拷 store+HMR 热载至 live 宿主（PID 9116）；局部会话重启不重置进程累计。

**接口契约变更（自学习）**：`MemoryEntry/NewMemoryInput/ExtractedMemory` + `selfRelevance?`；`effectiveImportance(importance, accessCount, selfRelevance=0)`（第三参缺省=0，两参调用不变）；`MemoryDetail` + `selfRelevance?`（无则省略键）；`memoryEntrySchema` + `optional`；提取 system prompt 规则 11。

## 三、已知风险点（诚实自曝）

1. **关键词噪声下限为检索行为变更**：零重合条目在关键词路径被过滤（即使 minScore=0）；语义单榜仍可独立召回。若未来发现"弱但真实"的关键词召回受损，需重评下限值（benchmark 契约已同步）。
2. **反思焦点策略变化（C29）**：焦点按"带内重合度优先"——无 peer 的孤条目不进被审集（原高重要度孤条目不再被审，但其本无可审对，语义等价）；同对两端会各作焦点（可能重复喂 LLM，由 PEERS_PER_FOCUS=3 + 带内过滤限流）。C29 修复在产为 HMR 热载（PID 9116 18:54 后），进程内累计已随重载/重启归零。
2. **Q5 修复只覆盖已发现两处**：未来新增/修改工具输出必须保持"不得含 undefined 属性值"纪律（宿主 lossless-JSON 校验；否则记忆已入库但工具误报失败）。新 `memory_detail` 未命中路径已同法省略键。
3. **2b 累计为进程内态（重启归零）**：跨轮收敛判断需累积多轮才有意义；"被反思归档条目的后续推翻"追踪未做（显式边界，深度归因留给探测集评估）。
4. **换维热换 DROP 与旧 holder 飞行写竞态**（F1 记录）：低概率（同连接同步 SQL），已被 onCreate catch 收容，向量丢不崩；仍处 out 列表。
5. **CI/覆盖率门槛未实际触发**：仓库未上线 GitHub 前 workflow 不运行；阈值保守（按基线留余量）。
6. **因果进检索仍未决策**：CausalRAG2 证据强（假因果降 F1），当前边仅审计不入检索、已有 confidence≥0.6+来源/workspace/superseded 建边校验——"置信≥阈值才入检索"是待决策的 A/B 候选（需产品意图）。
7. **W2 selfRelevance 依赖 LLM 一次性打分质量**：档位（≥8→+2 / ≥6→+1）与封顶 +2 为保守参数（无离线评估，仅证据背书为"初始因子"）；LLM 若系统性高评/低评该维度会偏移保留面——需实机观察（可经 memory_detail 审计）。创建期一次性、不重写，Echo-Gap 安全。
8. **生产仍为旧构建运行中**（C19 已停盘至最新）：新码含 W2 需**下一次重启**才在产生效；重启须带 `BAILIAN_API_KEY` export（密钥仅宿主 shell 继承 env，见生产报告附录）。
9. **残余历史风险**：400K 自动压缩策略漂移为宿主配置域（已补位）；extractor 失败重试重复 LLM 调用为已知成本；`memory.json` 迁移 `migrateAll` 期间并发写无（启动路径）——安全。

## 四、下次最该做的事

1. **热更重启 → 在产复验**（含 W2）：按 `production-validation-report` 附录 A 择时重启（带 key），复验语义覆盖补齐、Q5 不再报错、`memory_detail` 可见 `selfRelevance`、因果表有产出。
2. **selfRelevance 实机观察**：抽样 `memory_detail` 检查 LLM 对该维度的评分分布与档位边际；必要时调档位参数。
3. **CI 真实接线**（上线 GitHub）：typecheck+test+覆盖率门跑通；按需收紧阈值。
4. **Q7 探测集 delta 立项**：consolidation 质量度量（contradiction/staleness/recall@k/precision@k 只读探测集）——2b 轻量底座已就位。
5. **因果进检索决策**：若产品意图是让因果边增强检索，按 CausalRAG2 证据做"置信≥阈值 + 来源/时序校验"分层；否则维持审计-only。
6. 既有项延续：备份脚本配计划任务；缓存命中率基线；memory.sqlite 维护效果观察。
