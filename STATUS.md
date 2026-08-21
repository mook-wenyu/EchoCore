# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-22（压缩压测实测通过——生产自然触发，主链路全过；CI 首绿；生产可用性审计完成）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板 + docs 三页（CACHE_HIT/COMPACTION_STRESS/COMPACTION）；无新增代码模块
- 依赖方向：`index.ts`（组合根）→ 各模块，无环；**vec2_memory_2560 已在生产运行（旧表已清理，向量 2116 行持续增长）**
- 单元测试 **641 个全绿** + typecheck 干净；**GitHub CI 首绿（57s success）**
- **生产可用性实证（2026-08-22）**：部署哈希一致 / 宿主 00:18:58 启动晚于部署 → 新代码运行中；entries 9154 条活性写入；因果边 6 条
- **压缩链路实证（2026-08-22）**：生产会话自然触发压缩（352 条/~127K tokens），摘要登记/提取通道/滞回带全部按设计工作

## 二、本次变更影响范围（压测执行 + CI 上线）

- **Q3=B 压缩压测 ✅ 实测通过（免人工投喂）**：生产长会话自然越过 400K 触发压缩——O1 压缩事件/GUI 横幅、O2 摘要登记（session-summary @15:55 与会话 32dc8778 吻合）、O3 通道 A 提取（当日 extractor 新增 50 条）、O5/O6 无感体验（缓存命中 98%、压后占用 25%≈TARGET 同量级）全部通过；O4 归档链未达 Jaccard 阈值属预期语义。详见 COMPACTION_STRESS.md §4 实测记录
- **附带发现（低危观察项）**：① meta 表 `lastCursor`/`meta:lastCursor` 双键并存（维护游标新旧命名残留双写）；② `meta:reflectCursor` 未初始化（水位线特性上线后尚无自动轮）
- **Q2=A CI 上线 ✅ 已生效**：首跑连修两处后 success（57s）——修复① pnpm 双版本声明冲突（action 改读 packageManager 单一事实源）② O3 墙钟基准共享 runner 超时改 DSH_BENCH=1 门控；遗留警告：actions v4 目标 Node20 被强制 Node24（上游弃用通告，暂无碍）
- **Q1=B 密钥延后（拍板保留）**：settings.yaml 字面 sk-key，功能正常、明文落盘安全债保留
- 无代码接口契约变更（本轮纯验证+文档+推送）

## 三、已知风险点（诚实自曝）

1. 🔴 **明文密钥落盘（拍板保留）**：settings.yaml 字面 sk-key；泄露面=本机文件读取；迁移三步随时可做
2. 🟡 **原子化 v1.2 条目增速**：entries 9154 持续增长，粒度效果需 injectStats/recallStats 数据积累复核
3. 🟢 meta 双键残留（低危：值相同无行为差异，可在下轮清理为单键）/ 反思水位线未初始化（等首个维护周期）/ reject 步骤偶发嵌入浪费 / 缓存命中率宿主不可观测

## 四、下次最该做的事

1. **数据面调优窗口**：injectStats/recallStats 积累一周后校准 MIN_SCORE/FOLD_JACCARD/原子化强度三参数
2. **观察反思水位线首轮**：下个维护周期后核对 `meta:reflectCursor` 出现与 LLM 调用收缩
3. **密钥迁移**：随时可做（三步，见 R1）
4. **CI 维护**：actions 升 v5 消 Node20 弃用警告（低优先）；meta 双键清理可并入下次代码变更
