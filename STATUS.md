# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-22（反思链路端到端打通并首轮产出：审60·裁174·合并2·跳172；质量实证→候选排除模板条目+跳过原因细分）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板 + docs 三页；无新增代码模块
- 依赖方向：`index.ts`（组合根）→ 各模块，无环
- 单元测试 **649 全绿 / 10 门控跳过** + typecheck 干净；CI 随 push 验证
- **反思链路生产实证**：路由解析 ✓ → 批次 LLM 调用 ✓ → 裁决执行 ✓（merged=2 真实归档）；批大小 8 / maxTokens 32768 / reasoningEffort=low

## 二、本次变更影响范围（反思链路六层修复 + 首轮产出与质量实证）

**六层根因修复全记录**：① getDefaultModel 改官方 ctx.agentDefaultModel 服务（55d222a）；② inject 补登 agentDefaultModel——Cordis 守卫（ee4fc22）；③ 失败可观测 lastError 透传面板（6fd0241，用户复测确认生效）；④ max_tokens 截断显式失败+上限 1024→4096（6114e83）；⑤ 推理模型思考链计入输出预算——reasoningEffort='low'+8192（db6e5b0）；⑥ 批大小两轮拍板最终=8 + 上限 32768 + 截断错误附 usage 诊断（a88c033/fe39542/663f035）。配置层：agent-default-model 由未注册的 opencode-new 修正为 opencode-go/mimo-v2.5。

**首轮产出（用户复测）**：审 60 · 裁 174 · 合并 2 · 归档 0 · 跳过 172；跳过率 49.7%；语义命中率 75.5%。

**质量实证与改进（64461be）**：cos≥0.97 的 Top 相似对全是"会话快照"模板条目（结构雷同词面虚高、语义上是独立审计事实不该互合并）——LLM 大量 none 属正确拒绝。两改：① 候选排除 snapshot/session-summary 标签条目（归档已有专属自动链）；② ReflectionSummary 增 skipNone/skipInvalid/skipSuperseded 细分计数。接口契约：ReflectionSummary 新增可选字段。

## 三、已知风险点（诚实自曝）

1. 🔴 明文密钥落盘（前轮拍板保留）
2. 🟡 反思质量待细分数据校准：模板排除后下一轮的 skipNone/skipInvalid 分布才是模型保守度的真实读数；skipInvalid 高 ⇒ id 幻觉需提示词加固
3. 🟢 原子化条目增速观察 / meta 双键残留 / reject 偶发嵌入浪费 / 每轮 8 批 LLM 成本（~8 次调用/force 轮）

## 四、下次最该做的事

1. **重启后跑一轮反思**：读 skipNone/skipInvalid 细分——invalid 高则提示词加固 id 引用规则
2. **数据面调优窗口**：injectStats/recallStats/反思细分积累一周后统一校准
3. **密钥迁移**：随时可做；meta 双键清理可并入下次代码变更
4. **CI 维护**：actions 升 v5 消 Node20 弃用警告（低优先）
