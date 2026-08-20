# 400K 双阈值无感压缩（宿主 compaction-basic）

> 本页是宿主压缩策略的**权威 How-to + Explanation**：阈值原理、滞回机制、profile 配置与验证。精简版见 [部署文档 §9](DEPLOYMENT.md#9-400k-无感自动压缩profile-配置非插件)。

## 1. 宿主是谁

压缩由宿主 `compaction-basic` 提供（`ctx.compaction` 抽象的 Service Provider 实现），本插件仅消费其 `compaction/summary` 事件（双通道提取）。阈值不属于本插件 `src/config.ts`，属 profile `cordis.patch.yml` 全局策略。

## 2. 双阈值滞回（400K / 200K / 16K）

单阈值（到线即压、压到线下一点）在长会话会**频繁抖动**：压后几轮又触发，摘要链损失放大且挤占预算（`lost in compaction`：压缩 5% 掉 7pp 召回，未压缩区 68%→39%）。

`compaction-basic` 采用**双阈值滞回（hysteresis）**，三常量（token 计）：

| 常量 | 值 | 语义 |
|------|------|------|
| `COMPACTION_TRIGGER` | **400K** | 触发阈值：`modelContextWindow * thresholdRatio`。实测模型窗口 1M（`deepseek-v4-flash`/`mimo-v2.5`/`muse-spark-1.2-contributor`）× `0.4` → 400K。达到即触发 `compactIfNeeded(pressure)`。 |
| `COMPACTION_TARGET` | **200K** | 目标阈值：压缩后**保留**的 token 量（压缩后状态）。不是"保留 200K 最近上下文"，而是压缩后总 token 回落到 200K 附近，腾出 200K 滞回带。 |
| `COMPACTION_RESERVE` | **16K** | 预留缓冲：触发时**预留**给下一轮 `assistant/message + tool/result` 的安全余量，避免触发瞬间下一条大响应又溢出。 |

**滞回带** = `TRIGGER - TARGET = 200K`。一次压缩后，系统有 200K 缓冲才再次触发；`RESERVE 16K` 保证触发决策时已为下一轮大输出留空。

```
token
 1M ┤
    │  TRIGGER 400K ───────────────── 触发 compaction
    │            ╲
    │             ╲ 压缩（保留尾部 + 摘要替换头部）
    │              ╲
200K ┤               TARGET ────────── 回落点（下次触发前有 200K 带宽）
    │                · 16K RESERVE ── 预留缓冲
  0 ┤────────────────────────────────
         ──时间/轮次──>
```

## 3. profile 引用（cordis.patch.yml）

宿主 `dsh-web-app` 默认禁用 `compaction-basic`（压缩移交各预设 realm），本项目在 profile patch 层**按 id 解禁**并配 `modelPolicies`（精确匹配 provider+model，见包 README 与 DEPLOYMENT）：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: compaction-basic
  disabled: false
  config:
    modelPolicies:
      - provider: opencode-go
        model: deepseek-v4-flash
        thresholdRatio: 0.4   # 1M * 0.4 = 400K TRIGGER
      - provider: commandcode
        model: deepseek/deepseek-v4-flash
        thresholdRatio: 0.4
      - provider: opencode-go
        model: mimo-v2.5
        thresholdRatio: 0.4
      - provider: opencode-new
        model: muse-spark-1.2-contributor
        thresholdRatio: 0.4
      # 200K 窗口模型不配 0.4（会得 80K 过频），按 400000/实际窗口 重算
```

完整生产实例见 `~/.dsh/profiles/web/cordis.patch.yml` § "400K 无感自动压缩" 段（含注释：阈值来源、provider 精确匹配陷阱、换模型重算公式）。

`TARGET`/`RESERVE` 由 `compaction-basic` 内置常量控制（200K/16K），无需 profile 配置；`thresholdRatio` 只决定 `TRIGGER`。

## 4. 验证（宿主是否生效）

```bash
# 1) 配置是否命中（profile patch 是否含 compaction-basic 且 thresholdRatio=0.4）
grep -r compaction ~/.dsh
# 期望：profiles/<name>/cordis.patch.yml 含 id: compaction-basic / thresholdRatio: 0.4
cat ~/.dsh/profiles/web/cordis.patch.yml | grep -A2 compaction-basic

# 2) settings.yaml 无直接阈值（阈值在 patch 层，不在 settings.yaml）
grep -r thresholdRatio ~/.dsh/settings.yaml || echo "settings.yaml 无阈值（正确，阈值在 cordis.patch.yml）"

# 3) 运行时验证：长会话跑满 400K 上下应出现一次 compaction/summary（面板或 DB 观察）
# - 面板：会话摘要记忆（kind=insight, tag=session-summary）新增
# - DB：session 事件含 compaction/summary（shadowedSeqs 非空）
node -e "import('node:sqlite').then(()=>{import('node:fs')})" # 占位，实际看 memory.sqlite

# 4) 阈值重算（换模型时）
# 新 TRIGGER = 窗口 * ratio；保持 TARGET 200K / RESERVE 16K 滞回语义
# 例：窗口 200K 模型若仍需 400K 语义则不配（会压到 80K 过频）；窗口 128K 配 0.4 得 51K 需评估
```

**排障**：若长会话不再自动压缩，优先查 `modelPolicies` 是否精确匹配当前 `provider:model`（2026-08-17 实测：切到 `teamorouter` 后 400K 失效即此根因，未命中回落默认 0.8 → 800K 触发）。

## 5. 与记忆插件的交互

- 压缩触发后，`extractor` 监听 `compaction/summary` 的 `shadowedSeqs` 立即提取被遮蔽跨度（免丢失）；
- `injector` 在压缩后允许重注入曾被遮蔽的记忆（`visible` 过滤）；
- 注入预算 16K 字符 ≈ 4K token，远小于 200K 滞回带，COMPAC  与注入无资源竞争。

## 6. 参考

- 宿主 `dsh-compaction-basic`：`thresholdRatio` 触发、200K TARGET / 16K RESERVE 内置（含 `find(p=>p.provider===target.provider && p.model===target.model)` 精确匹配）。
- 诊断详见 [生产验证报告 2026-08-18](reports/production-validation-report-2026-08-18.md) §三-④。
