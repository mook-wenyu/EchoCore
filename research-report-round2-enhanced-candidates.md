# 第二轮权威证据检索：dsh-memory 四个开放增强候选

> 只读网络调研。聚焦四主题，判断「是否值得做 + 怎么做」，每结论附来源 URL 与单段论证。
> 背景：dsh-memory = DeepSeek Harness 会话记忆插件（sqlite-vec vec0 向量 + 关键词 IDF+语义 KNN + RRF(k=60) 融合；LLM 提取/反思/因果；importance=LLM 单次 1-10 + 自适应半衰期/访问频率调制；因果=独立边表仅审计不入检索；检索=关键词独立召回路径 + RRF 双榜融合）。

---

## 主题 1：importance 累积投票 / 多因子稳健化

**结论：值得做，但别上「学习权重」——做轻量多因子融合 + 累积/访问反馈强化，收益明确。** 单次 LLM 打分被多条独立来源证明既不可靠（随模型版本漂移）又贵（每次写多一次调用）。

**来源：**
- arXiv:2606.12945（Learn What to Remember）——学习多因子 0.770 ±0.011 vs 均匀权重 0.657 vs 最优单因子 0.518 vs recency-only 0.368（盲区 479 例，bootstrap 95% CI）。https://arxiv.org/html/2606.12945v1
- Hindsight《The Consolidation Problem》——明确批评 Generative Agents 式 LLM 单次 1-10 打分「ratings drift across model versions」「adds a model call per write，高吞吐下贵」。https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation
- mem0《Memory eviction and forgetting》——纯访问频率（LRU）代理「breaks for low-frequency, high-stakes data」（低频高价值事实如过敏史会被剪掉），主张多信号融合而非任一单信号。https://mem0.ai/blog/memory-eviction-and-forgetting-in-ai-agents
- arXiv:2607.22562（SF-AMS）——Composite Importance Scoring：实体+语义+冗余+时间多信号映射为统一 importance，效果超 LightMem/Mem0/A-Mem；LoCoMo multi-hop 最大增益 +9.65 F1。说明「多信号累计」是 2026 主流路线。https://arxiv.org/html/2607.22562

**论证：** 这一主题的实证是「单因子弱、多因子强」，且不是靠手工权重的玄学：Learn What to Remember 证明在**盲区（看不到评估题）**下，学习权重的多因子（0.770）显著优于任何单因子（0.518）和 recency（0.368），这正是 dsh-memory 现状（LLM 单次打分 + 半衰期）与最优之间的理论差距。但「学习权重」在插件里成本过高（每个记忆背后要一个下游目标+训练回路）。更务实的是 mem0/Graphiti/性能侧已实践的多因子硬编码加权（recency+relevance+importance+access frequency）——Typegraph 的工程总结直接给「composite scoring 拿到 80% 价值，剩下 20% 来自情绪权重/surprise/显式检索强化」。**dsh-memory 落地**：保留 LLM 单次 1-10 作为 importance 因子之一，叠加访问频率（retrieval 命中即 +）、重复提及（同义记忆合并次数）、和可选的 surprise/冗余惩罚，做归一化加权融合而不是再训一个模型。注意每加一个因子都有成本，先加「访问频率累积」这一个（现有代码已有访问频率调制，属平滑扩展），验证后再说多因子。

---

## 主题 2：反思 / consolidation 质量度量钩子

**结论：值得做——但度量的不是「反思后是否更准」，而是「不劣化 + 矛盾率/过时率下降」。** 关键事实：**consolidation/dedup 没有公开标准基准**（Mnemoverse 评测表明确标注 "Consolidation / dedup — no standard public benchmark"）。

**来源：**
- Mnemoverse《How to Evaluate AI Agent Memory》——明确 consolidation/dedup 用「contradiction rate + staleness」度量（无标准基准），并给出 recall@k / precision@k 定义。https://mnemoverse.com/docs/research/evaluation/evaluating-agent-memory
- PrecisionMemBench（tenurehq）——专门测 retrieval precision / noise isolation（drift）/ belief mutability，且实测「多数系统 recall 高但 precision 仅 0.05-0.09」——高 recall 不等于精确检索。https://github.com/tenurehq/precisionmembench
- arXiv:2605.15384（SEQMEM-EVAL）——**最重要方法论警告**：单分聚合指标（最终正确率）会掩盖遗忘与负迁移，「higher final accuracy ≠ better memory」；应测 online utility / hold-out generalization / backward transfer / forgetting。https://arxiv.org/html/2605.15384
- arXiv:2606.29914（MemDelta）——受控评估协议：检索质量是最大单一效应（no-memory 2% → basic RAG 47%，+45pp），**模型/嵌入/写路径成本各能放大或反转 14-31pp**；要求 budget-matched 对照。https://arxiv.org/html/2606.29914
- remem evals（开源记忆系统）——现成可抄的 consolidation 钩子：`contradiction_rate`、`consolidation_quality`（/10）、`recall@k`、`staleness`，且带 `--baseline` 回归对比。https://github.com/remem-io/remem (evals/benchmark.py)

