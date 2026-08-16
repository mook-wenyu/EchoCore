# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-16（面板配置持久化修复——"保存成功但重启丢失"根因闭环）。

## 一、架构健康度

- 模块总数：20（types / constants / config / settings / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / stable-snapshot / embedding / embed-index / host-rpc / maintenance / render / client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types/constants/render/embedding 被复用，无环；`settings.ts` 仅被 `index.ts` 引用（组合根注入，无环）
- 单元测试 **367 个全绿**（23 文件，三次连跑稳定）；类型检查与构建通过
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
- **存储结构性改造（SQLite）**（4008da5）：用户拍板"解决而非缓解"——自建 SqliteKvTable（node:sqlite WAL）替代 storage-json 整文件原子写：写 O(n)→O(1)、检索可索引。实测：单条写 1.34ms vs 11ms（8.2x）；主键点查 0.0066ms；批量 3667 条 18ms。首启自动迁移（memory.json→memory.sqlite，逐条 schema 校验/坏记录跳过/原文件 .bak 保留/幂等）；inject 移除 storageDomain（自建存储）；mountMemory 导出 + MountOverrides 测试路径隔离；备份脚本改 SQLite backup API。291 测试全绿
- **检索与持久化优化（R1-R3）**（42e68b1）：①tokenize 条目级缓存（读路径主成本 24-58ms/次→零重建；update 变 tags 失效）；②嵌入索引 10s 去抖持久化（PERSIST_DEBOUNCE_MS——消灭每新建 7MB 整写同构病；flush() 公开）；③RPC search 可选 workspace 过滤（面板管理语义保留）。293 测试全绿
- **jieba 中文分词（J1/J2）**（bb77636）：用户拍板加 jieba——①tokenize 升级「英文词+jieba 中文词+2-gram 兜底」并集（真实词边界修 2-gram 重叠歧义；2-gram 保 OOV 子串召回；jieba 中文单字过滤防稀释分母——实测 '怎么用'→'用' 单字使 0.5→0.4 跌破门槛；输出去重）；②SqliteKvTable content_tokens 预分词列（deriveTokens 可选回调，jieba 词空格分隔——未来 FTS5 unicode61 数据源，当前只写不读）；依赖 @node-rs/jieba 2.0.2（N-API 预编译 Windows 免编译）。298 测试全绿
- **全量盘点修复（D1/D2/M1/M4-M7）**（c8bf677）：用户拍板全做——①D1 写链失败自恢复（单条写失败不卡死后续链 + writeFailures 计数——消除重启丢断点后记忆的隐蔽丢失路径）；②D2 迁移坏 JSON 降级（corrupt 标记 + .bak 保留 + 空库启动，不阻断插件）；③M1 busy_timeout=5000（多进程并发写有重试窗口）；④M4 删 memoryScore/scoreEntry 生产死路径（评分双源统一）；⑤M5 删 4 个无 import 死依赖；⑥M6 README 过时描述修复；⑦M7 entryTokenCache/lastTrackedAt 超 5000 清空重建（防无界内存）。301 测试全绿
- **保存配置崩溃修复**（359f99b）：面板 setConfig 报 "Cannot read properties of undefined (reading 'meta')"——根因实测复现：宿主 cordis-plugin-loader 的 internal/update 写回路径裸调用 `Config["simplify"](config)`——schemastery simplify 是原型方法依赖 this，裸调用 this=undefined → this.meta 崩。修复：Config 导出时绑定 simplify（宿主 loader 契约）。315 测试全绿
- **注入相关性治理（P1-P3）**（8f69dac + 00e3b8a）：用户拍板全做含多查询（hindsight 评估 + Selective Memory/Mixpeek/agent-evolution-kit 2026 最佳实践）——①P2 写端 admission gate（extractor 通道零价值 importance=0/纯噪声 token<2 拒绝——写时过滤结构性优于读时，8:1 distractor 下读端归零写端 100%）；②P1 置信度三档注入（≥0.7 完整行 / 0.4-0.7 摘要行 / <0.4 跳过——替代单一 0.3 门槛）；③P3 会话上下文派生查询（近期 3 条消息拼接——换话题时历史主题词仍参与召回）。326 测试全绿
- **第三轮全量盘点（R1-R5 + N2 + 需求 A/B）**（7ecf137 + c56b2cb + a4c634c）：用户拍板全做——①R1b 摘要行截断附"（原文 N 字符）"标记（词中间切断损失量可判断）；②R2 P2 拒绝计数入 memory_status（观测闭环——门拦了多少不再黑洞）；③R1a RRF+withScore 标定钉住（语义单榜=0.5 摘要档契约）；④R5 WAL 显式 checkpoint（wal_autocheckpoint=256 + checkpoint() TRUNCATE 回截）；⑤R3 P3 窗口滚动边界测试 + 拼接检索基准；⑥N2 目录注入（未展示条目标题目录 + 模型主动 memory_recall——防 known-information forgetting ICLR 2026，token 减 26-61%）；⑦需求 A 失败教训提取规则（insight + tags:['失败教训']——检索零新码）；⑧需求 B 用户强调提取规则（importance ≥7 自动保活）；⑨Agent 自进化查证（EDV 自我确认陷阱警示/SkillRevise 同构——教训需来源校验，dsh 已有 excerpt/audit）。337 测试全绿
- **聚焦三项盘点（轻量 IDF + 面板测试 + recall@k）**（c7109f6 + 7798772 + b1490c6）：用户拍板"含轻量 IDF"——①轻量 IDF 加权关键词检索（bm25Idf + idfWeightedRelevance——保留 0-1 标定的 BM25 化：稀有词命中权重 > 常见词，全命中=1.0/零命中=0——注入三档不受影响；检索时按候选集统计 df 零维护；**df=0 修复**：候选集外词不进分母——长查询不再砸分到阈值下）；②面板 jsdom 行为测试（@testing-library/react 5 用例：初始加载/搜索/详情/O1 写失败/竞态守卫——devDeps 加 react/react-dom/jsdom/testing-library 测试依赖不进生产）；③benchmark 补 recall@k 评估（合成库 200 条实测 recall@5=1.0——原全为性能断言无质量评估）；④Agent 自进化评估交付（反思轮写门与流式 extractor 冲突不落地——教训验证规则已内建）。354 测试全绿
- **面板配置持久化修复（"保存成功但重启后配置丢失"）**（155ed81 + 87dee21 + 0d2a21b）：用户实测报障，根因三条证据链闭合——保存原经 `fiber.update(noSave=false)` → loader internal/update 写回 entry.options.config + tree.write() → 写进 cordis.yml；而 DSH 每次启动 prepareProfile 无条件把 cordis.yml 重写为 []（组合基底文件），保存的配置下次启动被清空。修复（用户拍板：settings.yaml 通道）：①新增 `src/settings.ts` settings seam——命名空间 memory 注册（entry 配置为 base 层）+ setSource/onChange + 面板持久化通道 + 幂等生效门（sameConfig 守卫）；②host-rpc `MemoryRpcContext` 改 `config()/settings/applyChange` 契约，setConfig 先落盘 settings.yaml 再生效，持久化失败整体拒绝（绝不静默"保存成功"）；③依赖新增 @deepseek-ai/dsh-settings（DSH 官方用户设置 seam，内建插件配置页同款通道）。
- **生效方式二度修正（实时生效，去掉插件重启）**（本次提交）：初版用内存重启（fiber.update noSave=true）生效——同日二次实测**保存即 fatal load failure**：插件 apply 含秒级异步段（加载 22MB 本地 ONNX 模型），进程内重启让**陈旧续体竞态**——被中断的 apply 续体恢复时，要么撞进 inactive 窗口抛 "cannot get required service"（harness 实测可杀进程），要么在 fiber 重新激活后二次注册 memory:snapshot / memory_recall——dsh-system-prompt 与 dsh-tools 都是 NamedEntries 严格重复检测（"already registered"）。用户拍板**实时生效**：settings 变更 → `initEmbedding` 原位重建 EmbeddingService/EmbeddingIndex（epoch 守卫丢弃过期会话；热换前 flush 旧索引）→ store 钩子/注入器/工具/状态展示改**调用时读 EmbeddingHolder**（embedding.ts 新增）→ 零重启零竞态。装配用 seam.effective() 当前值（注册期生效的合并配置直接用于首启）。**实机验证**（`scripts/verify-persist.mjs`，默认 + 真实 systemPrompt 双模式，EXIT 0）：保存后 settings.yaml 出现 memory 段 4 项全含 ✓、cordis.yml 保持 [] ✓、保存实时生效（RPC 保持单次注册）✓、独立进程模拟 dsh 重启后未保存即恢复全部配置 ✓、真实 systemPrompt 下与 NamedEntries 零冲突 ✓。367 测试全绿
- **接口契约变更**（累计）：配置项 19→4；`InjectorConfig/ExtractorConfig/SnapshotConfig/MaintenanceConfig` 接口删除；`MemoryStableSnapshot.EMPTY_IDS` 删除；CONFIG_DICT 改读 `Config.dict`（transform 包装移除后）；EmbeddingIndexDeps.service 加 `dimension`；`createMemoryRpcHandler(store, rpc)`/`registerMemoryRpc(ctx, store, config)` → `registerMemoryRpc(ctx, store, rpc)`（rpc 由 `{config: ResolvedConfig, fiber}` 改 `{config(), settings, applyChange}`）；`MountOverrides` 加 `seam`；`MemoryInjectorDeps`/`MemoryToolsDeps` 的 `embedding`+`embedIndex` 合并为 `embedding: EmbeddingHolder`（调用时读，热换即生效）；`SettingsSeam` 加 `setApplier`；MemoryPanelApi 加 getConfig/setConfig；MemoryPanelConfigView 仅 5 字段
- **提交**：92a2725（PLAN4）→ d5a9eda（A1）→ 16a6677（A2）→ 2e20f1f（A3）→ 35911f6（A4）→ 8d4a36f（B1）→ cca7d8d（B2）→ 2bcd2a5（B3）→ 本轮文档

