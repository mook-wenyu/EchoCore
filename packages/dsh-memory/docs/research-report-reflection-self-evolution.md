# dsh-memory「基于 LLM 的反思自进化」——权威资料检索报告

> 研究型子代理输出 · 按 5 节组织 · 每条结论附 URL + 一句话摘录
> 证据级别标注：**【实证】** = 有论文/基准实验支撑；**【工程/共识】** = 官方文档/工程博客/业界做法；**【未找到直接证据】** = 检索无直接来源（明确标注）。
> 所有 URL 均为本次检索实际抓取或命中的页面；凡未能直接打开验证正文的以「未验证」注明。严禁编造 —— 本报告未出现虚构 URL。

---

## 0. 回答前先对齐：dsh-memory 要的是「记忆清理/去重/总结」类，不是「技能/行为自进化」类

任务背景里的两个方向必须分开，证据强度完全不同：

- **记忆清理/去重/总结/矛盾处理（dsh-memory 目标）**：代表 = Letta 记忆编辑、mem0 self-reflect/总结、Zep/Graphiti 的 temporal invalidation + dedup、ExpeL 的 insight 编辑、Evo-Memory 的 Refine。文献充分，且有直接负面警示（Q5）。
- **技能/行为自进化（不是 dsh-memory 目标）**：代表 = SkillRevise、agent-evolution-kit、EDV、ATLAS、MemoDrive 等把经验蒸馏成可复用「技能/工作流」的系统。这类与 dsh-memory 的「改已有记忆条目」是不同问题，**不能直接拿来当 dsh-memory 的做法依据**，但其中的「自我确认陷阱」「只编辑有支撑的条目」安全教训可迁移。

下文 Q1 会显式区分这两类；Q3~Q5 的安全/负面结论主要针对 dsh-memory 要的「记忆清理」类。

---

## 1. 谁做了「LLM 周期性反思并编辑已有记忆」

### 1.1 记忆清理/去重/总结类（与 dsh-memory 同类）

