# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-20（注入链路优化束：解耦/下推/并行/折叠/观测，638 全绿）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板；本轮无新增模块（injector/search/embed-index 内聚增强）
- 依赖方向：`index.ts`（组合根）→ 各模块，无环；向量表升级为第二代 `vec2_memory_<dim>`（含 workspace metadata 列，旧表构造时自动二进制复制迁移后清理）
- 单元测试 **638 个全绿**（33 文件，typecheck 干净；上轮 629，本轮 +9：workspace 下推 3、解耦回归、Q2=B 并行/缓存 2、折叠 1、观测计数 1、status 透出 1）
- 实现均 TDD（先红后绿），每逻辑变更独立提交（b56bcd5 下推 → b5615f6 解耦 → 7c3e0ba 并行 → b27d20b 折叠 → 94dfa10 观测 → 0cd87bf 小修）

## 二、本次变更影响范围（自动召回/注入链路专项）

**链路全图实证 + grilling 两轮拍板（8 项决策）**：pre-step 注入器、稳定快照、RRF 融合评分、vec0 KNN、memory_recall 工具。网络佐证：Letta/MemGPT/LangMem/Anthropic 收敛于"常驻核心+agentic 外层"混合形态（与本插件 snapshot+injector+memory_recall 同构）；RRF k=60 与 Elastic/pgvector 默认一致；混合检索失败率 −49%（Anthropic Contextual Retrieval）；噪声伤害定量（COLM'24 arXiv:2404.03302 / ICML'23 arXiv:2302.00093）支撑 minScore 防污染底线。

- **WP-C vec0 表升级（b56bcd5，Q3=B/R2-Q2=A）**：`vec2_memory_<dim>` 增加 workspace metadata 列（实证 @photostructure/sqlite-vec@1.2.0 支持等值过滤下推），knn 跨域条目在 SQLite 层排除；存量旧表自动复制迁移（不重嵌、事务包批、幂等、失败不阻断挂载）
- **WP-A 召回面解耦（b5615f6，Q1=A/R2-Q1=A）**：`ScoredEntry{entry,score,relevance}`——relevance 纯相关性建门槛与三档（双榜印证≥0.7 完整/单榜摘要/<0.4 跳过），TIF 只参与排序。修复 imp<6 完美相关记忆单榜即被丢弃（0.5×0.75=0.375<0.4）
- **WP-B 嵌入并行+缓存（7c3e0ba，Q2=B）**：embed 与 next() 并行发起省一个 RTT；查询向量 LRU（32 条/60s TTL/服务身份失效）；settled 包装防浮动拒绝（failLoud 红线）
- **WP-D 冗余折叠（b27d20b，Q4=A）**：tokenJaccard>0.6 的同主题变体只留最高分（阈值刻意低于写端 supersede 0.7）
- **WP-E 观测计数（94dfa10，Q5=A）**：InjectorStats 八项经 host-rpc status 与 memory_status 双通道透出
- **WP-F 小修（0cd87bf）**：trackAccess 失败上报走 hooks.onAccessWriteError（logger）；lastTrackedAt 分片淘汰

**接口契约变更**：`knn()` 第三参 workspace?；`searchWithSemantic` 第七参 prefetched?；store withScore 行新增 relevance 字段（附加不破坏）；`MemoryStore` hooks 新增 onAccessWriteError；RuntimeHealth/status/memory_status 新增 injectStats。生产 profile 已部署（写盘，下次重启生效）。

## 三、已知风险点（诚实自曝）

1. **生产待重启验证**：全部改动已写盘但运行中 DSH 仍是旧代码；重启后首次启动会触发向量表迁移（~8912 行复制，秒级；日志可见"向量表升级迁移完成"）
2. **迁移失败回退路径**：若迁移中途失败，旧表保留待下轮重试，缺失向量由 backfill 远程补齐收敛（可能产生少量嵌入 API 调用）
3. **IDF 分母策略与解耦的交互**：df=0 查询词不进分母（既有拍板），单条语料场景部分命中即 rel=1.0——解耦放大了该现象的召回面，precision 影响需 injectStats 上线后观测
4. **reject 步骤的嵌入浪费**：Q2=B 并行使 reject 决定前已发起嵌入（偶发浪费；缓存缓解重复）
5. **延续项**：密钥明文未迁移 / 压缩双阈值未压测 / CI 未上线 / 反思水位线首轮全窗

## 四、下次最该做的事

1. **重启 DSH 验证**：日志确认向量表迁移完成；正常对话观察 memory_status 的"注入观测"行
2. **数据面调优**：积累 injectStats 一周后复核 MIN_SCORE=0.4 与 INJECT_FOLD_JACCARD=0.6 是否需要校准
3. **密钥一键迁移**：执行 `node scripts/migrate-apikey-to-env.mjs`
4. **压缩压测 + CI 上线**：延续上轮
