import { spawn } from 'node:child_process'
import { glob, mkdir } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeTestFlags, resolveTestTimeoutMs } from './test-runner-flags.js'

const args = process.argv.slice(2)
const includeTui = !args.includes('--exclude-tui')
const integrationOnly = args.includes('--integration')
const unitOnly = args.includes('--unit') || args.includes('--fast') || args.includes('--exclude-tui')

// Positional (non-flag) args are substring filters over the file path, e.g.
// `npm test src/tools/web-search` runs only matching test files. Paths are
// normalized to forward slashes so Windows-style `\` filters also match.
const pathFilters = args
  .filter(a => !a.startsWith('--'))
  .map(a => a.replace(/\\/g, '/'))

// Temp dir policy: tests MUST get a temp dir OUTSIDE the repo when possible.
// An in-repo temp dir breaks fixture hermeticity — mkdtemp fixtures inside the
// repo let git discovery, node module resolution, tsc/tsconfig lookup and
// .rivet-config walk-up all "see" the real repo, which flips a dozen tests
// (checkpoint/git/worktree/theta/native-resolver/layered-config...).
// The in-repo .test-tmp fallback exists only for sandboxed runs where the OS
// temp dir is not writable (the original EPERM issue, commit 7cc487b2).
function resolveTestTmp(): string {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'rivet-tmp-probe-'))
    rmSync(probe, { recursive: true, force: true })
    return tmpdir()
  } catch {
    return join(process.cwd(), '.test-tmp')
  }
}

const PROJECT_TMP = resolveTestTmp()
await mkdir(PROJECT_TMP, { recursive: true })

// `scripts/` 也要收：打包裁剪（wasm 白名单 / typescript 瘦身 / 外来平台包过滤）与
// 遥测探针的测试都住在那儿。曾经只 glob `src/`，那 4 个文件写了却从不执行——
// 裁剪逻辑错了会直接毁发布产物，恰恰是最需要门禁的一类。
const TEST_GLOBS = ['src/**/*.test.ts', 'scripts/**/*.test.ts']

const files: string[] = []
for await (const file of glob(TEST_GLOBS)) {
  const normalized = file.replace(/\\/g, '/')
  // scripts/cloudflare-update-worker 等嵌套包一旦 npm install 就会带进 node_modules
  if (normalized.includes('/node_modules/')) continue
  const isIntegration = normalized.includes('/integration/')
  if (integrationOnly && !isIntegration) continue
  if (unitOnly && isIntegration) continue
  if (!includeTui && normalized.includes('/tui/__tests__/')) continue
  if (pathFilters.length > 0 && !pathFilters.some(f => normalized.includes(f))) continue
  files.push(file)
}
files.sort()

if (files.length === 0) {
  console.error(
    pathFilters.length > 0
      ? `No test files matched: ${pathFilters.join(', ')}`
      : 'No test files found',
  )
  process.exit(1)
}

const testEnv = {
  ...process.env,
  TMPDIR: PROJECT_TMP,
  TMP: PROJECT_TMP,
  TEMP: PROJECT_TMP,
  // When the fallback in-repo temp dir is in use, stop git repo discovery
  // from walking up out of it into the real repo (test fixtures created via
  // mkdtemp expect "not a git repo"). Harmless for the OS temp dir case.
  GIT_CEILING_DIRECTORIES: PROJECT_TMP,
}

// 超时上限是防「电脑卡死」的关键：Node 不设 --test-timeout 就是 Infinity，任一测试
// 卡住整个批次进程就永久挂着，被遗弃的整跑会一直占 CPU 直到手动清理。曾攒下 4 个
// 跑满一天多的僵留进程，机器 15 分钟负载均值 76。详见 test-runner-flags.ts。
const NODE_FLAGS = nodeTestFlags(resolveTestTimeoutMs(process.env.RIVET_TEST_TIMEOUT))

// Windows caps a process command line at ~32767 chars; passing all ~900 test
// files at once overflows it (ENAMETOOLONG). Chunk the file list by cumulative
// arg length so each spawn stays well under the limit. node runs each test file
// in its own child regardless, so batching across invocations is equivalent.
const FIXED_LEN = process.execPath.length + NODE_FLAGS.join(' ').length + 8
const MAX_ARGS_LEN = 24_000 - FIXED_LEN

function batchFiles(all: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let len = 0
  for (const file of all) {
    const cost = file.length + 3 // path + quotes/space overhead
    if (current.length > 0 && len + cost > MAX_ARGS_LEN) {
      batches.push(current)
      current = []
      len = 0
    }
    current.push(file)
    len += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

let activeChild: ReturnType<typeof spawn> | null = null
let shuttingDown = false

// 被中断时必须带走子进程。此前 runner 没装信号处理：Ctrl-C / 终端关闭 / 工具取消
// 打断后，批次子进程会被 reparent 到 init 继续跑——实测捡到 4 个 PPID=1、跑满一天多
// 的僵留进程，合计吃掉约 50% CPU。转发信号，不留孤儿。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    const child = activeChild
    if (child === null) process.exit(128 + (constants.signals[sig] ?? 15))
    child.kill(sig)
    // 子进程可能已卡死不响应优雅退出，给宽限后硬杀 —— 否则 runner 自己也挂在这儿，
    // 又变成一个僵留进程。unref 让它不拦正常退出。
    setTimeout(() => {
      activeChild?.kill('SIGKILL')
      process.exit(128 + (constants.signals[sig] ?? 15))
    }, 5_000).unref()
  })
}

function runBatch(batch: string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...NODE_FLAGS, ...batch], {
      stdio: 'inherit',
      shell: false,
      env: testEnv,
    })
    activeChild = child
    child.on('exit', (code, signal) => {
      activeChild = null
      if (signal) {
        // 用 128+signum 表达「被信号带走」。不要把信号重放到自己身上——装了处理器后
        // 重放只会回到处理器，runner 反而卡住不退。
        resolve(128 + (constants.signals[signal] ?? 15))
        return
      }
      resolve(code ?? 1)
    })
    child.on('error', err => {
      console.error(err)
      activeChild = null
      resolve(1)
    })
  })
}

const batches = batchFiles(files)
if (batches.length > 1) {
  console.error(`Running ${files.length} test files in ${batches.length} batches (Windows cmdline limit)`)
}

let worstExit = 0
for (const batch of batches) {
  if (shuttingDown) break
  const code = await runBatch(batch)
  if (code !== 0) worstExit = code
}
process.exit(worstExit)
