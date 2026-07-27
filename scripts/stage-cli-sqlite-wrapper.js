#!/usr/bin/env node
/**
 * stage-cli-sqlite-wrapper.js — 为 npm 发布的 CLI 暂存 better-sqlite3 纯 JS 包装器。
 *
 * 背景（2026-07-27 用户事故）：npm 包 files 排除 dist/node_modules 与 dist/native，
 * better-sqlite3 又是 optionalDependency——它的安装在国内网络下常静默失败
 * （GitHub prebuild 不可达），postinstall 的 fetch-native-sqlite.js 只补 .node
 * 二进制到 dist/native/。于是 dist/native/better_sqlite3.node 在场、JS 包装器
 * 却无处可寻，native-resolver 的 Path 1 直接抛 ESQLITE_BUNDLE_BROKEN。
 *
 * 修法：npm 包直接携带包装器（lib/ + package.json，~100KB 纯 JS，与桌面端
 * stage-runtime-deps.js 的 lean staging 同形）。prepack 时运行本脚本，
 * files 用排除后重包含放行 dist/node_modules/better-sqlite3/。
 *
 * .node 二进制仍由 postinstall 下载（保持 npm 包平台中立、体积小）。
 */
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const src = join(repoRoot, 'node_modules', 'better-sqlite3')
const dest = join(repoRoot, 'dist', 'node_modules', 'better-sqlite3')

if (!existsSync(join(src, 'package.json'))) {
  console.error('✗ stage-cli-sqlite-wrapper: node_modules/better-sqlite3 不存在——先 npm install')
  process.exit(1)
}

// 只暂存 better-sqlite3：dist/node_modules 下其余包（esbuild/typescript/…）
// 是桌面 sidecar 的运行时暂存，不属于 npm CLI 的产物面。
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true, dereference: true })
cpSync(join(src, 'package.json'), join(dest, 'package.json'))

// fail-closed：包装器不完整就拒绝出包（空 lib 会让用户端再次撞上 ESQLITE_BUNDLE_BROKEN）。
if (!existsSync(join(dest, 'lib', 'index.js')) || !existsSync(join(dest, 'lib', 'database.js'))) {
  console.error('✗ stage-cli-sqlite-wrapper: 暂存产物不完整（lib/index.js 或 lib/database.js 缺失）')
  process.exit(1)
}

let bytes = 0
for (const f of readdirSync(join(dest, 'lib'), { recursive: true })) {
  const p = join(dest, 'lib', f.toString())
  try { bytes += statSync(p).size } catch { /* dir entry */ }
}
console.log(`✅ stage-cli-sqlite-wrapper: staged lib/ + package.json (${Math.round(bytes / 1024)}KB) → dist/node_modules/better-sqlite3`)