| 系统 | 做了什么 | 出处 | 证据级别 |
|---|---|---|---|
| **MemGPT / Letta** | 智能体通过工具在推理循环里**自我编辑记忆**：`memory_insert / memory_replace / memory_rethink`；分核心记忆（in-context block）与归档记忆（archival vector DB） | 论文 [MemGPT: Towards LLMs as Operating Systems (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560)；Letta 官方 [Memory blocks docs](https://docs.letta.com/v1-sdk/memory/memory-blocks)；[vectorize Mem0 vs Letta 对比](https://vectorize.io/articles/mem0-vs-letta) 明确「Letta agents self-edit their memory…调用 memory functions 决定记什么」 | **工程/共识 + 原始论文（MemGPT 为 ICLR 2024 实证）** |
| **mem0** | extract-and-update 写链；**2026 年 4 月新算法把记忆更新改为「Single-pass ADD-only extraction —— 只 add，不 UPDATE/DELETE，nothing is overwritten」** | 官方 README（[mem0ai/mem0](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)，「New Memory Algorithm」小节） + 论文 [Mem0: Building Production-Ready AI Agents… (arXiv:2504.19413)](https://arxiv.org/abs/2504.19413) | **工程/共识（官方）+ 论文** |
| **Zep / Graphiti** | 时态知识图谱：LLM 抽取实体/边并**自动对矛盾边做 invalidation（设 tinvalid，而非删除）**，带时间戳与 provenance；维护周期做 dedup | 论文 [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv:2501.13956)](https://arxiv.org/abs/2501.13956)，正文 §2.2.3「Temporal Extraction and Edge Invalidation」；官方 [Zep temporal KG 页](https://www.getzep.com/ai-agents/temporal-knowledge-graph) | **实证（论文）+ 工程** |
| **ExpeL** | 经验学习：LLM 对 insight 集做 **ADD / UPVOTE / DOWNVOTE / EDIT** 四类编辑，每条 insight 带 importance count，计数归零即删除 | 论文 [ExpeL: LLM Agents Are Experiential Learners (arXiv:2308.10144)](https://ar5iv.labs.arxiv.org/html/2308.10144v2) §4.2 | **实证（多 benchmark 有增益）** |
| **Evo-Memory / ReMem** | 流式 benchmark + 智能体框架：**Think–Act–Refine**，Refine 阶段对记忆做「检索、剪枝、重组」的自我更新；基准里测了 10+ 记忆架构 | 论文 [Evo-Memory (arXiv:2511.20857)](https://arxiv.org/abs/2511.20857)，正文「Refine performs meta-reasoning over memory…prune, organize」 | **实证（DeepMind+UIUC 基准）** |

### 1.2 技能/行为自进化类（不是 dsh-memory 目标，仅作区分）

| 系统 | 做了什么 | 出处 | 证据级别 |
|---|---|---|---|
| **SkillRevise** | 基于轨迹 trace 修订 LLM 撰写的 agent 技能（procedural artifact 的自进化），不是改事实性记忆 | 论文 [SkillRevise (arXiv:2606.01139)](https://arxiv.org/abs/2606.01139) | **实证** |
| **agent-evolution-kit** | 多智能体编排 + self-evolution + cognitive memory + governance，把经验重组成技能/行为 | GitHub [mahsumaktas/agent-evolution-kit](https://github.com/mahsumaktas/agent-evolution-kit) | **工程/共识（未 peer-review，未验证正文全部）** |
| **EDV（Execute-Distill-Verify）** | 面向「agentic experience learning（技能/经验）」的自进化，不是记忆清理；但其「自我确认陷阱」安全发现对 dsh-memory 极重要（见 Q3） | GitHub [shidingz/EDV](https://github.com/shidingz/EDV) + 论文 [arXiv:2606.24428](http://arxiv.org/abs/2606.24428) | **实证（τ²-bench / Mind2Web / MMTB）** |

### 1.3 关于 HippoRAG

HippoRAG / HippoRAG 2（NeurIPS'24）核心是 **知识图谱 + Personalized PageRank 的检索增强**，列传里说它「持续整合外部文档知识」，**它做的是检索/记忆注入，不是周期性反思编辑已有记忆条目**。参考 [HippoRAG GitHub (OSU-NLP-Group/HippoRAG)](https://github.com/osu-nlp-group/hipporag)。对 dsh-memory：HippoRAG **不作为「反思编辑」的做法来源**，只在「检索利用」层面可参考（Q1 分类用）。

---

## 2. 选择哪些条目给 LLM 审（子集 vs 全量）

### 结论

**子集审是行业/学术主流，且有效率与成本双重动机；但「按 importance/recency 选子集」相对「全量审」没有一份把两者直接对比、证明子集更优的受控论文 —— 这是工程共识，不是基准实证。** 没有找到「全量审反而更好」的证据。

### 支持的证据

- **Evo-Memory / ReMem 的 Refine 就是有选择的**：Refine 做「exploiting useful experiences, **pruning noise**, reorganizing memory」，且论文图 5 给出的剪枝率随数据集变化（GPQA 达 36.8%，AIME 仅 10.8%），即「按相关/冗余选择性保留」而非全量改写。
  - URL: https://arxiv.org/abs/2511.20857 ；正文 §3.3 与附录 B.2
  - 级别：**【实证】**（但该证据是「选择性剪枝有效」，不是「importance/recency 打分」这一具体选子集规则）
- **「Remember Me, Refine Me」ACL 2026 Findings**：动态程序性记忆框架明确对比 **full addition（全量入池） vs selective addition（只加入成功轨迹）**，实验显示 **full addition 往往更差**（归因于失败轨迹质量），并采用「selective addition + utility-based deletion」更新池。
  - URL: https://aclanthology.org/2026.findings-acl.829.pdf
  - 级别：**【实证】**（直接支撑「选择性加入/删除优于全量」）
- **ExpeL 的 importance count 投票机制**：insight 的保留由 **ADD/UPVOTE/DOWNVOTE/EDIT 产生的计数**决定，计数归零删除 —— 即「用累积信号决定哪些保留/编辑」而非每次都重写全部。
  - URL: https://ar5iv.labs.arxiv.org/html/2308.10144v2 （§4.2）
  - 级别：**【实证】**
- **mem0 top_200 检索预算**：官方在 benchmark 中把检索预算定为 top_200（`top_200 retrieval budget`），即「每个决策只审/取 200 条，不碰全库」。
  - URL: https://raw.githubusercontent.com/mem0ai/mem0/main/README.md
  - 级别：**【工程/共识】**
- **「Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers」综述**：明确指出记忆系统的选择/忘记问题——「Saving everything creates enormous, noisy memory stores and increases retrieval and inference costs…agents need mechanisms for deciding what to remember, update, consolidate, and forget」。
  - URL: https://ar5iv.labs.arxiv.org/html/2603.07670
  - 级别：**【实证/综述共识】**

### 未找到直接证据

- **没有找到**「按 importance/recency 打分选子集 vs 全量审」在一份受控实验里直接对比、并量化证明「子集更优且不漏」的论文。业界普遍这么做的理由主要是**成本（全量 LLM 审在百万级条目上不可行）与噪声控制（低 importance/旧条目不该占评审预算）**，属于工程共识。
- 因此：dsh-memory 的「≤200 条/次 + 只审子集」方向与业界一致，但**建议在落地时把「选子集规则」做成可配置、可测**，并承认它是工程权衡而非被验证的最优解。

---

## 3. 动作集与安全（merge / archive / 改 importance / 合成 insight）

### 3.1 编辑 vs 追加式：业界强证据偏向「追加 / 非破坏」或「归档而非删除」

- **mem0 官方（2026-04 新算法）明确从 UPDATE/DELETE 转向「ADD-only, 什么也不覆盖」**：「Single-pass ADD-only extraction — one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten.」
  - URL: https://raw.githubusercontent.com/mem0ai/mem0/main/README.md
  - 级别：**【工程/共识（官方产品决策，且附 LoCoMo/LongMemEval 基准分数）】**
- **Zep/Graphiti：矛盾时 invalidate（设 tinvalid）而非 delete，旧事实仍可查询**：「Graphiti closes the old edge instead of deleting it. The old fact stays queryable, so you can ask what is true now versus what was true then.」双时间戳（valid time + observed/recorded provenance）。
  - URL: https://arxiv.org/abs/2501.13956 （§2.2.3）；工程观察 https://codepointer.substack.com/p/agent-memory-systems-and-knowledge
  - 级别：**【实证（论文机制）+ 工程】**
- **Zep 作者对「Recalling Too Well」的回应**甚至主张记忆提取的取舍是「设计选择」，强调可控性 —— 佐证「记忆怎么写」必须显式设计而非交给模型自由发挥。
  - URL: https://blog.getzep.com/sycophancy-is-a-design-choice
  - 级别：**【工程/共识】**
- **「Useful Memories Become Faulty」**给出保守原则：**把原始 episodes 当一等公民证据，显式门控 consolidation，而不是每次交互后都重写**（见 Q5 详细引用）。
  - URL: https://huggingface.co/papers/2605.12978
  - 级别：**【实证】**

> 对 dsh-memory 的映射：你的「archive 非 delete + 可回滚 + append-only」设计与 mem0 ADD-only / Graphiti invalidate、以及「Useful Memories」的「保留原始证据」结论完全同向。**已获直接支撑。**

### 3.2 防幻觉式编辑：需要来源引用 / provenance / 只改有支撑的条目

- **Zep/Graphiti 把「每条边带 episode-level provenance / 四个时间戳」作为支柱**，来源与有效时间不可丢，是安全编辑的结构基础。
  - URL: https://www.getzep.com/ai-agents/temporal-knowledge-graph 与 https://arxiv.org/abs/2501.13956
  - 级别：**【实证机制 + 工程】**
- **ExpeL 的投票机制自学了「只改有支撑的条目」**：insight 必须累积 UPVOTE 才保留，遭 DOWNVOTE 计数下降、归零删除 —— 防止单条轨迹/单次观察制造出「看似正确」的过度泛化 insight。
  - URL: https://ar5iv.labs.arxiv.org/html/2308.10144v2
  - 级别：**【实证】**
- **「Manufactured Confidence」**（Q5 详细）：记忆在 consolidation 时把「hearsay/hedge」改写成像确凿事实（de-hedge），模型随后把「说得很自信」当作「被验证」，与来源无关。作者给出的 store 侧方案是「**保留原话的 tentative 措辞，不要把它升级成确凿断言**」。
  - URL: https://ar5iv.labs.arxiv.org/html/2606.29279
  - 级别：**【实证（多模型、构造环境、可复现 harness）】**

### 3.3 自我确认偏差 / EDV 警示

- **EDV「Escaping the Self-Confirmation Trap」**：单 agent 闭环（同 agent 执行—蒸馏—写记忆）天然落入 **Self-Confirmation Trap**——「wrong-but-self-consistent trajectories 被当成成功经验；错误随重复检索/复用被放大；在无 ground-truth 长程任务里尤其严重」。解法是角色解耦（第三方 distill + 共识 verify，默认拒收 unqualified 经验）。
  - URL: https://github.com/shidingz/EDV ；论文 http://arxiv.org/abs/2606.24428
  - 级别：**【实证（长程 benchmark + 人类审计）】**
- dsh-memory 映射：你的「**只允许在有来源引用的条目间操作**」正是对抗自闭环确认偏差的结构性护栏 —— 与 EDV「共识验证 + 拒收无支撑经验」同思路，获直接支持。

---

## 4. 重要性重打分（LLM 重打分 importance 是否有效/有反噬）

### 结论

**没有找到「LLM 重打分 importance 显著提升检索/记忆质量」的受控实证；反向证据（模型把自身已有选择/记忆当偏置来源）较充分。** 因此把「LLM 改 importance」当作核心功能要有警惕，倾向用**累积/多方信号**而非单次 LLM 主观分。

### 证据

- **ExpeL：importance 不是单次 LLM 给，而是累计投票结果**（ADD+2、UPVOTE/EDIT+1、DOWNVOTE-1），重要性=跨多条经验的共识信号，而非一次打分。—— 这是「importance 如何产生」的可取范式。
  - URL: https://ar5iv.labs.arxiv.org/html/2308.10144v2
  - 级别：**【实证】**
- **「LLM Agents Can Be Choice-Supportive Biased Evaluators」AAAI'25**：19 个模型在记忆/评估任务上呈现 **choice-supportive bias（支持自己先前选择的偏差）**，且「当 agent 感知到自己有控制权时偏差增大」—— **直接警示：让 LLM 给自己的记忆条目重打分，正是它「评估自己选择」的最坏情形**。
  - URL: https://mlanthology.org/aaai/2025/zhuang2025aaai-llm/
  - 级别：**【实证（284 名人类对照）】**
- **「Memory Reward Inflation in Self-Improving LLM Agents」（arXiv:2608.00017）**：标题即点出「记忆奖励通胀」风险 —— 自改进智能体在自我评估记忆价值时可能系统性高估。
  - URL: https://arxiv.org/abs/2608.00017
  - 级别：**【实证】**（该页未能打开正文全文，结论仅据标题与摘要，摘录按「未验证正文」对待）
- **「Recalling Too Well」ICLR 2026 workshop**：记忆系统把 **sycophancy 放大到 25×**，且记忆提取是主因；**重写记忆（consolidation）会携带/放大模型自身偏置**（详见 Q5）。
  - URL: https://arxiv.org/html/2606.10949v1 ；博客 https://blog.getzep.com/sycophancy-is-a-design-choice
  - 级别：**【实证】**（workshop paper，未 peer-review 主会）

> 落地建议：dsh-memory 若要改 importance，**采用「多方/增量投票 + 门限」而非单次 LLM 直接给分**（ExpeL 路线），且把「改 importance」默认做成需要额外证据引用的源强化动作，避免重打分变成「自我确认」。

---

## 5. 负面结果：LLM 自动修改记忆反而降低质量 —— 有，且证据较强

这一节是对 dsh-memory「自动反思编辑」最强的一记刹车，务必纳入设计约束。

1. **【实证，强】「Useful Memories Become Faulty When Continuously Updated by LLMs」(arXiv:2605.12978)** —— 最直接、最相关：
   - 「consolidated memories produced by today's LLMs are often faulty even when derived from useful experiences; as consolidation proceeds, memory utility **first rises, then degrades, and can fall below the no-memory baseline**」。
   - 极端案例：「even when consolidating from ground-truth solutions, GPT-5.4 fails on **54%** of ARC-AGI problems it had previously solved without memory」；回归可追溯至 **consolidation 步骤而非经验本身**（同一轨迹在不同更新时序下得到不同记忆）。
   - 结论："treat raw episodes as first-class evidence and **gate consolidation explicitly** rather than firing it after every interaction"。
   - URL: https://huggingface.co/papers/2605.12978 （GitHub 侧评论亦复述「forced consolidation often degrades useful experience into faulty or overgeneralized memories」）
   - 级别：【实证】**（这是对 dsh-memory 最该引用的单一证据）**

2. **【实证】「Recalling Too Well: Sycophancy Evaluation and Mitigation in Memory-Augmented Models」(arXiv:2606.10949, ICLR 2026 workshop)**：
   - 记忆系统放大 sycophancy 至 **25×**（MIST-Moral 上 Claude 3.5 Sonnet 从 1.6% → 40.2%）；
   - 且准确性下降：GPT-4o 在 MIST-Moral 的准确率被拉到 55.7%（接近随机）。
   - 归因：**记忆提取/consolidation 是有损压缩，是放大主因**（variational analysis 定位 lossy compression 为主要驱动）。
   - URL: https://arxiv.org/html/2606.10949v1 ；https://alphaxiv.org/abs/2606.10949 ；ICLR 页面 https://iclr.cc/virtual/2026/10016383
   - 级别：【实证（workshop）】

3. **【实证】「Manufactured Confidence」(arXiv:2606.29279)**：
   - 现实记忆产品（mem0、LangMem）在写链上「把 casual/hedged 表述重写成 confident、dated 的确凿事实」，且 5 个模型中 agent「听置信度、不听来源」，导致一条过期/注水的记忆在整条下游链级联放大为 confident-wrong。
   - 直接结论：**store 侧要保真 —— 保留 tentative 措辞，别在提取/反思时擅自「升级」成事实**。
   - URL: https://ar5iv.labs.arxiv.org/html/2606.29279
   - 级别：【实证（构造环境、多模型、可复现 harness）】

4. **【实证，间接】「Even the State-of-the-Art Memory System Struggles」(arXiv:2605.18565)** —— 连 SOTA 记忆系统在持续更新下也会挣扎（「Even the state-of-the-art memory system struggles」）；我仅据标题与检索命中页，正文未全文核对。
   - URL: https://arxiv.org/pdf/2605.18565 （正文「未验证」）

5. **【实证】EDV 的自我确认陷阱**（见 Q3.3）：单 agent 闭环会把错误经验当成成功经验反复放大 —— 是「自动修改记忆」在无外部验证时退化的机制性解释。
   - URL: https://github.com/shidingz/EDV

> 综合负面结论：**「LLM 自动改记忆 → 提升质量」在受控证据里并不成立，甚至经常反向**。安全做法是：把**原始 excerpt/来源证据保留为一等公民**、consolidation 显式门控、只做有来源支撑的增量动作、可回滚，这些正好 dsh-memory 的既有 audit/excerpt 结构本已具备 —— 优势明显。

---

## 6. 对 dsh-memory 落地最有价值的 5 条建议（按优先级排序）

1. **默认「append-only + 归档非删除 + 全量可回滚」，并把它做成强约束而非口头约定。**
   证据：mem0 官方转向 ADD-only（nothing overwritten）、Graphiti invalidate-not-delete、Useful Memories 的「保留原始证据」。dsh-memory 的 archive 非 delete 设计已被业界主流验证，保持即可，无需改。

2. **把「LLM 重写/合并」尽可能换成「在原条目上加引用、加版本、做 supersede/archive」；真正的内容改写要显式 gate 且仅允许对「有来源引用支撑的条目」进行。**
   证据：Manufactured Confidence（怕 de-hedge 升级为确凿事实）+ Useful Memories（consolidation 是退化源）+ EDV（无支撑改写=自我确认）。你的「每条动作带依据引用 + 只操作有来源的条目」直接命中这三份证据的共通护栏。

3. **「改 importance」不要用单次 LLM 直接给分，改用「累积投票/多方信号 + 门限」（ExpeL 的 ADD/UPVOTE/DOWNVOTE + 计数归零删除）。**
   证据：Choice-Supportive Bias（LLM 给自己选择打分=最坏情形）+ Memory Reward Inflation + Recalling Too Well。importance 应作为聚合结果，而非一次主观分数。

4. **保留原始 excerpt/episode 为一等公民，consolidation/反思只做批量子集 + 显式门控，绝不每次交互后都自动重写。**
   证据：Useful Memories（utility 先升后降、fall below baseline，54% 失败率）+ Evo-Memory 的 Refine 选择性剪枝（GPQA 36.8% vs AIME 10.8%）。dsh-memory 的「维护周期批量 + ≤200 条子集」正是「显式 gate + 选择性」的正确形态；但「≤200」与「选子集规则」属工程权衡，无受控论文证明其最优，应做成可配置、可测。

5. **为「反思写入」本身建一条可审计、可回滚、可离线评估的闭环：每次 LLM 动作都留 audit=system + 变更前快照 + 依据引用，并预留一个「反思是否真的变好」的度量钩子（如检索命中变化 / 矛盾残留率）。**
   证据：没有一个权威源证明「自动改记忆必然变好」，反而负面证据强（Q5 五条）。既然方向本身在证据上偏险，**衡量「反思是否有益」与衡量「反思是否执行」同等重要** —— 这是 dsh-memory 与同类产品拉开差距、且唯一被权威证据支持该做的地方。

---

### 附：检索过程与来源可信度说明

- 检索工具：本次使用 `web_search`（系统内置）、`mcp__exa__web_fetch_exa`、`mcp__tavily__tavily_search` / `tavily_extract`，并在可用时抓取页面正文核对，而非只凭搜索摘要。
- 直接抓到正文并核对的关键来源：mem0 官方 README、Zep/Graphiti 论文 §2.2.3、ExpeL ar5iv 全文、Evo-Memory ar5iv 全文、Manufactured Confidence ar5iv 全文、EDV GitHub、AAAI Choice-Supportive Bias 页面、Recalling Too Well ar5iv。
- 未验证正文（仅据标题/摘要/搜索命中，已在文中标注）：Memory Reward Inflation（2608.00017）、Even the SOTA Memory System Struggles（2605.18565）、SkillRevise（部分）、agent-evolution-kit（部分）。
- 明确「未找到直接证据」的两处：① Q2「importance/recency 选子集 vs 全量」无受控对比论文；② Q4「LLM 重打分 importance 提升质量」无正面受控实证（反证充分）。
