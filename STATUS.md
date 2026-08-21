# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-20（四域专项：原子化/扩展观测/缓存结论文档化，641 全绿）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板 + 新增 `docs/CACHE_HIT.md` 结论页；无新增代码模块（extract 提示词演进、tools/host-rpc 观测面扩展）
- 依赖方向：`index.ts`（组合根）→ 各模块，无环；向量表第二代 `vec2_memory_<dim>` 运行中（旧表构造时自动迁移）
- 单元测试 **641 个全绿**（33 文件，typecheck 干净；上轮 638，本轮 +3：原子化 2、recall 计数 1；另 host-rpc/tools 断言扩展）
- 实现均 TDD（先红后绿），每逻辑变更独立提交（5f8f26f 原子化 → 62ca814 扩展观测 → 本提交文档化）

## 二、本次变更影响范围（四域专项：裁剪/折叠/拆解组合/缓存）

grilling 两轮拍板（8 决策）：Q1=A 不做入站批次裁剪；Q2=B 快照维持全量渲染（否决折叠）；Q3=A recall 观测计数；Q4=A 提取原子化 v1.2；Q5=A 组合卡缓做；Q6'=A 缓存零代码+文档化（原设想经查证为无操作，回炉否决）；Q7=A 实施推荐项。

- **记忆自动拆解（5f8f26f）**：提取提示词 v1.2 新增规则 10 原子性——一条记忆=一个原子事实，复合陈述必须拆分；与规则 4 去重合并的边界显式化。对齐 Mem0（arXiv:2504.19413）/A-MEM（arXiv:2502.12110）实践
- **扩展观测（62ca814）**：`RecallStats{calls,returnedTotal,dedupedSkipped}` 单一对象双通道（工具累加/runtime 读出）经 status 与 memory_status 透出"扩展观测"行
- **缓存结论（docs/CACHE_HIT.md）**：字节稳定性三重保障实证（确定性排序/revision 仅真实变更递增——trackAccess 裸表写不触发/F5 限频）；DeepSeek KV 分块缓存使长前缀部分命中有效；查证后否决"同集合复用旧文本"（无操作戏）与 LLMLingua 引入
- **组合现状盘点**：merge/supersede/session-summary 合并链已覆盖主场景，跨条语义合成卡缓做（YAGNI）
- **接口契约变更**：RuntimeHealth/MemoryToolsDeps 新增 recallStats；memory_status schema 新增 recallStats 键（json+required 承载 null）；EXTRACTION_PROMPT_VERSION v1.2

生产 profile 已部署本轮与上轮全部产物（写盘，重启生效）。

## 三、已知风险点（诚实自曝）

1. **生产待重启验证**：vec2 表迁移、注入/提取/观测全链路均需重启后实测；迁移日志应出现"向量表升级迁移完成"
2. **原子化的条目数增长**：v1.2 拆分规则会让条目数上升——由写端门/supersede≥0.7/反思水位线协同消化；若 injectStats/recallStats 显示噪声上升需回调提示词强度
3. **命中率不可观测**：宿主不暴露缓存命中 API，插件只能保障必要条件不能报告实际命中（CACHE_HIT.md §4）
4. **延续项**：密钥明文未迁移 / 压缩双阈值未压测 / CI 未上线 / 反思水位线首轮全窗 / reject 步骤偶发嵌入浪费

## 四、下次最该做的事

1. **重启 DSH 全链路验证**：向量迁移日志 → 注入观测/扩展观测行出现 → 长对话观察提取产出粒度（原子化效果）
2. **数据面调优**：积累 injectStats/recallStats 一周复核 MIN_SCORE=0.4、FOLD_JACCARD=0.6、原子化强度三参数
3. **密钥一键迁移**：执行 `node scripts/migrate-apikey-to-env.mjs`
4. **压缩压测 + CI 上线**：延续前两轮