**论证：** dsh-memory 的反思是「LLM 判语义近重复/矛盾，只归档一侧（append-only）」——这恰恰是评测文献里最难也最缺基准的一环。业界共识不是「证明合并后答案更准」（那被 MemDelta 证明极易被模型/预算混淆项污染），而是**后验离线度量不劣化**：反射前 vs 反射后跑同一组 planted-facts 探测集，测 recall@k 不降、矛盾率/过时率(staleness)下降、dedup 后存储体积下降。SEQMEM-EVAL 直接警告单分自欺，所以 dsh-memory 应做**多维小套件**而非一个分数。**落地**：加一个只读 eval 钩子，维护一个小的「planted facts + 矛盾对 + 过时对」探测集，反射前后各跑一轮记录四指标 delta；成本低（纯度量、不进检索路径），且给「是否真的变好」提供可归因证据——规避 MemDelta 的混淆陷阱。这是四主题里实现成本最低、权威支撑最完整的一个。

---

## 主题 3：因果路径精度过滤（CausalRAG2 等）

**结论：值得做，且是四者中权威证据最「直接命中」的一个——但要做的是「因果边建边时加置信/来源校验」，不是建完整 RAG 因果图。** CausalRAG2 的消融直接证明「门/边的精度决定检索质量」。

**来源：**
- arXiv:2602.05143（CausalRAG2, ICML 2026）——表 6 消融：Causal 门 F1 31.62，但 **FP+25%（掺 25% 随机假因果门）F1 掉到 27.87**，FN-25% 掉到 28.60；结论「retrieval quality scales with the precision of the gates」。专家双盲验证因果门 95.5% 有效（92% 一致率）。https://arxiv.org/html/2602.05143v2
- 同上附录 H.2——因果判定稳定性依赖模型容量：Qwen3-4B Jaccard 0.96、GPT-oss-120B 0.85、Llama-3.2-3B 只有 **0.53**。→ 小模型做因果校验不可靠，需大模型或降级策略。
- arXiv:2503.19878（CausalRAG 原版）——识别因果路径时多一次 LLM 若、LLM 内部知识在医学/法律等专用域会不够。https://arxiv.org/html/2503.19878v3
- ACL 2026《LLMs as Knowledge Graph Refiners》——关键反面：只做「correctness-only 二元过滤」不够，GKE（生成式知识抽取）还产生 representation-level 不一致（entity span 不精确），需要「编辑/重写」而非单纯删边。https://aclanthology.org/2026.acl-long.1353.pdf
- AAAI《Towards Trustworthy KG Reasoning》——用 conformal prediction 给「检索路径/邻居」错误率上界，用不确定性替换 heurisitic Top-K。https://ojs.aaai.org/index.php/AAAI/article/download/33353/35508

**论证：** dsh-memory 关于「CS-RAG ~68% 三元组正确率背景下，要不要在因果边进检索前加置信/来源校验」的疑问，CausalRAG2 给出了几乎定量的答案：把因果边精度从 95.5%（人工校验后）降到掺 25% 假边，检索 F1 从 31.62 掉到 27.87——**假因果边是强负贡献者，精度过滤收益明确**。落地建议不是 dsh-memory 现在重造 CausalRAG2 的层级因果图（那是文档级超大工程），而是做两件低成本事：① 因果边建边时加**来源引用 + 双向/时序自洽校验**（A→B 需同时满足时间先序与来源同一，呼应 CS-RAG 的增强手段）；② 进检索前设**最低置信门限**，低于门限的边只留在审计表（dsh-memory 现状正是「仅审计不入检索」，天然是安全的——只需把「是否入检索」从全有全无改成「置信≥阈值才入」）。注意模型容量结论：若封装插件常用小模型，因果置信校验可能不准（Jaccard 0.53），须用大模型跑或标注「未校验」。GraphRefine 的「编辑而非删」提示：不要只丢弃可疑边，可保留带 low-confidence 标记、待后续合并修正。

---

## 主题 4：BM25-as-boost vs 混合检索

**结论：建议改——dsh-memory 当前「关键词独立召回路径 + RRF 双榜融合」与 2026 主流（mem0 v3）「BM25 仅作 boost、只提升排序不加候选」直接冲突，而主流是被 +20/+26 benchmark 点验证的。** 但需权衡：dsh-memory 的 IDF 关键词路径有「纯语义抓不到的精确词/专名召回」价值，改成纯 boost 会损失这一召回能力——所以正确做法是「保留关键词候选能力，但把权重/排名逻辑从平行双榜改为带增益的融合」。

