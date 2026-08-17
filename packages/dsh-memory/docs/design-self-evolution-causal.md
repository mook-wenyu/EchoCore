# dsh-memory「自进化 + 因果链」设计说明

> 交付物之一（实施前拍板与权威证据的落档）。主代码见 `src/reflect.ts`、`src/causal.ts` 及接线
> （`maintenance.ts` / `index.ts` / `tools.ts` / `host-rpc.ts`）。

## 一、背景与目标

dsh-memory 是 DSH 智能体框架的记忆插件：会话流式提取（`extract.ts`）、纯规则维护
（`maintenance.ts`：Jaccard 去重 / 过期降级 / 标签归一）、SQLite 存储（`store.ts` +
`sqlite-kv.ts`）、语义检索（vec0 KNN）。本任务为它补两类能力：

1. **LLM 反思自进化**——周期性地让 LLM 审视已有记忆条目之间「规则看不见的」语义近似重复
   与跨条目矛盾，只执行**可逆的「归档一侧」**动作。
2. **记忆因果链**——在条目之间建立有方向的因果边（source 是 target 的因/前提），
   用独立边表存储、维护周期批量增量抽取；首版**保守利用**（仅供洞察与审计展示，不做检索扩散）。

## 二、拍板结论（2026-08-17，ask_user_question 四项确认）

| 决策点 | 结论 | 依据 |
|---|---|---|
| 反思触发 | 维护周期自动跑（周期门控）+ 手动工具 `memory_reflect` + RPC `reflect` 端点 | 两入口共享 `MemoryReflector.runOnce` 纯函数；自动兼顾、手动可干预 |
| 因果链数据模型 | **独立边表** `memory_causal_edges`（source/target/relation 复合键、幂等、带置信/来源/审计） | Graphiti/Wikidata 权威倾向；B′ 证据；SqliteKvTable 泛型天然支持第二张表 |
| 因果链检索利用 | **保守首版：仅洞察/审计上下文**（`memory_audit` 因果视图），检索主路径零改动 | 「方向扩散更优」无直接论文证明；CS-RAG 三元组 ~68% 正确率不宜进检索主路径；注入硬预算防污染铁律 |
| 反思动作集 | **仅可逆「归档一侧」动作**：语义近似重复合并（保留新者/重要度取更大值）+ 跨条目矛盾归档；禁内容改写、禁单次 importance 重打分、禁无来源合成 insight | A′ 负面证据：Manufactured Confidence（de-hedge）、AAAI'25 Choice-Supportive Bias、Useful Memories Become Faulty |

## 三、反思模块 `reflect.ts`

- `MemoryReflector.runOnce(route, {force?})`：周期门控（`REFLECT_INTERVAL_MS`，缺省 force 未到期跳过）；
  route 缺省回退缓存的上次路由（RPC 无会话场景）；全程自收容不抛错。
- 候选选择 `selectReflectionPairs`：对 `listRecent(REFLECT_WINDOW,'active')` 取焦点
  （重要度降序→创建时间倒序，前 `REFLECT_FOCUS_BUDGET`），peer = tokenJaccard 落在带
  `[0.15, 0.85)` 的 active 条目（0.85 以上是规则合并域、0.15 以下太弱），每焦点取前
  `REFLECT_PEERS_PER_FOCUS`。
- LLM 输出 `{"decisions":[{focusId, peerId, action, reason}]}`，action ∈
  `merge`（语义重复）/`archive`（矛盾）/`none`；严格解析。
- 执行前逐条 `store.getById` 重读（防归档/被覆盖竞态），任一非 active/被 supersede/跨
  workspace → skipped。`merge`：归档较旧者 + `store.update(较新, importance=更大值, 'system')`；
  `archive`：归档较旧者。审计 `by:'system'`，detail 带依据 id 与 reason。
- 观测：`ReflectionSummary{ reviewed, decisions, merged, archived, skipped }`，
  `lastRunAt`；经 `RuntimeHealth` 透出到 `memory_status` / RPC status。

## 四、因果链 `causal.ts`

- `MemoryCausalStore`：`upsertEdge`（复合键 `sourceId\0relation\0targetId` 幂等、add-only
  不覆盖）、`listEdges`、`edgesOf(id)`、`removeEdgesFor(id)`（归档联动孤儿清理）。
- `MemoryCausalExtractor.runOnce(route, {force?})`：周期门控（`CAUSAL_INTERVAL_MS`），
  对 `listRecent(CAUSAL_WINDOW,'active')` 截前 `CAUSAL_BUDGET` 一次给 LLM，输出
  `{"edges":[{sourceId,targetId,confidence,justification}]}`；建边前校验两 id 存在/active/
  非 superseded/同 workspace/非自环/confidence ≥ 0.6；`source` 取 sourceId 侧条目的 source。
- 边只带方向与置信，不做图遍历（v1 检索保守）；环检测/路径扩散留给未来（文件头注释声明）。

## 五、接线

- `maintenance.ts`：`MemoryMaintenanceDeps` 增 `reflector?`、`causal?`（可选，测试与旧调用
  兼容）；`runOnce` 在规则任务 a/c/d 之后分别调用两者（各自自收容）。
- `index.ts`：装配 `memory_causal_edges` 表 → `MemoryCausalStore` → `MemoryCausalExtractor` →
  `MemoryReflector`；store `onArchive` 钩子联动 `removeEdgesFor`；`registerMemoryTools` 传
  causal/reflector；`registerMemoryRpc` 传 reflector；`runtime` 透出 lastReflectionAt/reflection/
  lastCausalAt/causal。
- `tools.ts`：新增第 7 个工具 `memory_reflect`（从 exec 会话解析路由、force 触发）；
  `memory_audit` 顶部追加可选 `causal` 视图（出边=本条 causedBy，入边=本条 causeOf）。
- `host-rpc.ts`：`createMemoryRpcHandler(store, rpc, runtime, reflector?)` 增 `reflect` 端点；
  status 透出反思/因果观测。`toDetail` 不扩展（避免破坏 output schema 覆盖回归测试）——
  因果只作 audit 顶层可选字段。

## 六、证据引用

- A′ 报告：`docs/research-report-reflection-self-evolution.md`（MemGPT/Letta、mem0
  ADD-only、Zep/Graphiti invalidate、ExpeL 投票、AAAI'25 Choice-Supportive Bias、
  Useful Memories Become Faulty(2605.12978)、Recalling Too Well、Manufactured Confidence）。
- B′ 报告：CausalRAG/CausalRAG2/HugRAG、HippoRAG/2、Graphiti、Wikidata 因果本体（P1542/P1536）、
  SQLgraph（边表优势）、CS-RAG（抽取错误率与 semantic flips）、Dir-GNN（方向非普遍有益）；
  「仅因果方向扩散优于无向扩散」未找到直接证据 → 首版保守。
- 本地自证：store.update 白名单 {kind,importance,tags}（禁 content）、archive 无 detail、
  MemoryEntry 无 causal 字段、maintenance 无 llm、SqliteKvTable 泛型可加第二张表、
  ctx.llm 直透 extractor。

## 七、后续 A/B（有意预留，首版不做）

1. A/B-1：因果路径**精度过滤**（CausalRAG2 式因果门）——预期提精度/一致性，有直接影响。
2. A/B-2：方向扩散 vs 无向扩散对召回——无证据，需本库 Recall@K 自行 A/B 后再决定。
3. A/B-3：importance 累积投票修正（ExpeL 风格）——需多轮信号数据源（第三方写者）就绪后。
