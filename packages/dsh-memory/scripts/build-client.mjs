/**
 * 客户端半区构建脚本：把 src/client.ts 打包为 __ModuleLoader__ 懒 CJS 格式。
 *
 * 产物格式与 DSH 静态客户端包一致（如 dsh-client-ui-settings/lib/client.js）：
 *   window.__ModuleLoader__.load({
 *     id: "@echocore/dsh-memory",
 *     factory: (require) => { ... return module.exports; }
 *   })
 *
 * external：react / react/jsx-runtime / @deepseek-ai/* —— 这些名字由
 * 浏览器端的 loader 模块表提供，不得内联（会生成第二个模块实例）。
 */

import { build } from 'esbuild'

const PACKAGE_ID = '@echocore/dsh-memory'

await build({
  entryPoints: ['src/client.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  // 模块表外部依赖：react 与 @deepseek-ai/* 由 web 前端 bundle 提供（JS API 仅支持字符串列表）
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-host-apiproxy/api'],
  outfile: 'lib/client.js',
  banner: {
    js: [
      `window.__ModuleLoader__.load({`,
      `  id: "${PACKAGE_ID}",`,
      `  factory: (require) => {`,
      `    var module = { exports: {} };`,
      `    var exports = module.exports;`,
      `    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    ].join('\n'),
  },
  footer: {
    js: `    return module.exports;\n  }\n});`,
  },
  sourcemap: false,
  logLevel: 'info',
})

console.log('[build-client] lib/client.js 已生成（__ModuleLoader__ 懒 CJS 格式）')
