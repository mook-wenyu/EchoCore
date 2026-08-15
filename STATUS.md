# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15。

## 一、架构健康度

- 模块总数：12（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / host-rpc + client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types 被复用，无环
- 违规跨模块调用：无（工具与注入共用 `formatMemoryLine` 属有意复用）
- 单元测试 87 个全绿；类型检查与构建通过

## 二、本次变更影响范围

- **功能**：记忆插件全局化——从"EchoCore 记忆"自定义预设改为**宿主组合行**（所有 Agent 可用，含子代理）；注入预算默认 4096 → 16384 字符（≈4K token，对齐 magic-context 官方默认）；400K 压缩改由宿主 compaction-basic 承载（patch 解禁 + thresholdRatio 0.4）
- **文件**：`packages/dsh-memory/src/{config,index,client}.ts`、`README.md`、`docs/IMPLEMENTATION_PLAN.md`、`STATUS.md`（仓库）；`~/.dsh/profiles/web/{cordis.patch.yml,package.json}`、预设删除（部署）
- **接口契约变更**：宿主 `inject` 补 `connection`；客户端 `inject = ['slots','connection']`；`config.compactThresholdTokens` 字段删除（阈值归宿主 compaction-basic 配置）；删除 `echocore-memory` 预设
- **实机验证**（headless + playwright）：boot 无致命；客户端 bundle 路由 200；boot 条目图含本插件；设置页"记忆"面板渲染且 RPC 返回真实会话摘要（跨进程持久化实证）；插件列表 `memory 已挂载已启用`、`compaction-basic` 双实例（宿主解禁 + 预设安全网）

## 三、已知风险点（诚实自曝）

1. **三次生产事故**（详见 `~/.dsh/notes/INCIDENT-2026-08-15-tool-prepare-双包.md` 附章）：
   ① hoisted 双包 Symbol 分裂（已修复，环境切 isolated，复发检查通过）；
   ② 宿主插件未声明 `tools` 注入导致启动致命（已修复并 headless 验证）；
   ③ 客户端插件未声明 `slots`/`connection` 注入导致面板静默不出现（已修复并经浏览器实测）。
2. **standingKeyFor 校验盲区**：只校验组合激活，不校验 apply 运行期守卫——挂载通过 ≠ 运行无误，插件改动必须 headless 启动 + 浏览器实测。
3. 宿主 compaction-basic 解禁后**所有会话**的压缩阈值变为 400K（含原本无压缩能力的 minimal 预设会话）——若某预设希望差异化需另行配置。
4. `file:` 依赖为拷贝语义：源码改动后必须重跑 profile `pnpm install`，否则线上跑旧副本。
5. 全局启用 = 所有会话产生提取/注入 LLM 成本；默认 4K token 注入预算的注意力影响待长会话实测调参。

## 四、下次最该做的事

1. 用户重启 web 应用后：新会话确认 6 个 memory_* 工具自动可见；设置页"记忆"面板可用。
2. 长会话压测：400K 自动压缩触发 → 记忆被提取（`memory_status`/`memory_search`）；新会话 `memory_recall` 命中历史。
3. 观察 `~/.dsh/storages/memory.json` 物化与条目质量，按需调整 `minExtractChars` / `injectBudgetChars` / `minScore`。
4. 后续演进候选（计划文档 §0.3 范围外）：记忆写入审批闸门、向量检索后端、跨进程一致性。
