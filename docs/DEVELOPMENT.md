# 开发与质量门（How-to）

> 面向"改 dsh-memory 源码"。功能/接口定义见[包 README](../packages/dsh-memory/README.md)。

## 命令

```bash
pnpm install                                            # 根 workspace 安装
pnpm --filter @echocore/dsh-memory typecheck            # tsc --noEmit（0 错误门）
pnpm --filter @echocore/dsh-memory test                 # vitest 全量（当前 26 文件 497 例）
pnpm --filter @echocore/dsh-memory test:coverage        # 覆盖率（阈值见 vitest.config.ts）
pnpm --filter @echocore/dsh-memory build                # tsc + esbuild 客户端打包
```

## 目录结构

- `src/`：宿主侧模块（extractor / injector / store / scoring / reflect / causal / snapshot / embedding / embed-index / host-rpc / tools / config / types / memory-domain / sqlite-kv / stable-snapshot / maintenance 等）
- `src/client.ts` → `scripts/build-client.mjs`：浏览器记忆面板（`__ModuleLoader__` 懒 CJS 打包，产物 `lib/client.js`）
- `test/`：vitest（统一 `FakeTable`/`FakeCtx` 基建；`self-learning-contract.test.ts` 锁自学习红线）
- `scripts/`：`backup-memory.mjs`（SQLite backup API）、`download-embedding-model.mjs`（本地 ONNX 模型）

## 质量门（CI 与本地一致）

- `pnpm test:coverage` 阈值（`vitest.config.ts coverage.thresholds`）：lines 80 / statements 80 / functions 75 / branches 70。
- CI（`.github/workflows/ci.yml`）：typecheck + test + coverage；联调前本地先跑绿。
- 依赖：`@photostructure/sqlite-vec` 锁精确 `1.2.0`；`@vitest/coverage-v8` 必须 `^3.2.x`（与 vitest 3.2.x 匹配，v4 会报 `BaseCoverageProvider` 缺失）。

## 编程约定（源于 AGENTS + 仓库铁律）

- **TDD**：中大型/有风险变更先写失败测试再实现；每逻辑变更独立 git 提交（简体中文 `type(scope): 简述`，禁 `--no-verify`、精确 `git add <路径>`、不 push 前禁 `-A`）。
- **禁止防御性代码**：容错须是显式降级语义 + 中文注释 + 测试；不得用兜底掩盖 bug。
- **模块化/可测**：高内聚低耦合、SOLID/DRY/KISS/YAGNI；纯函数集中 `scoring.ts`。
- **lossless-JSON 契约**：工具输出可选字段**省略键**、绝不含 `undefined` 属性值（宿主校验）。
- **提交前**：`pnpm typecheck` + `pnpm --filter @echocore/dsh-memory test` 全绿；收尾更新 `STATUS.md`（AGENTS §9）。

## 文档约定（docs-as-code）

- 改行为/接口必同步[包 README](../packages/dsh-memory/README.md)（单一事实源）；How-to 只写操作不复述 Reference。
- 新增文档先在[文档地图](README.md)登记；多语言：默认源 `README.md`（EN）、变体 `README.zh.md`。
