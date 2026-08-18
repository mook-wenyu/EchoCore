# EchoCore 文档地图

本页是仓库全部文档的**唯一入口索引**（按 Diátaxis 四分法归类：tutorials / how-to / reference / explanation）。改动代码与改动文档须同一提交（docs-as-code）；对称地，新增文档先在本页登记。

## 1. 入口（landing，第一印象 + 上手）

| 文档 | 类型 | 读者 | 说明 |
|---|---|---|---|
| [根 README（EN）](../README.md) | 入口 | 任何人 | 是什么/为什么有用/怎么开始/去哪找帮助；语言顶栏 |
| [根 README（zh）](../README.zh.md) | 入口 | 中文读者 | 与 EN 单源同步（人类可读句段翻译，命令/URL/表不译） |

## 2. Reference + Explanation（权威/参照）

| 文档 | 位置 | 说明 |
|---|---|---|
| dsh-memory 包 README（权威） | `packages/dsh-memory/README.md` | 能力全表、架构、配置（仅 4 键）、检索/自学习、威胁模型、已知限制 —— 本文档是**行为与接口的单一事实源** |
| 自进化设计与因果链 | `packages/dsh-memory/docs/design-self-evolution-causal.md` | 设计决策记录（Explanation） |
| 反思/自进化研究 | `packages/dsh-memory/docs/research-report-reflection-self-evolution.md` | 查证依据（Explanation） |

## 3. How-to（操作指南，目标导向）

| 文档 | 说明 |
|---|---|
| [部署到 DSH](DEPLOYMENT.md) | 首次部署 / 更新闭环（build→刷新 store→HMR 或重启）/ HMR 机制 / 供应链策略 / 备份 / 迁移 / 密钥 |
| [开发与质量门](DEVELOPMENT.md) | 命令 / 测试 / 覆盖率 / 客户端构建 / 文档约定 |

## 4. 时间点报告（dated snapshots，非活文档）

| 文档 | 位置 | 说明 |
|---|---|---|
| 生产环境可用性验证（2026-08-18） | `docs/reports/production-validation-report-2026-08-18.md` | 生产实况/部署轨迹/覆盖率/供应链注意（附录含热更步骤） |
| 增强候选研究（round2） | `docs/reports/research-report-round2-enhanced-candidates.md` | 自学习/遗忘/索引的候选清单与权威证据 |

## 5. 进程/会话状态

| 文档 | 说明 |
|---|---|
| `STATUS.md`（仓库根） | 会话收尾仪表盘（AGENTS §9 契约）：架构健康度/变更影响/风险/下次最该做什么 |

## 6. 约定

- **docs-as-code**：文档与代码同 PR/同提交；至少保证**断链可检**（CI 链接检查）。
- **语言顶栏**：默认源 `README.md`（EN），中文变体 `README.zh.md` 顶部 `[English](README.md) | 简体中文`。
- **防漂移**：改接口/行为必须同步包 README（单一事实源）；How-to 只讲操作，不复述 Reference。
