# 缓存命中：前缀稳定性的实证结论（2026-08-20）

> 本页回答"记忆插件如何影响 DeepSeek 前缀缓存命中"。结论先行：**现有架构已是最优形态，无需新增代码**——本页把散落的机制与本次查证的事实收敛为一处，供后续演进对照。

## 1. 宿主缓存机制（权威来源）

DeepSeek 磁盘 KV 缓存默认开启、免改码；自动检测公共前缀持久化为独立单元，并**按固定 token 间隔切块**——长前缀不再因无边界而整体不可缓存，部分命中有效。来源：[DeepSeek KV Cache 官方指南](https://api-docs.deepseek.com/guides/kv_cache)。

对照业界：OpenAI >1024 token 自动前缀缓存（静态内容前置、变量置尾、工具定义逐字节一致）；Anthropic cache checkpoint=静态前缀、TTL 默认 5 分钟、前缀一变即失效（经 AWS Bedrock 同机制文档交叉核验）。本插件的"稳定快照段置前缀区 + 逐轮记忆包追加消息尾部"与三家最佳实践同构。

## 2. 插件的字节稳定性三重保障

| 保障 | 机制 | 位置 |
|---|---|---|
| 确定性渲染 | 快照取数排序完全确定（effectiveImportance desc → createdAt desc → id asc），同数据必产出同字节 | `store.ts listByImportance` |
| 变更门控 | `store.revision` 只在真实内容变更时递增（create/update/archive/supersede）；**访问追踪回写走裸 `ctx.table.update`，不递增 revision**（2026-08-20 查证 `store/search.ts trackAccess`） | `store.ts` / `search.ts` |
| 抖动限频 | revision 变化后 60s 内不重建（F5）；TTL 300s 到期强制刷新 | `stable-snapshot.ts SNAPSHOT_MIN_REBUILD_INTERVAL_MS / SNAPSHOT_TTL_MS` |

推论：**数据不变 ⇒ 字节不变 ⇒ 前缀命中**；字节漂移只来自真实信息变化（新记忆挤动 Top-N、重要度/覆盖变更）——这是诚实的缓存成本，不应也不需掩盖。

## 3. 查证后否决的方案（防重蹈）

- **"Top-N 集合一致则复用旧文本"**：无操作戏。文本相同本就字节稳定；集合一致但文本不同只可能因数据变化（应如实漂移）。2026-08-20 grilling 回炉否决。
- **入站批次自动裁剪**：`PreStepDecision.enter` 虽可整体替换，但改写用户输入有失真/越权风险；会话历史裁剪属宿主 compaction（400K/200K 双阈值滞回已最优）。拍板不做。
- **LLMLingua 类 token 级剪枝**：定位偏 RAG 长 doc，agent 循环内性价比无受控对比（[LLMLingua](https://github.com/microsoft/LLMLingua)、[LLMLingua-2 ACL 2024](https://aclanthology.org/2024.findings-acl.57/)）——不引入。

## 4. 已知缺口（诚实标注）

- **命中率不可观测**：宿主/上游 API 不暴露缓存命中率，插件侧无法度量实际收益；只能保障"字节稳定的必要条件"，不能报告"命中了没有"。
- **注入包位于尾部**：逐轮变化的内容追加在消息数组尾部（正确位置），其自身永不参与前缀命中——这是结构性的，不是缺陷。
- **TTL 300s 与 Anthropic 默认 5min 对齐**纯属巧合但合理；延长 TTL 只省空闲期 CPU（重建在无写入时本就无字节差异），无缓存收益。

## 5. 相关决策

grilling 两轮拍板（2026-08-20）：Q1=A 不做入站裁剪；Q2=B 快照维持全量渲染；Q5=A 组合卡缓做；Q6'=A 本页文档化。原子化（Q4=A）与扩展观测（Q3=A）见对应实现提交。
