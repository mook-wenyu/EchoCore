import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 覆盖率（Q6，2026-08-17 拍板）：装 @vitest/coverage-v8 后首次落地度量基线。
    // thresholds 值按实测基线留 ~10pt 余量（防 CI 红）——提升覆盖率纪律用，不是天花板；
    // 分支是四项中最低项（大量短路路径），分支阈值放最低。
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/client.ts'], // 组合根/面板免测文件（索引与渲染壳）
      thresholds: {
        lines: 80,
        functions: 75,
        statements: 80,
        branches: 70,
      },
    },
  },
})
