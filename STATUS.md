# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-22（生产可用性审计：新代码已上线运行、迁移完成；CI 推送启用；压测协议就绪）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板 + docs 三页（CACHE_HIT/COMPACTION_STRESS/COMPACTION）；无新增代码模块
- 依赖方向：`index.ts`（组合根）→ 各模块，无环；**vec2_memory_2560 已在生产运行（旧表已清理，向量 2116 行持续增长）**
- 单元测试 **641 个全绿** + typecheck 干净
- **生产可用性实证（2026-08-22 00:2x）**：部署哈希一致 / 宿主 00:18:58 启动晚于部署 → 新代码运行中；entries 9154 条活性写入；因果边 6 条

## 二、本次变更影响范围（生产审计 + CI 上线）

- **审计结论**：生产环境可用。六项证据链（部署哈希/宿主启动时序/符号链接新 store/vec 迁移完成/数据活性/嵌入链实际工作）
- **Q1=B 密钥延后（拍板）**：settings.yaml 为字面 sk-key（YAML 跨行折叠）——功能正常、明文落盘安全债保留；`env:BAILIAN_API_KEY` 用户级变量未设置，迁移脚本未执行。历史记忆"已迁 env:"与现状不符，以文件为准
- **Q2=A CI 上线（拍板，push 已授权）**：`.github/workflows/ci.yml`（typecheck+test+coverage 门槛 80/75/80/70+docs 断链+markdownlint）随 master 推送 origin 生效
- **Q3=B 压测协议就绪**：`docs/COMPACTION_STRESS.md`——前置核验（modelPolicies 精确匹配陷阱）/触发步骤/六观察点 SQL/通过标准；待用户执行长会话投喂
- 无代码接口契约变更（本轮纯审计+文档+推送）

## 三、已知风险点（诚实自曝）

1. 🔴 **明文密钥落盘（拍板保留）**：settings.yaml 字面 sk-key；泄露面=本机文件读取；迁移三步（设 env 变量→改 env: 引用→重启宿主）随时可做
2. 🟡 **压缩压测未执行**：协议已就绪待跑（见 COMPACTION_STRESS.md）
3. 🟡 **原子化 v1.2 条目增速**：entries 9154 持续增长，粒度效果需 injectStats/recallStats 数据积累复核
4. 🟢 反思水位线首轮全窗成本（一次性）/ reject 步骤偶发嵌入浪费 / 缓存命中率宿主不可观测 / 水位线游标存在性未直读验证

## 四、下次最该做的事

1. **执行压缩压测**：按 COMPACTION_STRESS.md 投喂专用会话至 400K，采集 O1-O4
2. **核对 GitHub CI 首跑结果**（push 后 Actions 页）
3. **数据面调优窗口**：injectStats/recallStats 积累一周后校准 MIN_SCORE/FOLD_JACCARD/原子化强度
4. **密钥迁移**：随时可做（三步，见 R1）
