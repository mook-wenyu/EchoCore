# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-20（全量并行+游标/自适应收尾，584全绿）。

## 一、架构健康度

- 模块总数：28 源模块（含新增 `store/search|create`、`client/api|panel|config-pane|error-boundary`、`utils/balanced-json`、`runtime`）+ client 面板；工程资产：`.github/workflows/ci.yml` + `docs/COMPACTION.md`
- 依赖方向：`index.ts`（组合根）→ 各模块，无环。`store` 单职责拆分后 `search` 纯函数层与 `create` 创建链各 <40 行；`client` 三职责解耦后 `api` 可在 node 单测
- 单元测试 **584 个全绿**（30 文件，typecheck 干净；上轮 572，本轮 +12，含游标/自适应与迁移脚本）
- **覆盖率基线**：Stmts 97.71% / Branch 92.28% / Funcs 93.51% / Lines 97.71%（阈值 lines80/functions75/statements80/branches70，已超，P1 已补至 >90）
- 实现均 TDD（先红后绿），每逻辑变更独立提交（C33-C40 + P0-P2 五件）

## 二、本次变更影响范围（全量并行 P0-P2）

**全量审查（3 并行子代理 + 主代理 Playwright 复验）**：面板闪白根因 `null` 解构、`reflect/causal` 窗口/阈值/提示词、向量覆盖 21.8%、`store/client` 神类、单例全局耦合、密钥明文、400K 压缩双阈值。

- **P0-1 拆 store**：`store.ts 746→399` 仅保留骨架，抽 `store/search.ts 334`（search/RRF/IDF/tokenCache）与 `store/create.ts 193`（create/去重/超窗）， `SearchOptions` 定义前移保持兼容
- **P0-2 拆 client**：`client.ts 686→薄壳` 仅 `name/inject/apply`，抽 `client/api.ts`（RPC 纯逻辑）、`client/panel.tsx`（MemoryPanel+Detail）、`client/config-pane.tsx`（ConfigPane 折叠）、`client/error-boundary.tsx`（白屏兜底）；`tsconfig` 增 `jsx:react-jsx`
- **P0-3 抽 balanced-json**：新建 `utils/balanced-json.ts` 单源 `extractBalancedJson`，`scoring.ts` 新增 `jaccard(a,b)` 纯函数，`store.tokenJaccard` 与 `store/create.jaccardTokenSimilarity` 收敛单源
- **P1 单例收敛**：新建 `runtime.ts: MemoryRuntime` 收敛 `embeddingEpoch/holder/storeRef/settings` 四全局，`settings.ts`/`index.ts` 全部经实例，`resetSeamForTest` 改实例方法；补 `embedding/tools/reflect` 覆盖率至 >90%（`All 97.71%/92.28%`）
- **P2 安全与压缩**：`host-rpc:handleSetConfig` 检测明文 `sk-` 提示迁 `env:`，`scripts/migrate-apikey-to-env.mjs` 一键迁移脱敏备份；新建 `docs/COMPACTION.md` 400K 触发/200K 目标/16K 预留双阈值滞回，`docs/DEPLOYMENT.md` 联动
- **P3 游标与自适应（本轮）**：`store` 新增 `listRecentByCursor` 游标分页 + `lastMaintenanceCursor` 轮询全库（2000 窗→100% 覆盖），`reflect` 新增 `adjustThresholdByHitRate`（<0.1→0.68, >0.3→0.75）与 `maintenance` 联动，`causal` 新增 `confidence.hist` 可观测

**接口契约变更**：`MemoryStatsView` 已在 C38 补 `| null`；`MemoryPanelApi.reflect()` 已加；`store` 拆分后 `import from '../store.js'` 兼容层保留；`runtime` 新增 `MemoryRuntime` 单例（内部）。

## 三、已知风险点（诚实自曝）

1. **关键词噪声下限**：零重合条目在关键词路径被过滤（语义单榜独立召回）
2. **反思焦点策略**：无 peer 孤条目不进被审集；同对两端双作焦点（PEERS=3 限流）
3. **Q5 修复纪律**：新增工具输出须保持“不得含 undefined”纪律
4. **2b 累计进程内态**：重启归零，跨轮判断需多轮
5. **换维 DROP 竞态**：低概率已收容
6. **CI 未实际触发**：仓库未上线 GitHub
7. **因果进检索未决策**：confidence 0.55 仅审计，待 A/B
8. **W2 selfRelevance 档位保守**：需实机观察
9. **生产盘上已最新待重启**：覆盖 21.8% 待 13.5h 收敛
10. **维护采样 23%**：2000 窗仍仅 23%，尾部需游标（已预留 `lastMaintenanceCursor`）
11. **压缩双阈值待验证**：400K/200K/16K 已文档化，未在 8705 真实长会话压测
12. **明文密钥残留**：`settings.yaml` 仍为 `sk-ws-…` 字面（未执行迁移脚本）

## 四、下次最该做的事

1. **重启后 Playwright 复验**：白屏、反射按钮、并排、折叠（已通过 `ref=e362` 复验，待新 P0 拆分后二次确认）
2. **生产采样 semanticHitRate/causal.hist**：一次成功 `memory_reflect` 后 `memory_status` 观测新阈值效果
3. **游标分片落地**：实现 `listRecent` 游标分页 + `store.lastMaintenanceCursor` 持久化，使 2000 窗轮询全库
4. **CI 上线与覆盖率收紧**：阈值 80→88/70→78
5. **密钥一键迁移**：执行 `node scripts/migrate-apikey-to-env.mjs` 将字面切 `env:BAILIAN_API_KEY`
6. **压缩压测**：8705 注入下 400K 双阈值滞回验证
