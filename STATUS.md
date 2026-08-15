# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15（P1-P4 + 缺陷修复 A1-A4 + 2026 最佳实践 B1-B3）。

## 一、架构健康度

- 模块总数：19（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / stable-snapshot / embedding / embed-index / host-rpc / maintenance / render / client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types/constants/render/embedding 被复用，无环
- 单元测试 **258 个全绿**（19 文件，三次连跑稳定）；类型检查与构建通过
- 测试基建统一：FakeCtx 五合一（helpers.ts）、FakeTable 失败注入 + 快照迭代、可控 id 序列（vi.mock newMemoryId）、index.test 嵌入 mock（不真实加载 22MB 模型，533ms→15ms）

## 二、本次变更影响范围（P1-P4 + OPTIMIZATION_PLAN_4）

- **P1-P4**（此前提交）：稳定快照（3af3cea）/ 注入排除（e78ff09）/ 自适应衰减（db77788）/ 语义嵌入（1f2d1d0）
- **A1 P0-1**（d5a9eda）：embed-index persist 串行互斥（promise 队列）+ 损坏 JSON 降级为空索引+告警（原会让插件整体加载失败）
- **A2 P1-1**（16a6677）：config 数字边界（minScore 0..1、各字段 ≥1）+ 跨字段互斥（minExtractChars ≤ maxExtractChars，transform + ValidationError；防早期消息永久丢失）
- **A3 P2-1**（2e20f1f）：supersede 联动移除嵌入向量（onSupersede 钩子）
- **A4 P1-2**（35911f6）：测试补盲发现并修复**两处真实缺陷**——①维护合并同刻 createdAt 方向 tie-breaker（`>=` 恒选先扫描者，曾归档"新者"）；②create supersede 优先于维护合并（supersededBy 条目不参与配对，防现行表述被误归档双不可见）；补 RPC 错误传播/render 预算边界/dispose 交错/交叠测试
- **B1 RRF**（8d4a36f）：语义融合改 RRF 排名融合（k=60 归一化），退役 `embeddingFusionWeight` 配置（无存量用户不向后兼容）
- **B2 频率调制**（cca7d8d）：半衰期 ×(1+log2(1+accessCount))，高频访问召回抬回（Elastic/FadeMem 模式）
- **B3 评测基线**（2bcd2a5）：contradiction 显式测试（PersonaMem 风格：偏好变化/事实推翻/无关性）
- **E1 嵌入默认启用**（24543bf）：删除 `embeddingEnabled` 开关——**远程优先 → 自动回退本地 → 都无则关闭**；新增远程 4 项配置（embeddingApiBaseUrl/ApiKey/Model/Dimension，OpenAI 兼容 /embeddings）；EmbeddingService 多后端（远程验证失败回退本地、运行期故障切本地重试）；EmbeddingIndex 动态维度 + 索引文件按维度隔离（memory-embeddings-<dim>.json，本地 384/远程配置值）；远程返回维度 ≠ 配置 → 显式报错防混维；index.test 嵌入 mock 化（533ms→15ms 确定性）
- **E2 apiKey 双形态**（c1b4885）：embeddingApiKey 支持字面 key 与 `env:NAME` 环境变量引用（env: 前缀显式标记，resolveApiKey 纯函数，字面 key 不被环境变量劫持）
- **E3 面板配置**（7d34588 + d759bb7）：RPC 端点 getConfig/setConfig（严格载荷校验：未知键/类型/越界/跨字段互斥拒绝；setConfig 经 `ctx.fiber.update` 整体校验 → 写回 cordis.patch.yml → 重启插件生效——Cordis 原生链路，数据不丢）；记忆面板底部配置区块（字段驱动 DRY 表单，apiKey 解析状态展示，保存即生效）
- **E4 配置面最小化**（707f014）：19 项 → **4 项**（仅远程嵌入 baseUrl/apiKey/model/dimension）；其余 15 项固化为模块内常量——注入（INJECT_BUDGET_CHARS/TOP_K/MIN_SCORE）、提取（MIN/MAX_EXTRACT_CHARS/EXTRACT_MAX_TOKENS）、快照（SNAPSHOT_TTL_MS/BUDGET_CHARS/TOP_K）、维护（MAINTENANCE_INTERVAL_MS）、四个 enable 开关全删（行为恒启用）、本地模型目录固定全局（模型是共享资产，用户修正方向）；依据 12-Factor + FSE'15 Too Many Knobs；净减 216 行；P2 注入测试适配快照恒启用（长尾种子验证"快照管稳定 Top、实时注入补长尾"）
- **F1-F5 防上下文污染**（126bfcf）：用户质疑"注入相关性不足→污染→失忆"成立（审计：快照 26-29 条来自 9-13 会话无条件注入；0.15 门槛形同虚设；过时记忆无过滤——风险分级高）。五线修复：①快照按来源会话浅聚（SNAPSHOT_PER_SESSION_CAP=3）；②相关性硬门槛 MIN_RELEVANCE_SCORE=0.3（依据：noisy 检索摧毁已知答案 51-64%、mem0 0.65-0.75、magic-context 0.6）；③渲染创建日期（模型可判新旧）；④supersede 30 天时间窗口（SUPERSEDE_WINDOW_MS）；⑤快照重建降频（SNAPSHOT_MIN_REBUILD_INTERVAL_MS=60s 保前缀缓存）。272 测试全绿
- **G1-G5 腐化治理**（bc38b89）：腐化主因不只是低相关注入——任何额外 token 稀释注意力 + 压缩对未压缩区负溢出（lost-in-compaction：压缩 5% 掉 7pp、未压缩区 68%→39%）。五项：①摘录截断标记（95.7% 条目硬截 400 无提示）；②会话摘要治理（SUMMARY_MAX_CHARS=2000 截断标记 + SUMMARY_MERGE_JACCARD=0.5 同会话旧摘要归档——实测单会话 20 份并存）；③维护升级（imp≤5 降权/批量 200/间隔 1h）；④工具回路去重（快照已含不再重复输出）+ recall 补 createdAt + total→returned；⑤salience floor 90 天活跃窗口（SALIENCE_FLOOR_ACTIVE_WINDOW_MS——防 991 条 imp≥8 霸榜）。284 测试全绿
- **接口契约变更**（累计）：配置项 19→4；`InjectorConfig/ExtractorConfig/SnapshotConfig/MaintenanceConfig` 接口删除；`MemoryStableSnapshot.EMPTY_IDS` 删除；CONFIG_DICT 改读 `Config.dict`（transform 包装移除后）；EmbeddingIndexDeps.service 加 `dimension`；`createMemoryRpcHandler(store, rpc)`/`registerMemoryRpc(ctx, store, config)`；MemoryPanelApi 加 getConfig/setConfig；MemoryPanelConfigView 仅 5 字段
- **提交**：92a2725（PLAN4）→ d5a9eda（A1）→ 16a6677（A2）→ 2e20f1f（A3）→ 35911f6（A4）→ 8d4a36f（B1）→ cca7d8d（B2）→ 2bcd2a5（B3）→ 本轮文档

