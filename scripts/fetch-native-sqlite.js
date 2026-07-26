#!/usr/bin/env node
/**
 * 从国内镜像下载 better-sqlite3 预编译原生二进制（postinstall 调用）。
 *
 * 背景：better-sqlite3 是 optionalDependency，其 prebuild-install 从 GitHub
 * Releases 拉取预编译 .node 文件。中国大陆用户常因 GitHub 不可达导致下载失败，
 * 又缺少编译工具链做 fallback 源码编译 → 静默跳过 → 运行时退化为纯内存模式。
 *
 * 本脚本在 postinstall 时运行，三阶兜底：
 *   1. better-sqlite3 已通过 npm 正常编译安装 → 拷贝到 dist/native/（零开销）
 *   2. 下载失败 → 从国内镜像（npmmirror → kkgithub）拉取预编译 .tar.gz
 *   3. 全部失败 → 打印可操作提示，不阻断安装（optional 语义保留）
 *
 * 与 pack-native.js 的分工：
 *   pack-native.js — 桌面 sidecar 打包期，走 prebuild-install 确保 ABI 匹配
 *   fetch-native-sqlite.js — CLI 用户 postinstall，从镜像快速拉取
 */

import { createWriteStream, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { get } from 'node:https'
import { createGunzip } from 'node:zlib'
import { execSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ── 平台/架构/ABI ──────────────────────────────────────────────────
const PLATFORM = process.platform
const ARCH = process.arch
const ABI = process.versions.modules

const PLATFORM_TOKEN = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[PLATFORM]
const ARCH_TOKEN = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[ARCH] ?? ARCH

if (!PLATFORM_TOKEN) {
  console.warn(`[fetch-native-sqlite] unsupported platform: ${PLATFORM}, skipping`)
  process.exit(0)
}

// ── better-sqlite3 版本 ────────────────────────────────────────────
// 兼容 optionalDependencies 与 dependencies 两种声明位置——避免将来挪动
// 依赖段时兜底链静默失效（原本只读 optionalDependencies）。
const req = createRequire(import.meta.url)
let version
try {
  const pkg = req('../package.json')
  const raw = pkg.optionalDependencies?.['better-sqlite3'] ?? pkg.dependencies?.['better-sqlite3']
  if (!raw) {
    console.log('[fetch-native-sqlite] better-sqlite3 not found in dependencies/optionalDependencies, skipping')
    process.exit(0)
  }
  version = raw.replace(/^[\^~]/, '')
} catch {
  console.log('[fetch-native-sqlite] cannot read package.json, skipping')
  process.exit(0)
}

// ── 目标路径 ────────────────────────────────────────────────────────
const TARGET_DIR = join(repoRoot, 'dist', 'native')
const TARGET = join(TARGET_DIR, 'better_sqlite3.node')
const NODE_MODULES_NATIVE = join(
  repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node',
)

const TARBALL = `better-sqlite3-v${version}-node-v${ABI}-${PLATFORM_TOKEN}-${ARCH_TOKEN}.tar.gz`

// ── 镜像源（按优先级）────────────────────────────────────────────────
const MIRRORS = [
  {
    name: 'npmmirror',
    url: `https://registry.npmmirror.com/-/binary/better-sqlite3/v${version}/${TARBALL}`,
  },
  {
    name: 'kkgithub',
    url: `https://kkgithub.com/WiseLibs/better-sqlite3/releases/download/v${version}/${TARBALL}`,
  },
  {
    name: 'github (direct)',
    url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${TARBALL}`,
  },
]

// ── main ────────────────────────────────────────────────────────────

async function main() {
  // 1. 已有 dist/native 产物 → 跳过
  if (existsSync(TARGET)) {
    console.log('[fetch-native-sqlite] native binary already present, skipping')
    process.exit(0)
  }

  // 2. node_modules 中已有编译产物 → 直接复用（npm 正常安装了）
  if (existsSync(NODE_MODULES_NATIVE)) {
    mkdirSync(TARGET_DIR, { recursive: true })
    copyFileSync(NODE_MODULES_NATIVE, TARGET)
    console.log('[fetch-native-sqlite] ✓ native binary found in node_modules, copied to dist/native/')
    process.exit(0)
  }

  // 3. 从镜像下载
  mkdirSync(TARGET_DIR, { recursive: true })

  for (const mirror of MIRRORS) {
    try {
      console.log(`[fetch-native-sqlite] trying ${mirror.name}: ${mirror.url}`)
      await downloadAndExtract(mirror.url, TARGET_DIR, mirror.name)
      console.log(`[fetch-native-sqlite] ✓ downloaded from ${mirror.name}`)
      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[fetch-native-sqlite] ${mirror.name} failed: ${msg}`)
    }
  }

  // 4. 全部失败 → 打印可操作提示
  console.warn('')
  console.warn('⚠ [fetch-native-sqlite] All mirrors failed. better-sqlite3 not available.')
  console.warn('  Session history & cross-session memory will run in memory-only mode.')
  console.warn('')
  if (PLATFORM === 'win32') {
    console.warn('  Fix (Windows):')
    console.warn('    1. Install Visual Studio Build Tools: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022')
    console.warn('    2. npm rebuild better-sqlite3 -g tianshu-tui')
  } else if (PLATFORM === 'darwin') {
    console.warn('  Fix (macOS):')
    console.warn('    xcode-select --install')
    console.warn('    npm rebuild better-sqlite3 -g tianshu-tui')
  } else {
    console.warn('  Fix: npm rebuild better-sqlite3 -g tianshu-tui')
  }
  process.exit(0)
}

