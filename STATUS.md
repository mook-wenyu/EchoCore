# STATUS · EchoCore

> 会话收尾仪表盘（AGENTS.md §9）。最后更新：2026-08-15（P1-P4 + 缺陷修复 A1-A4 + 2026 最佳实践 B1-B3）。

## 一、架构健康度

- 模块总数：19（types / constants / config / memory-domain / scoring / store / extract / extractor / injector / tools / snapshot / stable-snapshot / embedding / embed-index / host-rpc / maintenance / render / client.ts 浏览器半 + scripts/build-client.mjs）
- 依赖方向：`index.ts`（组合根）→ 各模块；模块间仅 store/scoring/types/constants/render/embedding 被复用，无环
- 单元测试 **258 个全绿**（19 文件，三次连跑稳定）；类型检查与构建通过
- 测试基建统一：FakeCtx 五合一（helpers.ts）、FakeTable 失败注入 + 快照迭代、可控 id 序列（vi.mock newMemoryId）、index.test 嵌入 mock（不真实加载 22MB 模型，533ms→15ms）

## 二、本次变更影响范围（P1-P4 + OPTIMIZATION_PLAN_4）

- **P1-P4**（此前提交）：稳定快照（3af3cea）/ 注入排除（e78ff09）/ 自适应衰减（db77788）/ 语义嵌入（1f2d1d0）
- **A1 P0-1**（d5a9eda）：embed-index persist 串行互斥（promise 队列）+ 损坏 JSON 降级为空索引+告警（原会让插件整体加载失败）
- **A2 P1-1**（16a6677）：config 数字边界（minScore 0..1、各字段 ≥1）+ 跨字段互斥（minExtractChars ≤ maxExtractChars，transform + ValidationError；防早期消息永久丢失）
- **A3 P2-1**（2e20f1f）：supersede 联动移除嵌入向量（onSupersede 钩子）
- **A4 P1-2**（35911f6）：测试补盲发现并修复**两处真实缺陷**——①维护合并同刻 createdAt 方向 tie-breaker（`>=` 恒选先扫描者，曾归档"新者"）；②create supersede 优先于维护合并（supersededBy 条目不参与配对，防现行表述被误归档双不可见）；补 RPC 错误传播/render 预算边界/dispose 交错/交叠测试
- **B1 RRF**（8d4a36f）：语义融合改 RRF 排名融合（k=60 归一化），退役 `embeddingFusionWeight` 配置（无存量用户不向后兼容）
- **B2 频率调制**（cca7d8d）：半衰期 ×(1+log2(1+accessCount))，高频访问召回抬回（Elastic/FadeMem 模式）
- **B3 评测基线**（2bcd2a5）：contradiction 显式测试（PersonaMem 风格：偏好变化/事实推翻/无关性）
- **E1 嵌入默认启用**（24543bf）：删除 `embeddingEnabled` 开关——**远程优先 → 自动回退本地 → 都无则关闭**；新增远程 4 项配置（embeddingApiBaseUrl/ApiKey/Model/Dimension，OpenAI 兼容 /embeddings）；EmbeddingService 多后端（远程验证失败回退本地、运行期故障切本地重试）；EmbeddingIndex 动态维度 + 索引文件按维度隔离（memory-embeddings-<dim>.json，本地 384/远程配置值）；远程返回维度 ≠ 配置 → 显式报错防混维；index.test 嵌入 mock 化（533ms→15ms 确定性）
- **接口契约变更**（累计）：`embeddingEnabled` 移除；`embeddingApiBaseUrl/ApiKey/Model/Dimension` 新增；EmbeddingIndexDeps.service 加 `dimension`；EmbeddingServiceDeps 改 `{modelDir, remote?, hasLocalModel?, loadLocalBackend?, fetchRemoteEmbeddings?}`
- **提交**：92a2725（PLAN4）→ d5a9eda（A1）→ 16a6677（A2）→ 2e20f1f（A3）→ 35911f6（A4）→ 8d4a36f（B1）→ cca7d8d（B2）→ 2bcd2a5（B3）→ 本轮文档

## 三、已知风险点（诚实自曝）

1. **缓存命中率未实测**：P1 的 cacheReadTokens 收益无基线；观测通道现成（UI"缓存命中 %"行），3 轮 on/off 对照即可量化；业界基线提示工具稳定会话自然 ~90%（permafrost）。
2. **维护合并与 create supersede 的微竞态**（A4 已加固 supersededBy 检查，但同刻并发窗口仍理论上存在——真实场景提取串行 + 维护 6h 后跑不触发；测试以顺序场景钉住）。
3. **MemoryPanel 组件渲染测试缺失**：组件层依赖浏览器 DOM，测试环境未引入 jsdom/testing-library；createMemoryApi 全方法已覆盖，组件层靠真机验证。
4. **记忆投毒 L2/L3 未防护**（评估记录于 README）：当前防线挡 L1；升级条件 = 出现多来源写入（第三方工具/子代理写库）。
5. extractor 失败重试的重复 LLM 调用（已知成本）；opencode-acp 版本轨脱节（外部）；嵌入启用后 supersede/归档向量联动已就绪但未真机验证。

## 四、下次最该做的事

1. **部署同步 + 重启验证**：build + 手动拷贝 profile 副本（pnpm install 判定无变化跳过），重启实例验证嵌入自动启用（有本地模型 → ready(local) 384 索引；无模型 → disabled 正常态）。
2. **远程嵌入真机验证**（若配置）：硅基流动 key 配置后验证远程优先、维度校验、远程失败回退本地。
3. **缓存命中率基线实测**（零代码）：3 轮同任务会话读 UI"缓存命中 %" + cacheReadTokens，on/off 对照判定 P1 收益；若 <40% 回落查字节级前缀抖动。
4. 观察 memory.json：maintenance 首周期（6h 后）执行效果（重复合并/标签归一化）；A4 修复（同刻 tie-breaker + supersede 优先）真机表现。
5. MemoryPanel 组件测试：若引入 jsdom/testing-library 则补组件渲染测试。