## 三、已知风险点（诚实自曝）

1. **缓存命中率未实测**：P1 的 cacheReadTokens 收益无基线；观测通道现成（UI"缓存命中 %"行），3 轮 on/off 对照即可量化；业界基线提示工具稳定会话自然 ~90%（permafrost）。
2. **维护合并与 create supersede 的微竞态**（A4 已加固 supersededBy 检查，但同刻并发窗口仍理论上存在——真实场景提取串行 + 维护 6h 后跑不触发；测试以顺序场景钉住）。
3. **MemoryPanel 组件渲染测试缺失**：组件层依赖浏览器 DOM，测试环境未引入 jsdom/testing-library；createMemoryApi 全方法已覆盖，组件层靠真机验证。
4. **记忆投毒 L2/L3 未防护**（评估记录于 README）：当前防线挡 L1；升级条件 = 出现多来源写入（第三方工具/子代理写库）。
5. extractor 失败重试的重复 LLM 调用（已知成本）；opencode-acp 版本轨脱节（外部）；嵌入启用后 supersede/归档向量联动已就绪但未真机验证。

## 四、下次最该做的事

1. **重启 3080 实例**：当前进程（18:00 启动）运行旧代码——重启后新代码（面板配置/RRF/嵌入默认启用/配置面 4 项）才生效。
2. **settings.yaml 降 `deepseek-v4-flash maxTokens` 384000→65536**：消除唯一已实测触发过的溢出卡死事故路径（token-meter 低估 + 压缩收益保护死锁链）。
3. **备份脚本配计划任务**：`scripts/backup-memory.mjs` 已就绪（默认保留 10 份），建议每日定时运行。
4. 缓存命中率基线实测（零代码）：3 轮同任务会话读 UI"缓存命中 %" + cacheReadTokens，on/off 对照判定 P1 收益。
5. 观察 memory.json：maintenance 首周期（6h 后）执行效果；A4 修复真机表现。
6. MemoryPanel 组件渲染测试：若引入 jsdom/testing-library 则补组件测试。
