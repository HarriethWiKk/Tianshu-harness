import type { BenchmarkRun, CapabilityMatrixRow } from './types.js'
import { readBenchmarkRuns } from './store.js'

/**
 * Compute a single capability matrix row from a set of runs for the same
 * (provider, model, suiteId) combination.
 */
export function computeMatrixRow(
  runs: BenchmarkRun[],
  provider: string,
  model: string,
  suiteId: string,
): CapabilityMatrixRow {
  const passed = runs.filter(r => r.status === 'passed').length
  const failed = runs.filter(r => r.status === 'failed').length
  const blocked = runs.filter(r => r.status === 'blocked').length
  const total = runs.length

  // median turns: sort the turns values, pick middle
  const turns = runs
    .map(r => r.metrics.turns)
    .sort((a, b) => a - b)
  const medianTurns = computeMedian(turns)

  // median tool calls
  const toolCalls = runs
    .map(r => r.metrics.toolCalls)
    .sort((a, b) => a - b)
  const medianToolCalls = computeMedian(toolCalls)

  // average cost
  const totalCost = runs.reduce((sum, r) => sum + (r.metrics.costUsd ?? 0), 0)
  const averageCostUsd = total > 0 ? totalCost / total : 0

  return {
    provider,
    model,
    suiteId,
    runs: total,
    passed,
    failed,
    blocked,
    passRate: total > 0 ? passed / total : 0,
    medianTurns,
    medianToolCalls,
    averageCostUsd: Math.round(averageCostUsd * 10000) / 10000,
  }
}

function computeMedian(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100
  }
  return sorted[mid]!
}

/**
 * Generate a Markdown capability matrix report from a store file.
 */
export function generateReportFromStore(
  storeFile: string,
  suiteId: string,
): string {
  const runs = readBenchmarkRuns(storeFile, { suiteId })

  // Group runs by (provider, model)
  const groups = new Map<string, BenchmarkRun[]>()
  for (const run of runs) {
    const key = `${run.provider}\x00${run.model}`
    const existing = groups.get(key)
    if (existing) {
      existing.push(run)
    } else {
      groups.set(key, [run])
    }
  }

  const rows: CapabilityMatrixRow[] = []
  for (const [key, groupRuns] of groups) {
    const [provider, model] = key.split('\x00') as [string, string]
    rows.push(computeMatrixRow(groupRuns, provider!, model!, suiteId))
  }

  return generateMarkdownReport(rows, suiteId) + renderSessionSections(runs)
}

/**
 * Session-telemetry sections (2026-08-07 测量回路 Phase 1)：speculation observe
 * 各臂命中率 + provider 维度缓存对照。runs 里没有 session 数据时输出空串——
 * 旧报告字节不变。
 */
export function renderSessionSections(runs: BenchmarkRun[]): string {
  const parts: string[] = []

  // ── Speculation observe：按 provider×model×arm 聚合 would-hit 率 ──
  const armGroups = new Map<string, { enqueued: number; hits: number }>()
  for (const run of runs) {
    for (const [arm, stats] of Object.entries(run.session?.speculationStats ?? {})) {
      if (stats.enqueued === 0 && stats.hits === 0) continue
      const key = `${run.provider}\x00${run.model}\x00${arm}`
      const acc = armGroups.get(key) ?? { enqueued: 0, hits: 0 }
      acc.enqueued += stats.enqueued
      acc.hits += stats.hits
      armGroups.set(key, acc)
    }
  }
  if (armGroups.size > 0) {
    parts.push(
      '',
      '## Speculation Observe (would-hit / enqueued)',
      '',
      '| Provider | Model | Arm | Enqueued | Would-Hit | Rate |',
      '|----------|-------|-----|----------|-----------|------|',
    )
    for (const [key, { enqueued, hits }] of [...armGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [provider, model, arm] = key.split('\x00') as [string, string, string]
      const rate = enqueued > 0 ? `${(hits / enqueued * 100).toFixed(1)}%` : '—'
      parts.push(`| ${provider} | ${model} | ${arm} | ${enqueued} | ${hits} | ${rate} |`)
    }
  }

  // ── Provider-dimension cache：spark 与官方同 wire 模型 id 的对照主体 ──
  const cacheGroups = new Map<string, { requests: number; input: number; cacheRead: number }>()
  for (const run of runs) {
    for (const bucket of run.session?.cache?.byProviderModel ?? []) {
      const key = `${bucket.provider ?? '(unknown)'}\x00${bucket.model}`
      const acc = cacheGroups.get(key) ?? { requests: 0, input: 0, cacheRead: 0 }
      acc.requests += bucket.requests
      acc.input += bucket.input
      acc.cacheRead += bucket.cacheRead
      cacheGroups.set(key, acc)
    }
  }
  if (cacheGroups.size > 0) {
    parts.push(
      '',
      '## Session Cache by Provider (main-turn rows)',
      '',
      '| Provider | Model | Requests | Input | Cache Read | Hit Rate |',
      '|----------|-------|----------|-------|------------|----------|',
    )
    for (const [key, { requests, input, cacheRead }] of [...cacheGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [provider, model] = key.split('\x00') as [string, string]
      const rate = input > 0 ? `${(cacheRead / input * 100).toFixed(1)}%` : '—'
      parts.push(`| ${provider} | ${model} | ${requests} | ${input} | ${cacheRead} | ${rate} |`)
    }
  }

  if (parts.length === 0) return ''
  return '\n' + parts.join('\n') + '\n'
}

/**
 * Generate a Markdown capability matrix report from pre-computed rows.
 */
export function generateMarkdownReport(
  rows: CapabilityMatrixRow[],
  suiteId: string,
): string {
  const parts: string[] = [
    `# Benchmark Report: ${suiteId}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
  ]

  if (rows.length === 0) {
    parts.push('No benchmark runs recorded for this suite.')
    return parts.join('\n')
  }

  parts.push(
    '| Provider | Model | Runs | Passed | Failed | Blocked | Pass Rate | Median Turns | Median Tool Calls | Avg Cost (USD) |',
    '|----------|-------|------|--------|--------|---------|-----------|--------------|-------------------|----------------|',
  )

  for (const row of rows) {
    const passRatePct = (row.passRate * 100).toFixed(1)
    parts.push(
      `| ${row.provider} | ${row.model} | ${row.runs} | ${row.passed} | ${row.failed} | ${row.blocked} | ${passRatePct}% | ${row.medianTurns} | ${row.medianToolCalls} | ${row.averageCostUsd} |`,
    )
  }

  parts.push('')
  parts.push('> **Note:** `blocked` records come from dry-runs or an explicitly blocked executor. Only `passed` and `failed` records represent completed live executions.')

  return parts.join('\n')
}