## 三、已知风险点（诚实自曝）

1. **插件存储/模型路径硬编码 `homedir()/.dsh`**（忽略 DSH_HOME 环境变量）：实机验证脚本只能读取性触碰真实 ~/.dsh/storages（memory.sqlite / 嵌入索引 / 22MB 本地模型，模型加载致 apply 数秒）。测试隔离依赖 MountOverrides（单测路径）；若未来要支持 DSH_HOME 覆盖（CI/多实例），需把 `defaultMemoryDbFile/defaultEmbeddingModelDir` 改为经 dsh-home-paths 解析——**本次只报告未修改**（真实部署 DSH_HOME==~/.dsh 无差异）。
2. **profile `pnpm install` 受供应链策略门拦截**（dshmarket@1.9.0 发布年龄不足，存量锁文件问题）：部署需 `pnpm install --trust-lockfile`（已写入 profile 的 pnpm-workspace.yaml minimumReleaseAgeExclude）。
3. **settings.yaml 手工编辑的并发语义**：settings 提供者热重载，多处编辑器同时写同一文件时以最后提交为准（DSH 官方机制，与本插件无关）；面板保存失败会整体拒绝并提示，不会半写。
4. **保存期间并发热换的 epoch 守卫**：面板保存触发的 initEmbedding 与首启初始化并发时，epoch 只保留最后一次调用发起的会话（陈旧结果丢弃）——正确性已钉住；若远程端点无超时（defaultFetchRemoteEmbeddings 无显式 timeout），不可达端点可能让保存等待 OS 级超时（既有行为，非本次引入）。
5. **缓存命中率未实测**：P1 的 cacheReadTokens 收益无基线；观测通道现成（UI"缓存命中 %"行），3 轮 on/off 对照即可量化；业界基线提示工具稳定会话自然 ~90%（permafrost）。
6. **维护合并与 create supersede 的微竞态**（A4 已加固 supersededBy 检查，但同刻并发窗口仍理论上存在——真实场景提取串行 + 维护 6h 后跑不触发；测试以顺序场景钉住）。
7. **记忆投毒 L2/L3 未防护**（评估记录于 README）：当前防线挡 L1；升级条件 = 出现多来源写入（第三方工具/子代理写库）。
8. extractor 失败重试的重复 LLM 调用（已知成本）；opencode-acp 版本轨脱节（外部）。

