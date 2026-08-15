#!/usr/bin/env node
/**
 * 嵌入模型下载脚本（@echocore/dsh-memory P4）。
 *
 * 从 hf-mirror.com（国内可达镜像）下载 Xenova/all-MiniLM-L6-v2 的
 * q8 量化 ONNX 文件与 tokenizer 文件到目标目录（默认
 * ~/.dsh/storages/embedding-model，与插件默认 embeddingModelDir 一致）。
 *
 * 用法：node scripts/download-embedding-model.mjs [目标目录]
 * 运行后重启实例生效——嵌入默认启用：启动时检测模型文件存在性，
 * 有模型即用本地嵌入（无需任何开关配置）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MIRROR = 'https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main'
/** 需要下载的文件（q8 量化模型 + tokenizer 全套） */
const FILES = [
  'onnx/model_quantized.onnx',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
]

const targetDir = process.argv[2] ?? join(homedir(), '.dsh', 'storages', 'embedding-model')
// transformers.js 按模型 id（Xenova/all-MiniLM-L6-v2）在 localModelPath 下
// 拼子目录加载——文件必须落在 <modelDir>/Xenova/all-MiniLM-L6-v2/<file>
const modelRoot = join(targetDir, 'Xenova', 'all-MiniLM-L6-v2')

for (const file of FILES) {
  const url = `${MIRROR}/${file}`
  const dest = join(modelRoot, file)
  await mkdir(dirname(dest), { recursive: true })
  process.stdout.write(`下载 ${file} ... `)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败 ${url}：HTTP ${response.status}`)
  }
  await writeFile(dest, Buffer.from(await response.arrayBuffer()))
  const size = (await import('node:fs/promises')).stat(dest)
  process.stdout.write(`(${(await size).size / 1024 / 1024} MB)\n`)
}

console.log(`模型就绪：${targetDir}`)
console.log('重启实例后生效（嵌入默认启用，无需开关配置；无模型时自动使用远程 API（若配置）或保持关键词检索）。')
