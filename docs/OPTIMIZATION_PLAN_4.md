# OPTIMIZATION_PLAN_4：缺陷修复 + 2026 记忆最佳实践（RRF/频率调制/评测基线）

> 计划依据：2026-08-15 聚焦缺陷审计（子代理，19 文件全读 + 229 测试验证）+
> 网络三路调研（记忆投毒 MemPoison/SMSR、2026 agent 记忆综述、缓存可观测性）。
> 用户拍板（提问工具确认）：①缺陷 = 全部修复；②投毒防护 = 暂不实施（记录威胁模型）；
> ③2026 最佳实践 = 采纳 RRF + 访问频率调制 + contradiction 评测基线；④验证类 = 全部执行。

## 背景与决策记录

### 缺陷审计结论（子代理，文件:行号证据）
1. **P0-1 embed-index 持久化竞态 + 损坏即插件失败**：
   `embed-index.ts:120-125` persist() 无并发互斥；`index.ts:98-110` 只 catch
   `EmbeddingUnavailableError`，`JSON.parse`（embed-index.ts:57，在 try 外）抛
   SyntaxError 上抛 → apply reject → 插件整体加载失败（与"可选降级"语义不自洽）。
2. **P1-1 config 数字边界缺失**：`config.ts:109` minScore 无 0..1；topK/injectBudgetChars/
   minExtractChars/maxExtractChars/extractMaxTokens 无 `.min()`；无
   `minExtractChars ≤ maxExtractChars` 跨字段约束——后者可致 extractor 截尾保最新
   丢头部 + lastSeq 已推进 → 早期消息永久丢失。
3. **P2-1 superseded 条目向量永不清理**：`embed-index.ts:97` 仅 archive 时 remove；
   superseded 条目检索隐藏但向量残留 → 索引文件随 supersede 链增长。
4. **P1-2 测试盲区**：并发 persist、maintenance×extractor 交叠、RPC 存储错误传播、
   预算边界（预算=header/单条超预算/超大库）、extractor dispose+compaction 交错。

### 2026 最佳实践结论（子代理三路综述）
1. **混合检索 RRF 是 2026 默认栈**（supermemory/stackai/Elastic agent memory）：
   BM25+dense 用 RRF 融合仅 +6ms，recall@10 78%→91%；BM25 锚定实体、dense 抓语义。
   本项目当前是手写权重 `w×relevance + (1-w)×cosine`（store.ts:368-376）——
   **改为显式 RRF（排名融合，k=60），退役 embeddingFusionWeight 配置**（无存量用户）。
2. **访问频率调制衰减**（Elastic agent memory 落地 / FadeMem arXiv:2601.18642）：
   访问频率调制半衰期——访问越多衰减越慢，召回本身抬回记忆分。`accessCount` 字段
   已存在（types.ts:81），零 schema 变更。
3. **contradiction 评测显性化**（PersonaMem 已列为标准维度）：supersede 链已具备
   矛盾消解能力，补显式评测基线测试（偏好变化/事实被推翻场景）。

### 投毒威胁模型（Q2 拍板：暂不实施，记录）
- MemPoison（arXiv:2607.14651，已核验）：L1 直接注入（写时过滤可拦 ~40%）/
  L2 组合式多记录腐化 / L3 上下文触发潜伏；**tool_return/cross_agent 通道比
  user_input 危险**（agent 更信任系统中介输入）；事实原子化存储最抗投毒
  （flat_chunk 腐败率 67.91%）。
- SMSR（arXiv:2606.12703，已核验）：定理 1——无来源溯源的纯内容过滤无法对自适应
  投毒给出非平凡安全界；HMAC 签名 + 随机消融裁决可证（个人场景成本不可接受）。
- **现有防线**：注入声明块（挡 L1 主力）+ source 完整性校验（R4）。
- **未来升级条件**：出现多来源写入（第三方工具/子代理写入记忆）时，实施来源信任
  分桶（user_input/tool/cross_agent + 授权门）。

## 阶段划分与验收标准

### A1：P0-1 embed-index 并发互斥 + load 降级
- `persist()`：promise 队列串行化（`persistChain`），防并发 rename 半截文件
- `load()`：`JSON.parse` 失败 → logWarn + 空索引（显式降级，非致命；嵌入层本为可选）
- 测试：并发 indexEntry/remove 后文件完整可 parse；损坏文件 load 不抛 + 告警
- 验收：全量测试绿；git 提交