## 四、下次最该做的事

1. **重启 3080 实例**：当前进程运行旧代码——重启后新代码（实时生效版）才生效；重启前先跑 `scripts/backup-memory.mjs` 刷新备份。重启后到设置页「记忆」保存一次配置，确认：`~/.dsh/settings.yaml` 出现 `memory:` 段、cordis.yml 保持 []、**保存不崩溃且立即生效**（面板提示"已保存并生效…嵌入后端已热切换"）。
2. **⚠️ 已撤销（2026-08-15）：降 settings.yaml maxTokens 384000→65536 是错误方案**——maxTokens 是模型最大输出上限，降它截断生成能力（用户否决）。溢出事故真实根因在宿主域：dsh-token-meter CHARS_PER_TOKEN=4 低估 2-3 倍 + 压缩触发/停止口径分裂 + 收益保护死锁（记忆 #f98ca946，harness 域缺陷，不属于 dsh-memory 修复范围）。正确路径：向宿主报 token-meter 缺陷；dsh-memory 侧已做注入预算上限 + 摘要截断治理。
3. **备份脚本配计划任务**：`scripts/backup-memory.mjs` 已就绪（默认保留 10 份），建议每日定时运行。
4. 缓存命中率基线实测（零代码）：3 轮同任务会话读 UI"缓存命中 %" + cacheReadTokens，on/off 对照判定 P1 收益。
5. 观察 memory.sqlite：maintenance 首周期执行效果（降权放宽 imp≤5/批量 200/间隔 1h + 会话摘要归档收敛）。