// ── downloadAndExtract ──────────────────────────────────────────────

/**
 * 下载 better-sqlite3 .tar.gz 预编译包，解压出 .node 文件到 destDir。
 * 实测镜像 tarball 内部结构（npm 镜像源的 prebuild）：
 *   build/
 *     Release/
 *       better_sqlite3.node   ← 我们需要的（仅 2 层目录，strip-components=2）
 * 注意：原代码假设是 package/build/Release/...（3 层）用了 strip=3，实际镜像
 * tarball 是 2 层，strip 3 会剥光路径报 "Not found in archive"。
 */
async function downloadAndExtract(url, destDir, mirrorName) {
  const tmpTar = join(tmpdir(), `better-sqlite3-${mirrorName}-${Date.now()}.tar.gz`)

  try {
    await downloadFile(url, tmpTar)
    await extractNodeBinary(tmpTar, destDir)
  } finally {
    try { await unlink(tmpTar) } catch { /* ignore */ }
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const timeout = 30_000
    // 延迟创建文件流：只在确认是最终 200 响应时才 open 目标文件。
    // 否则重定向链（npmmirror registry → cdn.npmmirror.com 实测 302）会反复
    // close()/createWriteStream() 同一路径，Windows 文件锁语义下偶发 EBUSY。
    let file = null

    const req = get(url, { timeout }, (res) => {
      // 处理重定向：未写任何字节，直接递归跟新 URL
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 释放本次响应体，避免 socket 泄漏
        res.resume()
        downloadFile(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      // 最终响应——此时才创建目标文件流
      file = createWriteStream(dest)
      pipeline(res, file).then(resolve, reject)
    })

    req.on('error', (err) => {
      if (file) file.close()
      reject(err)
    })
    req.on('timeout', () => {
      req.destroy()
      if (file) file.close()
      reject(new Error('download timeout'))
    })
  })
}

async function extractNodeBinary(tarPath, destDir) {
  // 用系统 tar 命令解压。镜像 tarball 结构为 build/Release/better_sqlite3.node
  // （2 层目录），strip-components=2 剥到文件名本身。Windows 上 bsdtar（Win10+ 自带）
  // 同样支持该标志；旧版不支持时进 catch 走纯 Node 解压 fallback。
  const cmd = process.platform === 'win32'
    ? `tar -xzf "${tarPath}" -C "${destDir}" --strip-components=2 --wildcards "*/better_sqlite3.node"`
    : `tar -xzf "${tarPath}" -C "${destDir}" --strip-components=2 "*/better_sqlite3.node"`

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 30_000 })
  } catch {
    // tar 可能不支持 --strip-components（Windows 旧版），用 Node 手动解压
    await extractWithNode(tarPath, destDir)
  }

  if (!existsSync(join(destDir, 'better_sqlite3.node'))) {
    throw new Error('better_sqlite3.node not found in tarball after extraction')
  }
}

async function extractWithNode(tarPath, destDir) {
  // 纯 Node 解压：读取 .tar.gz，在 tar 流中找 better_sqlite3.node
  const zlib = await import('node:zlib')
  const { createReadStream } = await import('node:fs')
  const { Transform } = await import('node:stream')

  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip()
    let buffer = Buffer.alloc(0)
    let found = false

    const parser = new Transform({
      transform(chunk, _encoding, callback) {
        buffer = Buffer.concat([buffer, chunk])
        // Tar 格式：512 字节 header + 数据块
        while (buffer.length >= 512 && !found) {
          const name = buffer.toString('utf8', 0, 100).replace(/\0/g, '')
          const sizeStr = buffer.toString('utf8', 124, 136).replace(/\0/g, '').trim()
          const size = parseInt(sizeStr, 8) || 0

          if (name.endsWith('better_sqlite3.node')) {
            const dataStart = Math.ceil(512 / 512) * 512 // next 512-aligned
            const dataEnd = dataStart + size
            if (buffer.length >= dataEnd) {
              const fileData = buffer.subarray(dataStart, dataEnd)
              const dest = join(destDir, 'better_sqlite3.node')
              // 原 require('node:fs') 在 ESM 模块下会抛 "require is not defined"
              // ——Windows 上 tar 不支持 --strip-components 进此分支必崩。改用顶部 import。
              writeFileSync(dest, fileData)
              found = true
              resolve()
              return
            }
            // Need more data
            break
          }

          // Skip this entry
          const totalLen = 512 + Math.ceil(size / 512) * 512
          if (buffer.length >= totalLen) {
            buffer = buffer.subarray(totalLen)
          } else {
            break // need more data
          }
        }
        callback()
      },
      flush(callback) {
        if (!found) reject(new Error('better_sqlite3.node not found in tar stream'))
        callback()
      },
    })

    createReadStream(tarPath)
      .pipe(gunzip)
      .pipe(parser)
      .on('error', reject)
  })
}

main()
