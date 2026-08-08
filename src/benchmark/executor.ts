import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { parseUsageRows, aggregateUsageRows } from '../cache/usage-aggregator.js'
import type { BenchmarkFailure, BenchmarkMetrics, BenchmarkSessionData, BenchmarkStatus, TaskDefinition } from './types.js'

export interface BenchmarkExecutionResult {
  status: BenchmarkStatus
  metrics?: Partial<BenchmarkMetrics>
  failures?: BenchmarkFailure[]
  /** Harvested session telemetry (speculationStats / provider-dimension cache rows).
   *  Present only when sessionDataRoot is configured and the agent actually ran. */
  session?: BenchmarkSessionData
}

export interface BenchmarkExecutor {
  execute(task: TaskDefinition): Promise<BenchmarkExecutionResult>
}

export interface RivetCliBenchmarkExecutorOptions {
  cwd: string
  entryPoint: string
  allowWriteTools?: boolean
  env?: NodeJS.ProcessEnv
  /** Pinned provider for the spawned CLI（透传 `--provider`）。2026-08-07 前
   *  这个值只写进报告字段、不进子进程——spark vs 官方对照因此不可复现。 */
  provider?: string
  /** Pinned model for the spawned CLI（透传 `--model`）。 */
  model?: string
  /** When set, each task runs with RIVET_SESSION_DIR=<root>/<taskId>（平铺覆盖，
   *  见 config/paths.ts sessionsDir），session meta 与 cache-log 落在确定位置，
   *  跑完由 harvestSessionData 回收进结果。Absent → 沿用默认 slug 目录、不回收。 */
  sessionDataRoot?: string
}

interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface StreamSummary {
  metrics: BenchmarkMetrics
  resultError?: string
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.once('close', exitCode => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

async function runShellCommand(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(command, [], {
      cwd,
      env: env ?? process.env,
      shell: true,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.once('close', exitCode => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

function failure(className: string, message: string): BenchmarkExecutionResult {
  return {
    status: 'failed',
    failures: [{ class: className, message: message.slice(0, 1000) }],
  }
}

function numberAt(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = source[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

/** Parse Tianshu's stable headless NDJSON stream without coupling to AgentLoop. */
export function summarizeStreamJson(stdout: string): StreamSummary {
  let turns = 0
  let toolCalls = 0
  let usage: unknown
  let resultError: string | undefined

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'tool_use') toolCalls++
      if (event.type === 'turn_complete') {
        turns++
        usage = event.usage
      }
      if (event.type === 'result') {
        usage = event.usage ?? usage
        if (event.is_error === true) resultError = typeof event.result === 'string' ? event.result : 'Agent reported an error'
      }
      if (event.type === 'error') resultError = typeof event.error === 'string' ? event.error : 'Agent reported an error'
    } catch {
      // Providers or process diagnostics may write non-NDJSON lines. They are
      // retained in the process failure message but do not invalidate metrics.
    }
  }

  const inputTokens = numberAt(usage, ['inputTokens', 'input_tokens'])
  const cacheReadTokens = numberAt(usage, ['cacheReadInputTokens', 'cache_read_input_tokens'])
  const costUsd = numberAt(usage, ['costUsd', 'cost_usd'])
  const cacheHitRate = inputTokens && inputTokens > 0 && cacheReadTokens !== undefined
    ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens))
    : undefined

  return {
    metrics: {
      turns,
      toolCalls,
      retries: 0,
      ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    ...(resultError ? { resultError } : {}),
  }
}

/**
 * Spawn argument assembly for the headless CLI. Pin provider/model explicitly —
 * headless supports both flags; without them the run silently uses the
 * workspace/user default and the report's provider/model columns describe an
 * intention, not reality (2026-08-07 测量回路 Phase 1 修复——此前两个 flag
 * 只进报告字段不进子进程).
 */
export function buildAgentArgs(
  entryPoint: string,
  prompt: string,
  options: Pick<RivetCliBenchmarkExecutorOptions, 'provider' | 'model' | 'allowWriteTools'>,
): string[] {
  const args = [entryPoint, '--print', prompt, '--stream-json']
  if (options.provider) args.push('--provider', options.provider)
  if (options.model) args.push('--model', options.model)
  if (options.allowWriteTools) args.push('--dangerously-skip-permissions')
  return args
}

/**
 * Harvest session telemetry from a per-task session directory (flat layout —
 * RIVET_SESSION_DIR override). Best-effort: any miss returns undefined /
 * partial data, never throws. Worker sub-sessions (worker-*) share the same
 * directory and are excluded; among main sessions the freshest meta wins.
 */
export function harvestSessionData(sessionDir: string): BenchmarkSessionData | undefined {
  try {
    const metaFiles = readdirSync(sessionDir)
      .filter(name => name.endsWith('.meta.json') && !name.startsWith('worker-'))
    let best: { id: string; meta: Record<string, unknown>; updatedAt: number } | undefined
    for (const file of metaFiles) {
      try {
        const meta = JSON.parse(readFileSync(join(sessionDir, file), 'utf8')) as Record<string, unknown>
        const updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : 0
        if (!best || updatedAt > best.updatedAt) {
          best = { id: file.slice(0, -'.meta.json'.length), meta, updatedAt }
        }
      } catch { /* corrupt meta — skip */ }
    }
    if (!best) return undefined

    const session: BenchmarkSessionData = { sessionId: best.id }
    if (typeof best.meta.model === 'string' && best.meta.model) session.model = best.meta.model
    const spec = best.meta.speculationStats
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      session.speculationStats = spec as BenchmarkSessionData['speculationStats']
    }
    const engine = best.meta.llmSpeculationEngine
    if (engine && typeof engine === 'object' && !Array.isArray(engine)) {
      session.llmSpeculationEngine = engine as BenchmarkSessionData['llmSpeculationEngine']
    }

    try {
      const raw = readFileSync(join(sessionDir, best.id, 'cache-log.jsonl'), 'utf8')
      const rows = parseUsageRows(raw)
      if (rows.length > 0) {
        const agg = aggregateUsageRows(rows)
        session.cache = {
          requests: agg.totals.requests,
          input: agg.totals.input,
          cacheRead: agg.totals.cacheRead,
          hitRatePct: agg.totals.hitRate,
          byProviderModel: agg.models.map(m => ({
            model: m.model,
            ...(m.provider ? { provider: m.provider } : {}),
            requests: m.requests,
            input: m.input,
            cacheRead: m.cacheRead,
            hitRatePct: m.hitRate,
          })),
        }
      }
    } catch { /* no cache log — agent may have died before the first turn */ }

    return session
  } catch {
    return undefined
  }
}

/**
 * Executes one task through the published headless CLI and verifies its task
 * contract. Callers must provide an isolated workspace for code-edit tasks.
 */
export function createRivetCliBenchmarkExecutor(options: RivetCliBenchmarkExecutorOptions): BenchmarkExecutor {
  return {
    async execute(task): Promise<BenchmarkExecutionResult> {
      if (!existsSync(options.entryPoint)) {
        return failure('agent_entry_missing', `Agent entry point does not exist: ${options.entryPoint}`)
      }

      // Per-task session isolation: a flat RIVET_SESSION_DIR per task makes the
      // harvest deterministic (no slug guessing) and keeps runs from mixing.
      const sessionDir = options.sessionDataRoot ? join(options.sessionDataRoot, task.id) : undefined
      const env: NodeJS.ProcessEnv | undefined = options.env || sessionDir
        ? { ...(options.env ?? process.env), ...(sessionDir ? { RIVET_SESSION_DIR: sessionDir } : {}) }
        : undefined

      for (const command of task.setupCommands) {
        const result = await runShellCommand(command, options.cwd, task.timeoutMs, env)
        if (result.timedOut) return failure('setup_timeout', `Setup command timed out: ${command}`)
        if (result.exitCode !== 0) return failure('setup_failed', `Setup command failed (${result.exitCode}): ${command}\n${result.stderr || result.stdout}`)
      }

      const args = buildAgentArgs(options.entryPoint, task.prompt, options)
      const agent = await runProcess(process.execPath, args, options.cwd, task.timeoutMs, env)
      const summary = summarizeStreamJson(agent.stdout)
      // Harvest regardless of pass/fail — hit-rate data from failed runs is
      // still evidence (and failures are exactly where observe data matters).
      const session = sessionDir ? harvestSessionData(sessionDir) : undefined
      const sessionField = session ? { session } : {}
      if (agent.timedOut) return { ...failure('agent_timeout', `Agent timed out after ${task.timeoutMs}ms`), metrics: summary.metrics, ...sessionField }
      if (agent.exitCode !== 0 || summary.resultError) {
        return {
          ...failure('agent_failed', summary.resultError ?? `Agent exited with ${agent.exitCode}: ${agent.stderr || agent.stdout}`),
          metrics: summary.metrics,
          ...sessionField,
        }
      }

      for (const command of task.successCommands) {
        const result = await runShellCommand(command, options.cwd, task.timeoutMs, env)
        if (result.timedOut) return { ...failure('verification_timeout', `Verification command timed out: ${command}`), metrics: summary.metrics, ...sessionField }
        if (result.exitCode !== 0) {
          return {
            ...failure('verification_failed', `Verification command failed (${result.exitCode}): ${command}\n${result.stderr || result.stdout}`),
            metrics: summary.metrics,
            ...sessionField,
          }
        }
      }

      return { status: 'passed', metrics: summary.metrics, ...sessionField }
    },
  }
}
