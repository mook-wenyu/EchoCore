/**
 * @node-rs/jieba/dict 子路径类型声明（J1，2026-08-15）。
 * 包 package.json 无 exports/types 字段（main: index.js），NodeNext 下
 * 子路径类型解析失败（TS2307）——本地补齐声明；运行时解析已验证可用
 * （dict.js 存在，Uint8Array 默认词典 ~5MB）。
 */
declare module '@node-rs/jieba/dict' {
  /** 默认词典（Jieba.withDict 用） */
  export const dict: Uint8Array
  /** 默认 IDF 权重（TfIdf 用） */
  export const idf: Uint8Array
}
