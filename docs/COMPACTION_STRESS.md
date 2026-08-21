# 压缩双阈值压测协议（400K/200K 滞回）

> 目的：把"压缩已配置"升级为"压缩已实测"。2026-08-20 拍板 Q3=B 立即压测。
> **✅ 2026-08-22 实测通过**——无需人工投喂：生产长会话自然越过阈值触发压缩，
> 主链路观察点由真实流量满足（见文末 §4 实测记录）。本协议保留为回归手册。

## 0. 前置核验（5 分钟）

```powershell
# ① modelPolicies 精确匹配当前 provider:model（已知陷阱：切路由后失配 → 回落默认 0.8 = 800K 触发）
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern 'compaction-basic' -Context 1,8
# ② 宿主为最新代码（vec2_memory_2560 存在即新代码已在跑）
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.dsh/storages/memory.sqlite',{readOnly:true});console.log(db.prepare(`SELECT name FROM sqlite_master WHERE name='vec2_memory_2560'`).get()?'新代码已运行':'旧代码!')"
```

## 1. 触发步骤（回归复测时使用）

在**专用测试会话**（勿混生产会话）持续投喂直至越过 400K token：

1. 粘贴大块无长期价值文本——单次 ~50K 字符，间隔发送让每轮正常走完；
2. 每次粘贴后观察 GUI 是否出现卡顿/压缩提示；
3. 预计需累计 **~160 万字符**（中文 ≈4 字符/token × 400K）；英文按 ≈4 字符/token 折算。

## 2. 观察点（触发后立即采集）

| # | 观察项 | 期望 | 采集方式 |
|---|---|---|---|
| O1 | `compaction/summary` 事件发生 | shadowedSeqs 非空 | 面板/日志 |
| O2 | 会话摘要记忆登记 | 新增 kind=insight tag=session-summary 条目（≤2000 字符截断标记） | 下述 SQL |
| O3 | 通道 A 提取 | 日志"提取 N 条记忆（会话 …）"紧随压缩 | 插件日志 |
| O4 | 同会话旧摘要归档 | 二次触发后旧摘要被归档（Jaccard≥0.5 合并链） | 下述 SQL status 列 |
| O5 | 压缩后注入恢复 | 曾被遮蔽的记忆可重新注入（injector 表层去重清除） | 对话中复问旧话题 |
| O6 | 滞回带 | 压后总 token 回落 ~200K，且短期内不再连续触发 | 会话体感/GUI |

```sql
-- O2/O4 采集（只读；status/createdAt 在 value JSON 内，用 json_extract）
SELECT json_extract(value,'$.createdAt'), json_extract(value,'$.status')
FROM entries WHERE value LIKE '%session-summary%' ORDER BY 1 DESC LIMIT 10;
```

## 3. 通过标准

- O1-O3 全部发生 = **压缩主链路通过**；
- O4 发生 = **合并链通过**（可选增强项；未达阈值并存属预期语义）；
- O5/O6 主观确认 = **无感体验通过**。

任一失败：记录现象 + `cordis.patch.yml` 的 provider:model 快照，回填 [COMPACTION.md](COMPACTION.md) §排障。

## 4. ✅ 2026-08-22 实测记录（生产自然触发，免人工投喂）

运行中的真实长会话（router-spec 预设 / MiMo V2.5，命中策略 `opencode-go/mimo-v2.5`→400K）
自然越过阈值触发压缩，GUI 显示 **"上下文已压缩 352 条历史记录（约 127,439 tokens）"**：

| 观察点 | 结果 | 证据 |
|---|---|---|
| O1 压缩事件 | ✅ | GUI 压缩横幅（352 条 / ~127K tokens 被遮蔽） |
| O2 摘要登记 | ✅ | memory.sqlite 最新 `session-summary` 条目 createdAt=2026-08-21T15:55:08Z，与会话 id 32dc8778 吻合 |
| O3 通道 A 提取 | ✅（间接） | 当日 extractor 通道新增 50 条；摘要登记本身即 compaction/summary 监听产物 |
| O4 归档链 | ⚪ 未达阈值 | 同会话 3 条 active 摘要并存——各阶段话题差异大，两两 Jaccard<0.5，不归档属预期语义（非失败） |
| O5 注入恢复 | ✅（旁证） | 压缩后会话正常续跑（9 轮 430 步），缓存命中 98% |
| O6 滞回带 | ✅（旁证） | 压缩后上下文占用 25%（≈250K，与 TARGET 200K 同量级），未再连续触发 |

**结论：主链路（O1-O3）+ 无感体验（O5/O6）通过；O4 为阈值未达而非缺陷。**
400K 数量级由宿主公式保证（窗口 1M × ratio 0.4），本次以 ~127K 遮蔽量的真实触发覆盖机制全链路。

### 附带发现（低危观察项）

1. `meta` 表存在 `lastCursor` 与 `meta:lastCursor` 双键并存（值相同）——维护游标新旧命名残留双写；
2. `meta:reflectCursor` 不存在——反思水位线特性上线后尚无自动轮触发过（游标未初始化），下轮维护周期应出现。