### A2：P1-1 config 数字边界与跨字段校验
- `minScore` `.min(0).max(1)`；`topK/injectBudgetChars/minExtractChars/maxExtractChars/extractMaxTokens` `.min(1)`
- 跨字段：`z.object().transform()` 校验 `minExtractChars ≤ maxExtractChars`，违例抛 `z.ValidationError`
- 测试：各边界拒绝用例 + 跨字段违例拒绝 + 合法组合通过
- 验收：全量绿；git 提交

### A3：P2-1 supersede 向量联动清理
- store.create 的 supersede 回写路径（store.ts:211-268）经 hooks.onCreate 通知
  装配层 → `embedIndex.remove(supersededId)`（与 archive 同路径）
- 测试：supersede 后索引无残留向量
- 验收：全量绿；git 提交

### A4：P1-2 测试补盲
- embed-index 并发 persist（A1 含）
- maintenance×extractor 同进程交叠写
- RPC 存储错误传播（wrapper internal 语义）
- render 预算边界（预算=header / 单条超预算跳过 / 超大库）
- extractor dispose 时 compaction 批次在链
- 验收：全量绿；git 提交

### B1：RRF 显式融合（替换手写权重）
- `scoring.ts` 新增纯函数 `rrfScore(kwRank, semRank, k=60)`（归一化 0..1：双榜第一=1）
- `store.ts` search 语义分支：对 matches 建关键词 rel 榜 + 语义 cos 榜 → RRF × timeImportanceFactor
- 移除 `embeddingFusionWeight`（config/schema/SearchOptions/SemanticSearchExtra/README）
- 测试：双榜第一=1、单榜=半权重、零重合语义召回（P4 用例保持）、minScore 阈值语义
- 验收：全量绿；git 提交

### B2：访问频率调制衰减
- `scoring.ts`：`modulatedHalfLifeDays(importance, accessCount)` = 自适应半衰期 × (1 + log2(1+accessCount))
- `timeImportanceFactor` 使用调制半衰期（accessCount 注入）
- 测试：访问 0/1/3/7 次的半衰期倍数；高频记忆衰减显著更慢
- 验收：全量绿；git 提交

### B3：contradiction 评测基线
- store.test 补 PersonaMem 风格用例：偏好变化（supersede 后新偏好召回/旧偏好排除）、
  事实被推翻后检索正确、审计链完整
- 验收：全量绿；git 提交

### C1：文档与威胁模型记录
- README：移除 embeddingFusionWeight 说明、RRF 语义、频率调制、投毒威胁模型段落
- STATUS.md 更新；git 提交

### C2：部署与验证
- `pnpm install` 刷新 profile 副本（当前滞后 ~1.5h）
- 缓存命中率基线实测：3 轮会话读 UI"缓存命中 %"（零代码，观测通道现成）
- maintenance 首周期观察记录
- 验收：真机无错；记录实测数据

## 风险与未决
1. RRF 的 minScore 语义变化：归一化后分数分布与权重融合不同，阈值可能需要实测调整
   （当前默认 0.15；测试先固定归一化语义）
2. 频率调制对现有记忆（accessCount 大者）的评分影响：真机观察，纯函数可单测回滚
3. `z.ValidationError` 经 transform 抛出的路径：schemastery ~standard.validate 的
   错误传播已查证（ValidationError 静态属性 + transform callback），如装配层报错
   形态不符则回退为装配层显式校验（不静默）
4. 缓存实测依赖 DeepSeek 当前缓存实现（版本敏感，openclaw #94518 前科），数据
   仅代表实测时点

## 参考来源
- MemPoison：https://arxiv.org/abs/2607.14651 ；SMSR：https://arxiv.org/abs/2606.12703
- RRF：https://supermemory.ai/blog/hybrid-search-guide ；Elastic agent memory：
  https://www.elastic.co/search-labs/blog/agent-memory-elasticsearch
- FadeMem：https://arxiv.org/html/2601.18642v1 ；PersonaMem（Mem0 综述）：
  https://mem0.ai/blog/state-of-ai-agent-memory-2026
- DeepSeek KV 缓存：https://api-docs.deepseek.com/zh-cn/guides/kv_cache/
