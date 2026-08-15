# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15（P1-P4 + 第二轮评估决策）。

## 一、架构健康度

- 模块总数：19（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / stable-snapshot / embedding / embed-index / host-rpc / maintenance / render / client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types/constants/render/embedding 被复用，无环
- 单元测试 **229 个全绿**（18 文件）；类型检查与构建通过；部署副本已同步（file: 需 pnpm install 刷新）
- 测试基建统一：FakeCtx 五合一（helpers.ts）、FakeTable 失败注入（failNextWrite + 真实 DomainError missing-key）

## 二、本次变更影响范围（P1-P4 + 第二轮评估）

- **P1 稳定快照**（3af3cea）：`stable-snapshot.ts` 注册 systemPrompt.context 段（order 130），TTL+revision 双失效，窗口内字节稳定 → DeepSeek 前缀缓存命中
- **P2 实时注入排除**（e78ff09）：injector 排除快照已含记忆，避免重复占预算
- **P3 自适应衰减**（db77788）：importance 感知半衰期（7×2^((imp-5)/2)）+ salience floor（imp≥8 保活）
- **P4 语义嵌入**（1f2d1d0）：本地 MiniLM q8（21.9MB）+ 关键词融合检索（默认关，显式启用）
- **第二轮对比报告**（本轮）：magic-context v0.36.1 / opencode-acp master 实况复核，修正第一轮 2 处事实错误（opencode-acp strategies/message 模式/manualMode 未删；stars 1731）
- **D1-D3 决策记录**（本轮，OPTIMIZATION_PLAN_3.md）：模型主动压缩工具**不实施**（结构性 busy：工具执行时 agent 必 running，compactNow 强制 idle）；记忆管理**维持现状**（六件工具已覆盖）；缓存优化**暂不处理**（DSH 已内置"缓存命中 %"观测，随时零成本实测）
- **接口契约变更**（累计）：apply 返回 Promise；memory_note `mergedWithId?`；MemoryStore 可选 `onCorruptSource`；snapshot*/embedding* 配置项
- **提交**：P1 → P2 → P3 → P4 → e1939f8（README 文档收尾）→ 本轮决策文档

## 三、已知风险点（诚实自曝）

1. **缓存命中率未实测（D3 暂缓）**：P1 的 cacheReadTokens 收益无基线数据；观测通道现成（UI 统计行），未来 3 轮 on/off 对照即可量化；业界基线提示工具稳定会话自然 ~90%（permafrost），若 <50% 再评估激进优化。
2. **opencode-acp 版本轨脱节**（外部风险）：GitHub release v1.14.19 / npm latest v1.12.10 / package.json 1.1.0 三轨不一致——未来若引用其代码需核验实际版本。
3. **MemoryPanel 组件渲染测试缺失**：组件层依赖浏览器 DOM，测试环境未引入 jsdom/testing-library；createMemoryApi 全方法已覆盖，组件层靠真机验证。
4. **记忆投毒强防线未做**：来源绑定加密签名（MemPoison/SMSR 论文级）列为后续演进；当前轻量加固（声明+隔离+source 完整性）覆盖主向量。
5. **extractor 失败重试的重复 LLM 调用**：数据完整性优先的已知成本，已注释说明，未引入防抖（YAGNI）。
6. 近义去重（语义相同表达不同）仍不支持；模型误调重要度风险已通过 D2"维持现状"回避。

## 四、下次最该做的事

1. **缓存命中率基线实测**（零代码）：3 轮同任务会话（≥8-10 步）读 UI"缓存命中 %"行 + cacheReadTokens 累计，on/off 对照判定 P1 收益；若 <40% 回落则查字节级前缀抖动（工具顺序/可变 system 块/非语义元数据）。
2. 观察 memory.json：maintenance 首周期（6h 后）执行效果（重复合并/标签归一化）；3080 重启后确认 memory_audit/search 修复生效。
3. 记忆投毒强防线评估：读 MemPoison（arXiv:2607.14651）/SMSR（arXiv:2606.12703）后裁决是否实施来源绑定。
4. MemoryPanel 组件测试：若引入 jsdom/testing-library 依赖则补组件渲染测试。
5. 若引入嵌入启用：profile 配置 embeddingEnabled: true + 模型文件部署（scripts/download-embedding-model.mjs）后真机验证融合检索。
