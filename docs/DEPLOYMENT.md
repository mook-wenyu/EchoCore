# 部署到 DSH（How-to）

> 面向"把 dsh-memory 装进 DSH profile 并保持到最新"。行为/接口细节见[包 README](../packages/dsh-memory/README.md)（本页只讲操作与机制）。

## 1. 装载机制（先读懂，免得"装了没生效"）

- dsh-memory **不是 bundle 层**（package.json 无 `dsh.bundle`），而是经 **patch 层** `cordis.patch.yml` 加载（`insert: [{ id: memory, name: "@echocore/dsh-memory" }]`）。
- **patch 层由宿主 `cordis-plugin-hmr` 热重载（HMR）**：改配置/补丁 → 免重启生效；bundle 层（`dsh.profile.bundles`）仅 boot 装载 → 需重启。
- `dsh plugin --profile <name> add <pkg>` 是 pnpm 转发 + **bundles 对账**；无 `dsh.bundle` 的包只重装不进层栈（对本插件 = file: 重装的规范化）。

## 2. 首次部署

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- insert:
    - id: memory
      name: "@echocore/dsh-memory"
```

profile 的 `package.json` 依赖为本地包：

```json
"@echocore/dsh-memory": "file:D:/TSProjects/EchoCore/packages/dsh-memory"
```

## 3. 更新部署闭环（改源码 → 生效）

1. **重建**：`pnpm --filter @echocore/dsh-memory build`（把最新 `src/` 编译进 `lib/`）。
2. **让加载路径拿到新 lib**（二选一）：
   - 官方：`dsh plugin --profile <name> add @echocore/dsh-memory`（触发 pnpm 重装 file: 依赖）。
   - 直拷（add 受阻时）：把 `packages/dsh-memory/lib/*` 覆盖到
     `~/.dsh/profiles/<name>/node_modules/.pnpm/@echocore+dsh-memory@file+D_*/node_modules/@echocore/dsh-memory/lib`。
3. **激活**（二选一）：
   - 免重启：对 `cordis.patch.yml` 的 memory 条目做一次**零语义触碰**（加注释），触发 HMR 重载；
   - 兜底：重启 `dsh web`（重启 shell 须带 `BAILIAN_API_KEY` export——密钥仅宿主继承环境提供，无 `.env/.credentials` 兜底）。

> 触发 HMR 后校验：宿主进程存活、无 fatal、patch 仍可解析（`python -c "import yaml;…"`）。

## 4. 供应链 minimumReleaseAge 注意

profile 若启用 pnpm `minimumReleaseAge`，**新近发布**的依赖会触发：

```
ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
dshmarket@1.12.2 was published at …, within the minimumReleaseAge cutoff …
```

修复（择时、且属安全面决策）：等截止时间过，或放宽该策略，然后
`pnpm clean --lockfile && pnpm install`。

## 5. 备份（记忆库 SQLite WAL）

记忆库在 `$DSH_HOME/storages/memory.sqlite`（未设 DSH_HOME 时 `~/.dsh/storages/memory.sqlite`，WAL）。
**WAL 活跃期普通文件复制会丢未 checkpoint 数据**——用 SQLite backup API：

```bash
node packages/dsh-memory/scripts/backup-memory.mjs [备份目录] [保留份数]
# 默认备份到 $DSH_HOME/storages/backups/，保留最近 10 份；建议配系统计划任务每日运行
```

## 6. 迁移（旧 memory.json → SQLite）

首启自动从旧 `memory.json` 迁移：逐条校验（`memoryEntrySchema`）、坏记录跳过、
原文件改名 `.bak` 保留、幂等；源文件不可读时**显式区分** ENOENT（无旧文件=首启）与
EACCES 等（真实故障上抛，不静默当无文件）。损坏文件降级空库启动。

## 7. 集成约束（事故教训，务必遵守）

1. profile pnpm `nodeLinker` 必须保持 **`isolated`**（`hoisted` 会造成 `@deepseek-ai/*`
   双实例、`Symbol` 分裂、全工具崩溃）。
2. 插件直接访问的服务必须全部声明在 `inject`（宿主 `['llm','tools','connection','systemPrompt']`、
   客户端 `['slots','connection']`）。
3. `standingKeyFor` 只校验组合激活，不校验运行期服务守卫——挂载后须**真机验证**。
4. 全局启用 ⇒ 所有会话都产生提取/注入 LLM 成本（默认全开，可经组合行 config 调低/关闭）。

## 8. 故障排查

- 生产实机验证轨迹 / 语义向量覆盖审计 / 密钥解析与重启注意：见
  [生产验证报告](reports/production-validation-report-2026-08-18.md)。

## 9. 400K 无感自动压缩（profile 配置，非插件）

由 profile `cordis.patch.yml` 的 `compaction-basic` 行按 id 解禁（web-app 默认禁用）并配置
`modelPolicies.thresholdRatio: 0.4`（实测模型窗口 1M token → 触发点 400K）。
⚠️ **`modelPolicies` 是 provider+model 精确匹配**——默认模型换成其它 provider 后 0.4 不再命中，
回落默认 0.8（触发点 800K）且**无告警**；换默认模型必须同步补对应策略
（2026-08-17 实测："长会话不再自动压缩"即此根因）。
