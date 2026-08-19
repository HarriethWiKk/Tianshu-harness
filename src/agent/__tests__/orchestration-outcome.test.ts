import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeamOutcome } from '../orchestration-outcome.js'
import type { TeamRunSummary } from '../team-orchestrator.js'
import type { CoordinatorRun } from '../coordinator.js'
import type { PlanExecutorRun } from '../plan-executor.js'
import type { WorkerResult } from '../work-order.js'

function mkResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'w',
    status: 'passed',
    summary: 's',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...over,
  }
}

function mkRun(results: WorkerResult[]): CoordinatorRun {
  return { status: 'completed', results, packet: 'run' }
}

function mkSummary(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return {
    mode: 'standard',
    planned: [],
    tasks: [],
    waves: [{ id: 'w0', taskIds: ['T1'], reason: 'r', parallelLimit: 1, risk: 'low' }],
    dispatched: 0,
    blocked: [],
    packet: '',
    ...over,
  }
}

test('run 缺席（未派发/预览）：workers.total === 0，不带 waveGate/reviewVerdict', () => {
  const summary = mkSummary({ dispatched: 0 }) // summary.run 缺席
  const outcome = buildTeamOutcome(summary, 0, {}) // run.gate/reviewVerdict 均缺席
  assert.equal(outcome.kind, 'team')
  assert.equal(outcome.dispatched, 0)
  assert.equal(outcome.workers.total, 0)
  assert.equal(outcome.workers.passed, 0)
  assert.equal('waveGate' in outcome, false)
  assert.equal('reviewVerdict' in outcome, false)
  // 预览/未派发：无整体执行状态可谈，两个新字段也不写。
  assert.equal('completedWaves' in outcome, false)
  assert.equal('stoppedReason' in outcome, false)
  assert.equal('workerRows' in outcome, false, '预览/未派发无结果行')
})

test('两个 worker 一过一败：workers = { total: 2, passed: 1 }', () => {
  const summary = mkSummary({
    dispatched: 2,
    run: mkRun([mkResult(), mkResult({ status: 'failed', workOrderId: 'w2' })]),
  })
  const outcome = buildTeamOutcome(summary, 0, {})
  assert.deepEqual(outcome.workers, { total: 2, passed: 1 })
})

test('gate/reviewVerdict 透传：failures 原样、verdict 原样、waveGate 不含 wave', () => {
  const gate: PlanExecutorRun['gate'] = { wave: 0, passed: false, failures: ['npx tsc --noEmit — 3 errors'] }
  const summary = mkSummary({
    dispatched: 2,
    run: mkRun([mkResult(), mkResult({ status: 'passed', workOrderId: 'w2' })]),
  })
  const outcome = buildTeamOutcome(summary, 0, { gate, reviewVerdict: 'rejected' })
  assert.deepEqual(outcome.waveGate, { passed: false, failures: ['npx tsc --noEmit — 3 errors'] })
  assert.equal('wave' in outcome.waveGate!, false)
  assert.equal(outcome.reviewVerdict, 'rejected')
})

test('totalWaves 取 summary.waves.length，wave 取入参 fromWave', () => {
  const summary = mkSummary({ dispatched: 2, run: mkRun([mkResult()]) })
  const outcome = buildTeamOutcome(summary, 3, {})
  assert.equal(outcome.wave, 3)
  assert.equal(outcome.totalWaves, 1)
})

test('末波完成：stoppedReason === completed，completedWaves === totalWaves', () => {
  const summary = mkSummary({
    dispatched: 1,
    waves: [{ id: 'w0', taskIds: ['T1'], reason: 'r', parallelLimit: 1, risk: 'low' }],
    run: mkRun([mkResult()]),
  })
  const outcome = buildTeamOutcome(summary, 0, {})
  assert.equal(outcome.stoppedReason, 'completed')
  assert.equal(outcome.completedWaves, 1)
  assert.equal(outcome.completedWaves, outcome.totalWaves)
})

test('部分通过（非末波）：stoppedReason === partial，completedWaves 计本波', () => {
  const summary = mkSummary({
    dispatched: 2,
    waves: [
      { id: 'w0', taskIds: ['T1', 'T2'], reason: 'r', parallelLimit: 2, risk: 'low' },
      { id: 'w1', taskIds: ['T3'], reason: 'r', parallelLimit: 1, risk: 'low' },
    ],
    run: mkRun([mkResult(), mkResult({ status: 'failed', workOrderId: 'w2' })]),
  })
  const outcome = buildTeamOutcome(summary, 0, {})
  assert.equal(outcome.stoppedReason, 'partial')
  assert.equal(outcome.completedWaves, 1)
  assert.ok(outcome.completedWaves! < outcome.totalWaves)
})

