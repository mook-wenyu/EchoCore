# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15。

## 一、架构健康度

- 模块总数：15（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / host-rpc / maintenance / render + client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types/constants/render 被复用，无环
- 单元测试 **188 个全绿**（16 文件）；类型检查与构建通过；部署副本已同步并真机验证
- 测试基建统一：FakeCtx 五合一（helpers.ts，多监听/服务注册/effect/logger/tools 捕获）、FakeTable 失败注入（failNextWrite + 真实 DomainError missing-key）

## 二、本次变更影响范围（第二轮优化）

- **R2 结构性修复**：装配失败上抛（apply 返回 promise，Cordis fiber 拒绝可见）；store 异常语义精确化（仅 missing-key 转业务值，真实异常上抛）；connection 守卫删除（inject 契约保证存在）；配置解析边界（ResolvedConfig 取代逐字段 `??`）；sessionIdOf 缺失即抛（禁止 workspace 键伪造来源）；mergedWithId 语义修正（消除伪造空串）；render.ts 渲染单源（B7）；snapshot 常量复用；config minimum:1；平衡 JSON 扫描；倒序遍历
- **R3 测试基建**：FakeCtx 统一、FakeTable 失败注入、index 装配测试（inject 契约/B1 上抛/卸载）、memory-domain schema 测试（**发现并修复真实缺陷：schema 缺 importance 0..10 边界**）
- **R4 记忆投毒轻量加固**（用户裁决本期实施）：source 完整性防线（畸形条目从检索/浏览过滤 + 告警回调）、注入声明强化（"可能过时或被覆盖"）、注入隔离钉住测试
- **R5 部署同步**：`--dsw-*` 主题修复（518663f）此前从未 build——已重新构建并刷新 profile 副本，**真机验证通过**（3090 实例：console 零错误、记忆面板渲染真实数据）
- **接口契约变更**：`apply` 返回 Promise（失败即加载失败）；`registerMemoryRpc` 去 logger 参数；`memory_note` 输出 `existingId` → `mergedWithId`（可选）；`MemoryStore` 构造新增可选 `onCorruptSource` 回调；`maintenanceIntervalHours` schema 加 min 1
- **提交**：计划文档 → R2（refactor）→ R3（test）→ 1d787e8（R4）→ R5 文档

## 三、已知风险点（诚实自曝）

1. **R3-5 组件渲染测试降级**：MemoryPanel 组件层依赖浏览器 DOM（jsdom/testing-library），测试环境未引入——createMemoryApi 全方法已覆盖，组件层靠真机验证（本轮已做）。
2. **记忆投毒强防线未做**：来源绑定加密签名/运行时校验（MemPoison/SMSR 论文级）列为后续演进；当前轻量加固（声明+隔离+source 完整性）覆盖主向量，本地单用户场景足够。
3. **extractor 失败重试的重复 LLM 调用**：数据完整性优先的已知成本（pending/水位保留 → 重试重复提取 → dedup 兜底），已注释说明，未引入防抖（YAGNI）。
4. M6 字段双源（types.ts 与 zod schema）记录不实施（字段级派生收益低）。
5. 近义去重（语义相同表达不同）仍不支持（第一轮已知限制延续）。

## 四、下次最该做的事

1. **长会话压测**：400K 自动压缩 → 记忆提取 → 新会话召回；构造"新决策覆盖旧决策"验证 supersede 链（第一轮遗留项，未做运行时验证）。
2. 观察 `~/.dsh/storages/memory.json`：supersededBy 字段、maintenance 归档效果、R4 source 校验是否误报（真实数据量下）。
3. 记忆投毒强防线评估：读 MemPoison（arXiv:2607.14651）/SMSR（arXiv:2606.12703）论文后裁决是否实施来源绑定。
4. MemoryPanel 组件测试：若引入 jsdom/testing-library 依赖则补组件渲染测试（R3-5 升级）。
