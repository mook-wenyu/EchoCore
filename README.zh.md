[English](README.md) | 简体中文

# EchoCore · @echocore/dsh-memory

DSH（DeepSeek Harness）的**会话级记忆插件**：自动提取、稳定注入、语义检索与后台维护长期记忆，为编码代理提供"海马体"。

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

## 简介

`@echocore/dsh-memory` 是 DSH（DeepSeek Harness，Cordis 生态）的记忆插件——每个会话自动从对话中提取记忆（事实/偏好/决策/待办/洞察），按相关性注入后续上下文，并提供模型工具（`memory_recall` / `memory_search` / `memory_note` / `memory_forget` / `memory_audit` / `memory_status` / `memory_reflect`）与浏览器记忆面板。定位为**轻量 Cordis 插件**：无外部服务、SQLite 持久化（WAL 追加写，`$DSH_HOME/storages/memory.sqlite`）、关键词评分即用、语义嵌入可选。

## 功能特性

- **自动提取**：压缩遮蔽与轮次增量双通道，LLM 提取结构化记忆（事实/偏好/决策/待办/洞察），并随条目标注 self/user 相关性（W2，保留决策因子），带来源溯源（会话 + 事件序号 + 摘录）
- **稳定注入**：system 稳定快照（前缀缓存感知，TTL + revision 双失效）＋ user/message 实时检索注入（预算内、去重、带"仅作背景资料"投毒声明）
- **评分检索**：relevance × 时间重要性调制（importance 自适应半衰期 + 访问频率调制 + salience floor）；关键词路径**双门槛**（raw relevance 噪声下限 `MIN_RELEVANCE_SCORE=0.3` + 融合 `minScore`，语义单榜不受影响）；可选语义融合（RRF 排名融合，本地 ONNX 或远程 OpenAI 兼容 API）
- **自我学习保留**：`有效重要度 = LLM 重要度 + 访问证据（对数封顶）+ self/user 相关性初始因子` 驱动保留/快照排序（不动检索）；**Echo-Gap 红线**——LLM 自评/反思分数绝不写回 stored importance（arXiv:2608.00017），由契约测试锁死
- **矛盾消解**：Jaccard ≥0.7 同 kind 新表述自动 supersede 旧表述（双向指针 + 审计 + 检索排除）；**失效不删**——被覆盖/归档条目保留原文行
- **后台维护**：规则型合并/软降权/标签整理 + 可选 **LLM 反思自进化**（归档/合并语义近似重复与矛盾，可回滚、跨轮累计可观测）与 **因果链**（独立边表、置信 ≥0.6、仅审计展示）
- **完整审计**：每条记忆的创建/合并/覆盖/归档动作全程可追溯
- **浏览器面板**：设置页「记忆」——搜索/过滤/详情/归档 + 配置区块（远程嵌入 4 项，保存即生效且**跨重启保留**——持久化到 `~/.dsh/settings.yaml` 的 `memory` 段，DSH 官方用户设置 seam）

## 快速开始

```bash
# 1. 克隆并安装
git clone <your-fork-url> && cd EchoCore
pnpm install

# 2. 测试
pnpm --filter @echocore/dsh-memory test

# 3. 构建
pnpm --filter @echocore/dsh-memory build
```

**部署到 DSH**（profile patch 层，全局生效）：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
insert:
  - name: '@echocore/dsh-memory'
```

> 部署机制（已实测）：插件经 **patch 层**加载（非 `dsh.bundle`）——**改配置/补丁**由宿主
> `cordis-plugin-hmr` 热重载**免重启**；**改源码**需 `pnpm --filter @echocore/dsh-memory build`
> + 刷新 profile 的 `.pnpm` store 副本（或 `dsh plugin --profile <name> add @echocore/dsh-memory`）
> + 一次 patch 触碰或重启。profile 的 pnpm 供应链 `minimumReleaseAge` 策略会拒绝**新近发布**
> 的包（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）——详见包内 README / 生产验证报告。

本地模型（可选语义检索，hf-mirror 国内可达）：

```bash
node packages/dsh-memory/scripts/download-embedding-model.mjs
```

## 配置

配置面最小化：仅**远程嵌入** 4 项（其余行为参数固化为代码常量——12-Factor 原则）。
面板保存持久化到 `~/.dsh/settings.yaml` 的 `memory` 段（DSH 官方用户设置 seam，
重启不丢；也可直接手工编辑该文件，插件经 settings 服务热生效）。

| 键 | 默认 | 含义 |
|----|------|------|
| `embeddingApiBaseUrl` | `''` | 远程嵌入 API base URL（OpenAI 兼容 `/embeddings`） |
| `embeddingApiKey` | `''` | 字面 key 或 `env:NAME` 环境变量引用（DeepSeek 官方无 embeddings API，需另配供应商） |
| `embeddingModel` | `''` | 远程嵌入模型名（如 `BAAI/bge-m3`） |
| `embeddingDimension` | 1024 | 远程嵌入维度（本地固定 384） |

嵌入后端自动选用：远程优先 → 回退本地 → 都无则关闭（关键词检索）。

## 要求

- Node.js 18+（DSH 0.1.0-rc.x / Cordis 4.x）
- pnpm（workspace）
- 语义嵌入可选：`@huggingface/transformers` + 本地 ONNX 模型（21.9MB q8）

## 文档

- [包内 README（功能/配置/部署/运维，权威）](packages/dsh-memory/README.md)
- [生产验证报告](production-validation-report-2026-08-18.md)（部署状态、W2 热生效、语义覆盖、供应链策略）
- 自我学习红线契约测试：`packages/dsh-memory/test/self-learning-contract.test.ts`
- `docs/`：实现计划与优化计划（中文，含决策记录与查证依据）

## 备份

记忆库存储于 `$DSH_HOME/storages/memory.sqlite`（SQLite WAL；旧 `memory.json` 仅在首启时作为迁移源，迁移完成后保留为 `.bak`）。需用 SQLite backup API 做一致快照备份（WAL 活跃期普通文件复制会丢未 checkpoint 数据；脚本默认保留 10 份）：

```bash
node packages/dsh-memory/scripts/backup-memory.mjs
```

## 许可

[Apache-2.0](LICENSE)

> 注意：DSH 宿主导入路径、模型目录等部署细节见包内 README；本仓库不包含任何密钥或个人路径。
