# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-22（修复面板"运行反思"恒报无可用模型路由——路由回退改用官方 ctx.agentDefaultModel 服务；待宿主重启生效）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板 + docs 三页；无新增代码模块
- 依赖方向：`index.ts`（组合根）→ 各模块，无环
- 单元测试 **640 全绿 / 10 门控跳过**（DSH_BENCH×2 组）+ typecheck 干净；GitHub CI 随 push 验证
- 生产：新代码链路已验证（vec2 迁移/压缩触发/观测面），本轮修复待重启生效

## 二、本次变更影响范围（"运行反思"无可用路由根因修复）

**根因（双层全错，源码级实证）**：`getDefaultModel` 旧实现两路皆废——① 猜测 `ctx.get('settings').get('agent-default-model')` 契约不存在；② ESM 产物里调 CJS `require('node:fs')` 读 YAML，ReferenceError 被空 `catch {}` 静默吞掉 → 恒返回 undefined → 面板点击"运行反思"恒报"无可用模型路由"。settings.yaml 中数据一直存在（opencode-new/x-preview-f-free）。

**修复（55d222a）**：改用官方契约 `ctx.agentDefaultModel.currentSelection()`——dsh-base 组合包注册的共享 Cordis 服务（apiproxy/headless 同款消费），返回叠加 settings.yaml 用户层后的选择。删除猜测性 YAML 手写解析兜底（ESM 下必死）；服务未挂载诚实返回 undefined；服务抛错向 RPC 边界传播（禁静默兜底）。新增 test/default-model.test.ts 四用例含**产物级回归钉住**（构建产物中不得再现 require 兜底字面量）。

**接口契约变更**：rpcContextFrom 导出（供单测）；defaultModel 回退链行为变更（从恒空→正确解析宿主默认模型）。

## 三、已知风险点（诚实自曝）

1. 🔴 **明文密钥落盘（前轮拍板保留）**
2. 🟡 **修复待重启生效（两层根因均已修）**：① getDefaultModel 改用官方服务（55d222a）；② inject 声明补 agentDefaultModel——Cordis 守卫拒绝未声明服务的属性访问（ee4fc22）。重启后点"运行反思"应正常执行
3. 🟢 原子化条目增速观察 / meta 双键残留 / reflectCursor 未初始化（等首个维护周期）/ reject 偶发嵌入浪费

## 四、下次最该做的事

1. **重启 DSH 并复点"运行反思"**：预期正常执行（不再报无可用路由）；水位线首启后 meta 应出现 reflectCursor
2. **数据面调优窗口**：injectStats/recallStats 积累一周后校准三参数
3. **密钥迁移**：随时可做
4. **CI 维护**：actions 升 v5 消 Node20 弃用警告（低优先）