**来源：**
- mem0 v3 官方迁移文档（权威，一手）——原话：「**BM25 is a boost signal, not a recall expander.** Only semantic search results are candidates: BM25 and entity scores boost ranking but don't add new candidates.」https://docs.mem0.ai/migration/oss-v2-to-v3
- mem0 PR #4805——v3 实现：hybrid = (semantic + bm25 + entity_boost)/max_possible，additive scoring；LoCoMo 71.4→91.6、LongMemEval 67.8→93.4。https://github.com/mem0ai/mem0/pull/4805
- Supermemory 混合检索指南——数据：dense-only recall@10 78%、BM25-only 65%、hybrid+RRF 91%；BM25 强在精确标识符（SKU/错误码/专名）。https://supermemory.ai/blog/hybrid-search-guide
- Atlan/Know：《BM25 handles exactly those cases（精确标识符）that pure dense fails on》——但这是「召回覆盖」，恰好说明 mem0 把 BM25 排除出候选是在**有意牺牲**这一覆盖，换取 precision 与控制。https://atlan.com/know/hybrid-rag
- digitalapplied 参考表——BM25 单独在「精确关键词/产品码」查询上支配，语义在「改写/语义」上支配，混合+RRF 在「混合意图」上胜——**递归地说明：关键词独立召回在精确词场景仍有独立价值**。https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026

**论证：** 一条关键的细微差别：混合检索的一般文献（supermemory/atlan/digitalapplied）支持「关键词+向量 RRF 融合」并给出 recall 增益（91% vs 78%），**看起来支持 dsh-memory 现状**；但 mem0 v3 作为最权威的一手工程证据却反其道而行——明确把 BM25 降为 boost、排除出候选产生者。这两者不矛盾，而是不同选择：一般 RAG 强调召回，mem0 强调 precision 与控制（`threshold=0.1` 默认过滤噪声就是同思路）。对 dsh-memory 的判断应基于它是**会话记忆库**还是**文档 RAG**：记忆库的查询更偏「专名/偏好/事实」而非泛语义长文，关键词独立召回的精确词价值真实存在（digitalapplied 证明 BM25 在精确词场景支配）。所以**不建议照抄 mem0 删掉关键词独立召回**；建议**保留关键词作为独立候选，但引入 mem0 的教训**——① 给 BM25 分设噪声下限（threshold），避免低相关精确词污染；② 认识到双榜 RRF 与 additive boost 的差异仅在于「关键词命中的项是否可单独进榜」与「同分融合权重」，可加参数在两者间切换做 A/B。改动小，风险低，且有 mem0 与混合文献两个方向各自背书。

---

## 汇总表

| 候选 | 权威支撑度 | 实现成本 | 对我方收益 | 建议 |
|---|---|---|---|---|
| 1. importance 多因子/累积融合 | ★★★★（LearnWhatToRemember 0.770vs0.518 + SF-AMS 多信号 + Typegraph 80% 规则；无后续复现的纯学习权重路径）| 中（保留单次打分，加访问频率/重复累积因子，归一化融合）| 高：直击「单次打分不可靠+漂移」痛点，鲁棒性提升 | **做**：轻量多因子融合 + 访问频率累积；不学权重 |
| 2. 反思/consolidation 质量度量钩子 | ★★★★★（方法论最扎实：SEQMEM-EVAL 多维警告、MemDelta 混淆控制、Mnemoverse 明确无标准基准、remem 现成实现）| 低（只读探测集 + 反射前后四指标 delta）| 高：让「是否真变好」可归因，规避自欺 | **做**（最低成本最高信心）：多维离线 delta 度量钩子 |
| 3. 因果边置信/来源校验 | ★★★★★（CausalRAG2 消融 FP+25%→F1 31.62→27.87 直接定量；GraphRefine 编辑而非删；conformal 上界）| 中（建边时来源+时序/双向校验 + 入检索置信门限；小模型容量警告）| 高：当前「仅审计不入检索」的升级是有理可依的高杆| **做**：置信门限决定「是否入检索」，保留审计，序列校验增强；大模型跑校验 |
| 4. BM25-as-boost vs 独立召回 | ★★★★（mem0 v3 一手「boost not recall expander」+20/+26 vs 混合文献「关键词独立召回在精确词场景有价值」）| 低-中（保留关键词候选，加 threshold 下限；或加 additive 开关 A/B）| 中：当前 RRF 双榜并非错误，但可吸收 mem0 的噪声控制教训 | **改（保守）**：保留关键词独立召回，加噪声阈值；不当成 recall 展开器去重复召回 |

### 未找到权威来源 / 存疑点
- 「学习权重的 importance 累积」除单篇 Learn What to Remember 外**未找到工程复现**（mem0/LangMem 均用硬编码加权而非学习权重）——学习权重路径证据孤立，不推荐在插件里做。
- 反思的「consolidation_quality /10」分数（remem）是启发式自评，无外部标准，只作内部回归基线，不可作绝对质量度量。
- CS-RAG ~68% 三元组正确率这个具体数字本轮未在我检索到的正文里直接核到（多为二手引用）——标注**未核实的二手数字**；但 CausalRAG2 的 95.5% 与 FP 消融是本轮直接抓到的正文数据，可作替代依据。

*（memory_note 写入因工具序列化限制失败，本轮结论以本文件为准。）*
