# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-20（反思卡死修复 + 水位线/LRU/多批流水线，629 全绿）。

## 一、架构健康度

- 模块总数：28 源模块 + client 面板；本轮无新增模块（`reflect.ts` 内聚增强，`store/search` 缓存策略原地演进）
- 依赖方向：`index.ts`（组合根）→ 各模块，无环；新增 `metaTable` 注入面（maintenance/reflector 共用 `meta` 表不同键）
- 单元测试 **629 个全绿**（33 文件，typecheck 干净；上轮 610，本轮 +19：卡死预算回归 3 + 基准 5(env 门控) + 水位线 5 + 多批流水线等）
- 实现均 TDD（先红后绿），每逻辑变更独立提交（9830920 卡死修复 → 3e21b38 LRU → a7efb5a 水位线+补线 → b01c368 多批）

## 二、本次变更影响范围（反思卡死根因修复 + P1/P2 三件）

**根因实证（新基准基建 `test/reflect-bench.test.ts`，DSH_BENCH=1 门控）**：手动"运行反思"卡死 DSH 的根因是 `selectReflectionPairs` O(n²) 内联逐对 `getVector`（SQLite vec0 虚拟表查询 ~260µs/次）与 jieba 分词——n=400/dim=2560 真实路径实测主线程冻结 **45,782ms**。

- **P0 卡死修复（9830920）**：预取层（向量/token 每条目至多取一次）+ 范数预计算（余弦 3 遍降单遍点积，累加顺序一致保证 sim 位级不变）+ 协作式分片让出（行扫描/焦点复核/向量预取三段按粒度 `await setImmediate`）。效果：D 场景墙钟 45782→284ms，**事件循环最大停顿 45778→38ms**。`selectReflectionPairs` 改 async，全部调用点迁移。
- **P1b 缓存命中（3e21b38）**：TOKEN_CACHE 超限从整体清空改为淘汰最旧 ⌈MAX/4⌉（8882 条库下命中率不再归零）
- **P1a 反思水位线（a7efb5a）**：自动路径只审严格新于 `meta:reflectCursor` 游标的焦点（peer 全窗不变；Mem0 arXiv:2504.19413 增量范式同构）；无新增零 LLM 快路径；force 全窗复审；失败不推进；跨重启持久。**同时修复装配缺陷**：maintenance 的 metaTable 此前未接线，生产维护游标静默退化为进程内态
- **P2 多批流水线（b01c368）**：焦点预算 20→60，按 REFLECT_BATCH_SIZE=10 切批串行独立 LLM 调用；批次直方图日志支持零产出归因

**接口契约变更**：`selectReflectionPairs` 签名 sync→async（含第三参 `{yieldEveryRows?, focusEligible?}`）；`ReflectionDeps` 新增可选 `metaTable`；`MemoryReflector` 新增 `reflectCursor` getter 与导出常量 `REFLECT_CURSOR_KEY/REFLECT_BATCH_SIZE/REFLECT_YIELD_ROWS`。生产 profile 已部署（写盘，下次重启生效）。

## 三、已知风险点（诚实自曝）

1. **生产待重启验证**：修复已写盘但运行中的 DSH 仍是旧代码；重启后需面板点击"运行反思"复验（预期秒级返回不冻结）
2. **水位线首启游标为空**：存量库首轮自动反思仍全窗（60 焦点×6 批 LLM 调用），此后增量；手动 force 恒全窗（成本可控但非零）
3. **多批成本**：60 焦点满载 = 6 次 LLM 调用/轮（旧 1 次）；空轮快路径与水位线缓解实际频次
4. **关键词噪声下限 / Q5 undefined 纪律 / 2b 进程内态累计 / 换维 DROP 竞态**：延续上轮，未变化
5. **CI 未实际触发**：仓库未上线 GitHub
6. **压缩双阈值待压测**：400K/200K/16K 已文档化未实测
7. **明文密钥残留**：settings.yaml 仍为字面 key（迁移脚本未执行）
8. **基准停顿采样精度**：LagSampler 以 5ms 节拍近似上界，非精确分布

## 四、下次最该做的事

1. **重启 DSH 并复验**：点击"运行反思"确认不再卡死；观察日志中 `反思候选直方图/反思批次 x/y/水位线` 三类输出
2. **观测水位线收益**：连续两轮 memory_reflect 后对比第二轮耗时与 LLM token（应显著下降）
3. **密钥一键迁移**：执行 `node scripts/migrate-apikey-to-env.mjs`
4. **压缩压测**：8705 注入下 400K 双阈值滞回验证
5. **CI 上线**：覆盖率阈值收紧 80→88
