# OPTIMIZATION_PLAN_3：缓存感知注入 + 衰减优化 + 语义嵌入检索

> 计划依据：2026-08-15 三轮并行研究（本体/KG、缓存注入可行性、确定性衰减）+ 本地源码查证。
> 用户拍板（提问工具确认）：①范围 = 全部（缓存注入混合形态 + 衰减优化 + 语义嵌入检索）；②注入形态 = 混合（system 稳定快照 + user/message 实时检索）；③本体/KG = 不引入。

## 背景与决策记录

### 研究结论（证据化，详见各子代理报告）
1. **缓存感知注入（高价值）**：DSH 走 DeepSeek 自动前缀缓存（严格前缀匹配、无需显式标记），flash 命中价差约 **50×**（0.02 vs 1 元/百万，官方价格页）。当前注入器（injector.ts:106-111）**每步实时检索渲染**，内容逐轮变化，注入段无法命中缓存。已查证：`ctx.systemPrompt.context()` 是 provider 形态（每次 assemble 求值，可拿 `AssembleContext.agent`），context 段物化为 **user-role 快照**（agent-loop:500 runtimeContext.project）——快照化（窗口内字节稳定）即可保持前缀缓存命中。
2. **确定性衰减（中价值）**：现有 scoring.ts 已是乘性三维（relevance × recency × importance）。业界证据（Scrub Jay、Learning What to Remember、Adaptive Recall、Mem0）：**无差别时间衰减伤害高重要度长期记忆**；衰减是 relevance 之上的软偏置、永不归零；importance 应影响衰减速率（magic-context decay-curve：imp 越高半衰期越长）+ 高重要度保活（salience floor）。supersede（事实被推翻）与衰减（陈旧噪音）互补，前者已实现。
3. **语义嵌入检索（用户拍板纳入）**：`@huggingface/transformers@4.2.0` + `Xenova/all-MiniLM-L6-v2`（q8 量化 21.9MB），Node 18+ 官方支持，本机实测单条嵌入中位 2.5ms、批量 1260 条约 1.2s。**依赖体积 +374.9MB**（onnxruntime-node 210MB 全平台打包）是主要成本。国内网络需 hf-mirror.com（已实测可达；模型文件已下载至 `%TEMP%\dsh-embed-bench\models\` 可复用）。
4. **本体/KG 不引入**：Mem0 论文实测图变体输给纯向量并已删图模块；Letta 基准纯文本文件 74% 反超 Mem0g；Graphiti 无轻量部署选项且缺遗忘原语（ForgetEval：遗忘失败 > 召回失败）；dsh-memory 的 supersede 链已是遗忘原语。

### 项目约束（沿用）
- 禁防御性/兜底代码（降级必须显式配置 + 明确错误，不 try/catch 吞错）
- 不向后兼容；TDD；每阶段 git 提交；中文注释/提交；模块化、SOLID/DRY/KISS/YAGNI
- 模型/依赖不进入 git 仓库（.gitignore）

## 阶段划分与验收标准

### P1：System 稳定快照注入（缓存感知 · system 侧）
**目标**：注册 `ctx.systemPrompt.context()` 段，提供"按 workspace 的稳定记忆快照"，窗口内字节不变 → 前缀缓存命中。

**新模块** `src/snapshot.ts`（SnapshotService）：
- 快照内容：`store.search` 的变体——按 importance 降序 + 最近活跃，预算内 top-N（`snapshotBudgetChars` 默认 8192）；排除 superseded（沿用 store 语义）
- 缓存：`{ workspace, text, ids, revision, expiresAt }`；**TTL（`snapshotTtlMs` 默认 300_000=5min）+ store 变更版本（revision）任一触发重建**
- store 增加 `revision` 计数器：create/update/archive 成功落盘后递增（供快照失效判定）
- 注册：`ctx.systemPrompt.context({ name: 'memory:snapshot', order: 固定值, text: (c) => 快照文本 })`——provider 内取 `c.agent.session.header.cwd` 过滤 workspace；快照为空返回 `''`（空文本不贡献）
- 作用域：插件在宿主根作用域注册（与现有 memory 插件一致），provider 按 agent 区分

**验收**：单测——同窗口两次调用字节相同；TTL 到期/revision 变更后重建；不同 workspace 内容隔离；空库返回空串。全量测试绿。git 提交。

### P2：实时注入排除快照（user/message 侧联动）
**目标**：混合形态去重——实时检索（injector.ts:106-111）排除快照已含 id，避免同一记忆重复进 system 快照与实时包。

**改动** `src/injector.ts`：注入依赖 SnapshotService；`fresh` 过滤追加 `!snapshot.ids.has(id)`。

**验收**：单测——快照含的记忆不进实时包；快照重建后新记忆可进实时包。全量绿。git 提交。

### P3：确定性衰减优化（scoring.ts）
**目标**：importance 感知半衰期 + 高重要度保活，保持乘性结构（relevance 主导）。

**改动** `src/scoring.ts`：
- `recencyFactor` 扩展为 importance 感知：`halfLifeDays = 7 × 2^((importance - 5) / 2)`（imp 5→7d、7→14d、9→28d、10→39.6d）
- salience floor：`importance ≥ 8` 时 `recency = max(recency, 0.5)`（保活，参照 Adaptive Recall protected / Mem0 floor）
- 现有 `memoryScore` 公式结构不变，只替换 recency 计算

**验收**：单测——半衰期随 importance 单调增长；floor 生效/不生效边界（imp 7 vs 8）；imp 0/10 边界；现有 scoring 测试不回归。全量绿。git 提交。

### P4：语义嵌入检索（embedding 服务 + 融合检索）
**目标**：关键词 0 重合但语义相关的记忆可被召回；融合排序。

**新依赖**：`@huggingface/transformers@^4.2.0`（唯一新增运行时依赖）。

**新模块**：
- `src/embedding.ts`（EmbeddingService）：
  - 配置 `embedding.enabled`（**默认 false，显式启用**——模型文件/体积是有意取舍，非兜底）；`embedding.modelDir`（默认 `<数据目录>/embedding-model`）
  - 加载：`pipeline('feature-extraction', ..., { dtype: 'q8' })`，`env.localModelPath` + `env.allowRemoteModels=false`（离线）
  - **初始化失败 → `EmbeddingUnavailableError`（含原因与修复指引），绝不静默降级**；未启用时语义检索不注册（纯关键词路径）
  - API：`embed(text): Promise<Float32Array>`、`embedMany(texts): Promise<Float32Array[]>`、`cosine(a, b): number`
- `src/embed-index.ts`（EmbeddingIndex）：
  - 持久化独立文件 `<数据目录>/memory-embeddings.json`（`{ [id]: number[] }`，384 维；1260 条 ≈ 2MB，可接受）——**不污染 memory.json 条目 schema**
  - 维护：启动时缺失条目批量构建（~1.2s/1260 条）；create 后增量（await 嵌入，单条 ~2.5ms）；archive/update 移除/重建
  - 存储域：复用 `ctx.storageDomain`（与 memory.json 同域）或直接 fs？——实现时查证 storageDomain 是否允许第二张表（`table()` 多表支持），否则用独立 KvTable
- `src/store.ts` search 融合（或 `src/search.ts` 新模块）：双路检索（关键词 relevance + 语义 cosine）→ 融合分 `final = 0.5 × relevance + 0.5 × cosine`（两者均归一化 0..1）；关键词 0 分但语义相关者可进入 top-K
- `scripts/download-embedding-model.mjs`：从 hf-mirror.com 下载模型文件到数据目录（可选执行；已下载文件可复制复用）

**验收**：单测（cosine 数学、融合排序、0 重合语义召回用例、pipeline mock 注入、EmbeddingUnavailableError 显式抛出）；全量绿；真机（3090）验证索引构建与融合检索。git 提交。

### P5：文档与部署
- README：新配置表（snapshot*/embedding*）、模型下载脚本、依赖体积说明（+374.9MB 取舍）、缓存收益说明
- profile 部署同步（pnpm install 刷新 file: 副本）；模型文件复制到 profile 数据目录
- 真机验证（3090 + playwright）：system 快照段出现且稳定；注入排除生效；`cacheReadTokens`（usage 可观测）快照前后对比
- STATUS.md 更新；git 提交

## 风险与未决
1. **P4 依赖体积 +374.9MB**（onnxruntime-node 全平台打包）——与"轻量插件"定位的冲突，已在拍板时告知，配置默认关闭可回避运行时成本
2. **system context 物化位置/缓存行为**需真机验证（usage cacheReadTokens 观测）——P5 验证项
3. **快照预算与实时预算的分配**（8K + 16K chars）为初始值，真机观察后调整
4. 嵌入索引存储域实现细节（storageDomain 多表支持）——P4 实施时查证，若受限改用独立文件

## 参考来源
- DeepSeek Context Caching：https://api-docs.deepseek.com/guides/kv_cache/
- Anthropic 前缀缓存：https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything
- Scrub Jay：arXiv:2608.04746；Learning What to Remember：arXiv:2606.12945；Adaptive Recall（IDFS）
- magic-context decay-curve（TIER_COST=[0,322,109,35,20,5]，Z=[0.201,0.729,1.322,2.587]）
- Mem0 图模块删除实证：arXiv:2504.19413；Letta 纯文本基准：https://www.letta.com/blog/benchmarking-ai-agent-memory
- transformers.js Node 教程：https://huggingface.co/docs/transformers.js/en/tutorials/node
