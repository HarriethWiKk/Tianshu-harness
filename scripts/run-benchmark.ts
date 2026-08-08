import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { loadTaskSuite } from '../src/benchmark/task-suite.js'
import { runBenchmark } from '../src/benchmark/runner.js'
import { createRivetCliBenchmarkExecutor } from '../src/benchmark/executor.js'
import {
  benchmarkStoreFileName,
  countSuiteRunsInDir,
  defaultSessionDataDir,
} from '../src/benchmark/run-metadata.js'

const { values } = parseArgs({
  options: {
    suite: {
      type: 'string',
      short: 's',
    },
    'suite-id': {
      type: 'string',
    },
    provider: {
      type: 'string',
      short: 'p',
      default: 'deepseek',
    },
    model: {
      type: 'string',
      short: 'm',
      default: 'deepseek-v4-pro',
    },
    'store-file': {
      type: 'string',
      // 缺省在参数校验后动态计算：.rivet/benchmark/runs-<suiteId>-<nonce>.jsonl（P2-0）
    },
    'dry-run': {
      type: 'boolean',
      default: false,
    },
    workspace: {
      type: 'string',
    },
    'agent-entry': {
      type: 'string',
      default: 'dist/main.js',
    },
    'allow-write-tools': {
      type: 'boolean',
      default: false,
    },
    observe: {
      type: 'boolean',
      default: false,
    },
    'tool-preset': {
      type: 'string',
    },
    'session-data': {
      type: 'string',
    },
    hint: {
      type: 'boolean',
      default: false,
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
  },
})

function showHelp(): void {
  console.log(`benchmark — Rivet Agent Capability Benchmark Runner

Usage:
  npm run benchmark -- [options]

Options:
  --suite, -s <path>        Task suite JSON file (required)
  --suite-id <id>           Suite identifier for grouping runs (required)
  --provider, -p <name>     Provider name (default: deepseek)
  --model, -m <name>        Model name (default: deepseek-v4-pro)
  --store-file <path>       Output JSONL file (default: .rivet/benchmark/runs-<suiteId>-<nonce>.jsonl)
  --dry-run                 Generate blocked records without live execution
  --workspace <path>        Isolated workspace for a live benchmark (required)
  --agent-entry <path>      Built headless CLI entry (default: dist/main.js)
  --allow-write-tools       Pass the explicit headless write-tools opt-in
  --observe                 Set RIVET_SPEC_OBSERVE=1 in the agent env
                            (ShadowQueue observe arms collect would-hit stats)
  --tool-preset <name>      Set RIVET_TOOL_PRESET for the agent (e.g. taiyi)
  --hint                    Set RIVET_NEIGHBOR_HINT=1 (structure-neighbor hint A/B)
                            Recorded as hint:true in each store row
  --session-data <path>     Root for per-task RIVET_SESSION_DIR isolation +
                            telemetry harvest (default: os.tmpdir()/rivet-bench/<suiteId>-<nonce>)
  --help, -h                Show this help

Example (spark × taiyi measurement run):
  npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json \\
    --suite-id r1-spark-taiyi --provider deepseek-spark \\
    --model deepseek-v4-flash --tool-preset taiyi --observe \\
    --workspace /tmp/bench-ws --allow-write-tools
`)
  process.exit(0)
}

if (values.help) showHelp()

if (!values.suite || !values['suite-id']) {
  console.error('Error: --suite and --suite-id are required')
  console.error('Use --help for usage info')
  process.exit(1)
}

if (!values['dry-run'] && !values.workspace) {
  console.error('Error: live benchmarks require --workspace <isolated path>')
  process.exit(1)
}

const suite = loadTaskSuite(values.suite)

// P2-0 采数卫生：缺省 store 文件带 nonce（同名 store 两次执行混写 = 幽灵轮教训），
// 开跑前跨文件查重提醒（含 Phase 1 旧命名，同 suiteId 历史行数）。
const storeFile = values['store-file'] ?? join('.rivet/benchmark', benchmarkStoreFileName(values['suite-id']))
const priorRuns = countSuiteRunsInDir('.rivet/benchmark', values['suite-id'])
if (priorRuns > 0) {
  console.warn(`⚠ suite "${values['suite-id']}" 已有 ${priorRuns} 行历史数据（跨文件扫描），本次数据将追加累积，合并解读时注意`)
}
// 缺省 session-data 移出 workspace（工作区 rsync --delete 重置会删掉原始日志）。
const sessionDataRoot = resolve(values['session-data'] ?? defaultSessionDataDir(values['suite-id']))

// 显式 env 注入（测量回路 Phase 1）：observe/tool-preset 不再依赖父壳偶然
// 继承——报告里 provider/model/preset/observe 四元组从此可复现。P2-3 扩 hint。
const envOverrides: NodeJS.ProcessEnv = {}
if (values.observe) envOverrides.RIVET_SPEC_OBSERVE = '1'
if (values['tool-preset']) envOverrides.RIVET_TOOL_PRESET = values['tool-preset']
if (values.hint) envOverrides.RIVET_NEIGHBOR_HINT = '1'

const executor = values['dry-run']
  ? undefined
  : createRivetCliBenchmarkExecutor({
      cwd: resolve(values.workspace!),
      entryPoint: resolve(values['agent-entry']),
      allowWriteTools: values['allow-write-tools'],
      provider: values.provider,
      model: values.model,
      env: { ...process.env, ...envOverrides },
      sessionDataRoot,
    })
const report = await runBenchmark({
  suite,
  suiteId: values['suite-id'],
  provider: values.provider,
  model: values.model,
  storeFile,
  dryRun: values['dry-run'],
  hint: values.hint,
  executor,
})

console.log(`\nBenchmark complete: ${report.runs.length} task(s)`)
for (const run of report.runs) {
  const hit = run.session?.cache?.hitRatePct
  const extra = hit !== undefined && hit !== null ? ` (cache ${hit}%)` : ''
  console.log(`  ${run.taskId} → ${run.status}${extra}`)
}

// Speculation observe 汇总（各臂 enqueued/hits 跨任务求和）——T5c 解封判定的直读数字。
const armTotals = new Map<string, { enqueued: number; hits: number }>()
for (const run of report.runs) {
  for (const [arm, stats] of Object.entries(run.session?.speculationStats ?? {})) {
    const acc = armTotals.get(arm) ?? { enqueued: 0, hits: 0 }
    acc.enqueued += stats.enqueued
    acc.hits += stats.hits
    armTotals.set(arm, acc)
  }
}
if (armTotals.size > 0) {
  console.log('\nSpeculation observe (would-hit / enqueued):')
  for (const [arm, { enqueued, hits }] of [...armTotals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rate = enqueued > 0 ? ` = ${(hits / enqueued * 100).toFixed(1)}%` : ''
    console.log(`  ${arm}: ${hits}/${enqueued}${rate}`)
  }
}
console.log(`\nResults written to: ${storeFile}`)
console.log(`Session data root: ${sessionDataRoot}${values.hint ? ' · hint: on' : ''}`)
