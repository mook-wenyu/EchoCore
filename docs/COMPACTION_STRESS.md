# 压缩双阈值压测协议（400K/200K 滞回）

> 目的：把"压缩已配置"升级为"压缩已实测"。2026-08-20 拍板 Q3=B 立即压测；此前只有配置层验证，无长会话触发实录。

## 0. 前置核验（5 分钟）

```powershell
# ① modelPolicies 精确匹配当前 provider:model（已知陷阱：切路由后失配 → 回落默认 0.8 = 800K 触发）
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern 'compaction-basic' -Context 1,8
# ② 宿主为最新代码（vec2_memory_2560 存在即新代码已在跑）
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.dsh/storages/memory.sqlite',{readOnly:true});console.log(db.prepare(`SELECT name FROM sqlite_master WHERE name='vec2_memory_2560'`).get()?'新代码已运行':'旧代码!')"
```

## 1. 触发步骤

在**专用测试会话**（勿混生产会话）持续投喂直至越过 400K token：

1. 粘贴大块无长期价值文本（如本文件重复拼接、日志样例）——单次 ~50K 字符，间隔发送让每轮正常走完；
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
-- O2/O4 采集（只读）
SELECT id, substr(content,1,40), status, createdAt FROM entries
WHERE content LIKE '会话摘要：%' ORDER BY createdAt DESC LIMIT 10;
```

## 3. 通过标准

- O1-O3 全部发生 = **压缩主链路通过**；
- O4 发生 = **合并链通过**（可选增强项）；
- O5/O6 主观确认 = **无感体验通过**。

任一失败：记录现象 + `cordis.patch.yml` 的 provider:model 快照，回填 [COMPACTION.md](COMPACTION.md) §排障。
