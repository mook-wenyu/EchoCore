# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15。

## 一、架构健康度

- 模块总数：12（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / host-rpc + client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types 被复用，无环
- 违规跨模块调用：无（工具与注入共用 `formatMemoryLine` 属有意复用）
- 单元测试 87 个全绿；类型检查与构建通过

## 二、本次变更影响范围

- 功能：DSH 会话级记忆插件（双通道提取 / 跨会话检索 / 自动注入 / 溯源审计 / 模型工具 / 会话快照 / 记忆面板）
- 文件：`packages/dsh-memory/`（src 12 文件 + client + scripts + test 8 文件 + README）、`docs/IMPLEMENTATION_PLAN.md`、根 package.json / pnpm-workspace.yaml / .gitignore
- 接口契约：插件 `inject = ['storageDomain', 'llm', 'tools']`；预设组合行 `@echocore/dsh-memory`；RPC 通道 `/memory`（list/search/get/archive/status）；记忆领域 `memory.json`
- 部署改动（用户机器）：`~/.dsh/profiles/web/package.json`（file: 依赖）、`~/.dsh/.agent-presets/echocore-memory/`（预设，含 400K 压缩策略）

## 三、已知风险点（诚实自曝）

1. **两次生产事故**（详见 `~/.dsh/notes/INCIDENT-2026-08-15-tool-prepare-双包.md`）：
   ① hoisted 双包 Symbol 分裂（已修复，环境切 isolated，复发检查已通过）；
   ② 插件未声明 `tools` 注入导致启动致命（已修复，headless 启动 + 进程内探针验证）。
2. **standingKeyFor 校验盲区**：只校验组合激活，不校验 apply 运行期守卫——挂载通过 ≠ 运行无误，后续任何插件改动都必须真机启动验证。
3. 面板真机呈现（settings 页"记忆"、/plugins 客户端 bundle）未经浏览器实测——本会话无法重启用户 web 应用，待用户验证。
4. `file:` 依赖为拷贝语义：源码改动后必须重跑 profile `pnpm install`，否则线上跑的是旧副本。
5. 提取/注入的 LLM 调用成本与注入噪声依赖默认预算（4096 字符）——长会话后需用户观察实际效果再调参。

## 四、下次最该做的事

1. 用户重启 web 应用后：选"EchoCore 记忆"预设开新会话，验证 6 个记忆工具与设置页"记忆"面板。
2. 长会话压测：触发 400K 自动压缩 → 确认记忆被提取（`memory_status` / `memory_search`）、新会话 `memory_recall` 命中历史记忆。
3. 观察 `~/.dsh/storages/memory.json` 物化与条目质量，按需调整 `minExtractChars` / `injectBudgetChars` / `minScore`。
4. 后续演进候选（计划文档 §0.3 范围外）：记忆写入审批闸门、向量检索后端、跨进程一致性。