test('整体 stop reason：整波失败 → all-failed，completedWaves 不计本波', () => {
  const summary = mkSummary({
    dispatched: 2,
    waves: [
      { id: 'w0', taskIds: ['T1', 'T2'], reason: 'r', parallelLimit: 2, risk: 'low' },
      { id: 'w1', taskIds: ['T3'], reason: 'r', parallelLimit: 1, risk: 'low' },
    ],
    run: mkRun([mkResult({ status: 'failed', workOrderId: 'w1' }), mkResult({ status: 'failed', workOrderId: 'w2' })]),
  })
  const outcome = buildTeamOutcome(summary, 0, {})
  assert.equal(outcome.stoppedReason, 'all-failed')
  assert.equal(outcome.completedWaves, 0)
})

test('整体 stop reason：波间硬门禁未过 → wave-gate（有 run 才写）', () => {
  const summary = mkSummary({
    dispatched: 2,
    waves: [
      { id: 'w0', taskIds: ['T1', 'T2'], reason: 'r', parallelLimit: 2, risk: 'low' },
      { id: 'w1', taskIds: ['T3'], reason: 'r', parallelLimit: 1, risk: 'low' },
    ],
    run: mkRun([mkResult(), mkResult()]),
  })
  const gate: PlanExecutorRun['gate'] = { wave: 0, passed: false, failures: ['npx tsc --noEmit — 2 errors'] }
  const outcome = buildTeamOutcome(summary, 0, { gate })
  assert.equal(outcome.stoppedReason, 'wave-gate')
  assert.equal(outcome.completedWaves, 1)
})

// ── workerRows 战报行（星流战报，2026-08-18）────────────────────────────

test('workerRows：失败在前、task 取尾段、字段截断与压缩', () => {
  const summary = mkSummary({
    dispatched: 3,
    run: mkRun([
      mkResult({
        workOrderId: 'tu1-starflow-team-w0:T1',
        status: 'passed',
        summary: 'emitter.cpp 落盘，spirv-val 全绿',
        objective: 'SPIR-V 生成器主入口 AST 直出',
        changedFiles: ['src/spirv/emitter.cpp', 'src/spirv/emitter.h', 'tests/p4_verify.cpp', 'extra.txt'],
        diffArtifactId: 'delegate_task:ab12cd34',
        usage: { input_tokens: 12_345, output_tokens: 4_567 },
        durationMs: 185_000,
      }),
      mkResult({
        workOrderId: 'tu1-starflow-team-w0:T2',
        status: 'blocked',
        failureReason: 'timeout',
        summary: `${'CMake configure 失败：'.repeat(30)}`,
      }),
    ]),
  })
  const outcome = buildTeamOutcome(summary, 0, {})
  const rows = outcome.workerRows!
  assert.equal(rows.length, 2)
  // 失败在前（同序稳定性交给输入顺序）
  assert.equal(rows[0]!.status, 'blocked')
  assert.equal(rows[1]!.status, 'passed')
  // task 尾段提取
  assert.equal(rows[0]!.task, 'T2')
  assert.equal(rows[1]!.task, 'T1')
  // summary 截断 ≤100
  assert.ok(rows[0]!.summary.length <= 100)
  assert.ok(rows[0]!.summary.endsWith('…'))
  // changedFiles 最多 3 个文件名（basename），计数单独给
  assert.equal(rows[1]!.changedCount, 4)
  assert.deepEqual(rows[1]!.changedFiles, ['emitter.cpp', 'emitter.h', 'p4_verify.cpp'])
  // usage/duration 原样进 row
  assert.deepEqual(rows[1]!.usage, { input: 12_345, output: 4_567 })
  assert.equal(rows[1]!.durationMs, 185_000)
  assert.equal(rows[1]!.diffArtifactId, 'delegate_task:ab12cd34')
})

test('workerRows：行数超上限截断，保失败优先的前 40 行', () => {
  const many: WorkerResult[] = Array.from({ length: 50 }, (_, i) =>
    mkResult({ workOrderId: `w:T${i}`, status: i < 10 ? 'failed' : 'passed' }))
  const summary = mkSummary({ dispatched: 50, run: mkRun(many) })
  const rows = buildTeamOutcome(summary, 0, {}).workerRows!
  assert.equal(rows.length, 40)
  // 截断保住的是失败行 + 靠前的通过行
  assert.equal(rows.filter(r => r.status === 'failed').length, 10)
})

test('workerRows：无 usage/duration/changedFiles 的极简结果只带必填字段', () => {
  const summary = mkSummary({ dispatched: 1, run: mkRun([mkResult({ workOrderId: 'w:T9' })]) })
  const rows = buildTeamOutcome(summary, 0, {}).workerRows!
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.task, 'T9')
  assert.equal(rows[0]!.changedCount, 0)
  assert.equal('usage' in rows[0]!, false)
  assert.equal('durationMs' in rows[0]!, false)
})
