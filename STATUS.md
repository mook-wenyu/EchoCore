# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15。

## 一、架构健康度

- 模块总数：14（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / host-rpc / maintenance + client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types/constants 被复用，无环
- 违规跨模块调用：无（工具与注入共用 `formatMemoryLine` 属有意复用；`shortSessionId` 三处渲染共用）
- 单元测试 **162 个全绿**；类型检查与构建通过

## 二、本次变更影响范围

- **功能**：优化计划全部阶段落地——腐化防线（O1：prompt 三规则、回述双层过滤、摘录上限、批次 flush）、生命周期（O2：disposed 清理五 Map、装配失败可见）、存储正确性（O3：update 白名单、合并粒度加 kind、归档守卫、排序 tie-breaker）、D-A 后向引用（supersededBy 标记 + 检索排除 + 审计链）、O4 接口收敛（D-D 删除 restore/hardDelete/deleted、RPC status 消费、死代码清理）、O5 客户端（inject 对齐、竞态守卫）、O6 访问追踪节流、O8-M 后台整理（重复合并/过期降级/标签整理）
- **bug 修复**：会话短 id 截断（`session-` 前缀被 slice 吃掉）——injector/tools/client 三处渲染统一走 `shortSessionId`
- **文件**：`packages/dsh-memory/src/`（constants/extract/extractor/injector/index/store/tools/client/maintenance 新）+ `test/`（10 文件，含 types/config/client/maintenance 新）+ README + docs/OPTIMIZATION_PLAN.md
- **接口契约变更**：`store.update` 白名单剔除 content；`SearchOptions.includeSuperseded` 新增；`MemoryStats` 无 deleted；`MemoryEntry` 增 supersededBy/supersedes；`Config` 增 maxExtractChars/enableMaintenance/maintenanceIntervalHours（DEFAULTS 单源）；客户端 `dsh.client.inject: ['slots','connection']`
- **提交**：79564d9（地基）→ 96492bb（O1+O2）→ 15da3b7（O8-M）→ 0b7a94e（O3+D-A+O6）→ 18ab29a（O4+O5）→ d5ac162（O7）

## 三、已知风险点（诚实自曝）

1. **O8-M 范围裁剪**：supersede 复核任务未实现（store.update 白名单不支持 supersededBy 变更，域隔离限制）；LLM 合并裁决未做（纯规则 KISS）——均已写入 maintenance.ts 注释。
2. **部署副本待刷新**：源码变更后 `~/.dsh/profiles/web` 的 file: 拷贝是旧版本——**需重跑 profile `pnpm install`**（集成阶段已做源码侧全部验证，部署侧刷新待执行）。
3. 上下文腐化**残余向量**：近义去重（语义相同表达不同）仍不支持（已知限制）；assistant 回述依赖 prompt 规则 + 段落标记双防线（source 级过滤无法覆盖 assistant 消息）。
4. `client.test.ts` 的 react 解析依赖（vitest 环境需 react 模块）——已通过，但构建产物变化时可能再现。
5. 记忆条目语义合并仍无 LLM 裁决（D-A 是纯规则 Jaccard；STALE 论文显示规则覆盖不全）。

## 四、下次最该做的事

1. 重跑 profile `pnpm install` 刷新部署副本；用户重启 web 后验证：注入记忆显示"来自会话 63bbf845"（短 id 修复）、后台整理任务 6h 后运行（memory_status 可见统计变化）。
2. 长会话压测：400K 自动压缩 → 记忆提取 → 新会话召回；构造"新决策覆盖旧决策"场景验证 supersede 标记与检索排除。
3. 观察 `~/.dsh/storages/memory.json`：supersededBy 字段、maintenance 归档（stale）、重复合并效果。
4. 后续演进候选：supersede 复核的 store 专用方法、LLM 合并裁决、近义去重。
