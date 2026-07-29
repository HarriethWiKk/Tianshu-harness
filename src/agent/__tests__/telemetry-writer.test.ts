import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTelemetryWriter, VITALS_LITE_KIND, COGNITIVE_FRAME_LITE_KIND, ADVISORY_OUTCOME_KIND, ADVISORY_HOLDOUT_KIND } from '../telemetry-writer.js'
import { isTuiPerfEnabled } from '../../tui/engine/perf-monitor.js'
import type { PerceptionTelemetrySnapshot } from '../perception.js'
import { buildTelemetrySnapshot } from '../perception.js'

function makeSnapshot(turn = 1): PerceptionTelemetrySnapshot {
  return buildTelemetrySnapshot({
    ts: 1000,
    turn,
    phase: 'tianxuan-locating',
    sensorium: {
      momentum: 0.5,
      pressure: 0.1,
      confidence: 0.8,
      complexity: 0.3,
      freshness: 0.6,
      stability: 1.0,
    },
    strategy: {
      reasoningEffort: 'medium',
      shouldEscalate: false,
      thetaCycleInterval: 7,
      explorationBreadth: 0.5,
      commitThreshold: 0.5,
    },
    vigor: {
      tonic: 0.5,
      phasic: 0.3,
      curiosity: 0.4,
      vigor: 0.6,
      variability: 0.2,
      history: [],
    },
    theta: {
      inFlight: false,
      lastReason: null,
      lastDurationMs: null,
      lastErrorCount: 0,
      lastTimedOut: false,
      requestedCount: 0,
    },
    gitChangeRate: 0,
    prefixDrift: false,
  })
}

describe('createTelemetryWriter', () => {
  let cwd: string
  let prevDebug: string | undefined

  before(() => {
    // 写盘现已 opt-in（RIVET_DEBUG_TELEMETRY 门控，避免 sensorium.jsonl 无界增长）；
    // 未设置时返回 NOOP_WRITER，不落盘。本套件验证「启用后」的写入行为，故显式置位。
    prevDebug = process.env['RIVET_DEBUG_TELEMETRY']
    process.env['RIVET_DEBUG_TELEMETRY'] = '1'
    cwd = mkdtempSync(join(tmpdir(), 'rivet-telemetry-writer-'))
  })

  after(() => {
    if (prevDebug === undefined) delete process.env['RIVET_DEBUG_TELEMETRY']
    else process.env['RIVET_DEBUG_TELEMETRY'] = prevDebug
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes sensorium snapshot as JSONL line', async () => {
    const writer = createTelemetryWriter(cwd)
    const snapshot = makeSnapshot()

    writer.write(snapshot)
    await writer.flush()

    const raw = readFileSync(join(cwd, '.rivet', 'sensorium.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0]!)
    assert.equal(parsed.turn, 1)
    assert.equal(parsed.phase, 'tianxuan-locating')
  })

  it('appends multiple snapshots', async () => {
    const writer = createTelemetryWriter(cwd)
    writer.write(makeSnapshot(1))
    writer.write(makeSnapshot(2))
    await writer.flush()

    const raw = readFileSync(join(cwd, '.rivet', 'sensorium.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    assert.ok(lines.length >= 2, `expected >=2 lines, got ${lines.length}`)
  })

  it('does not throw on write failure (graceful degradation)', () => {
    // Write to an invalid path under /dev/null-like location
    const writer = createTelemetryWriter('/dev/null')
    assert.doesNotThrow(() => writer.write(makeSnapshot()))
  })
})

// ── W5 (incident 20b9714e): lite vitals are on by default ──
// Full telemetry stays opt-in, but the per-turn vitals-lite line writes without
// RIVET_DEBUG_TELEMETRY — post-incident analysis needs at least this data floor.
describe('createTelemetryWriter — lite mode (W5)', () => {
  let cwd: string
  let prevDebug: string | undefined
  let prevLite: string | undefined

  before(() => {
    prevDebug = process.env['RIVET_DEBUG_TELEMETRY']
    prevLite = process.env['RIVET_TELEMETRY_LITE']
    delete process.env['RIVET_DEBUG_TELEMETRY']
    delete process.env['RIVET_TELEMETRY_LITE']
    cwd = mkdtempSync(join(tmpdir(), 'rivet-telemetry-lite-'))
  })

  after(() => {
    if (prevDebug === undefined) delete process.env['RIVET_DEBUG_TELEMETRY']
    else process.env['RIVET_DEBUG_TELEMETRY'] = prevDebug
    if (prevLite === undefined) delete process.env['RIVET_TELEMETRY_LITE']
    else process.env['RIVET_TELEMETRY_LITE'] = prevLite
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes vitals-lite lines without RIVET_DEBUG_TELEMETRY', async () => {
    const writer = createTelemetryWriter(cwd)
    writer.write({ kind: VITALS_LITE_KIND, turn: 3, throttled: false })
    await writer.flush()

    const raw = readFileSync(join(cwd, '.rivet', 'sensorium.jsonl'), 'utf-8')
    const parsed = JSON.parse(raw.trim())
    assert.equal(parsed.kind, VITALS_LITE_KIND)
    assert.equal(parsed.turn, 3)
  })

  it('filters out full snapshots in lite mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-telemetry-lite2-'))
    try {
      const writer = createTelemetryWriter(dir)
      writer.write(makeSnapshot(1)) // full snapshot — must be dropped
      writer.write({ kind: 'recall-summary', foo: 1 }) // debug-only event — dropped
      await writer.flush()
      assert.throws(() => readFileSync(join(dir, '.rivet', 'sensorium.jsonl'), 'utf-8'),
        'no file must be created when only non-lite records were written')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows only perf-summary alongside lite telemetry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-telemetry-perf-lite-'))
    try {
      const writer = createTelemetryWriter(dir)
      writer.write({ kind: 'perf-summary', samples: { renderLive: { count: 1 } } })
      writer.write({ kind: 'recall-summary', foo: 1 })
      writer.write(makeSnapshot(1))
      await writer.flush()

      const raw = readFileSync(join(dir, '.rivet', 'sensorium.jsonl'), 'utf-8')
      const lines = raw.trim().split('\n').map(line => JSON.parse(line) as { kind?: string })
      assert.deepEqual(lines.map(line => line.kind), ['perf-summary'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('P3：cognitive-frame-lite 默认落盘，cognitive-frame 全量记录仍被过滤', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-telemetry-cogframe-'))
    try {
      const writer = createTelemetryWriter(dir)
      writer.write({ kind: COGNITIVE_FRAME_LITE_KIND, v: 1, turn: 4, fp: 'abc', mode: 'flow', relax: 0.25, lvl: 0, abort: null, q: 'mmmmmmmm' })
      writer.write({ kind: 'cognitive-frame', v: 1, turn: 4 }) // full 记录——lite 模式必须丢弃
      await writer.flush()

      const raw = readFileSync(join(dir, '.rivet', 'sensorium.jsonl'), 'utf-8')
      const lines = raw.trim().split('\n').map(line => JSON.parse(line) as { kind?: string })
      assert.deepEqual(lines.map(line => line.kind), [COGNITIVE_FRAME_LITE_KIND])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('P4 前置：advisory-outcome / advisory-holdout 默认落盘（晋级证据源 2）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-telemetry-advisory-'))
    try {
      const writer = createTelemetryWriter(dir)
      writer.write({ kind: ADVISORY_OUTCOME_KIND, key: 'self-verify', outcome: 'adopted', expectKind: 'tool_appears', deliveredTurn: 3, evaluatedTurn: 5 })
      writer.write({ kind: ADVISORY_HOLDOUT_KIND, key: 'self-verify', outcome: 'ignored', expectKind: 'tool_appears', deliveredTurn: 6, evaluatedTurn: 8, shadow: true })
      writer.write({ kind: 'recall-summary', foo: 1 }) // debug-only — 仍被过滤
      await writer.flush()

      const raw = readFileSync(join(dir, '.rivet', 'sensorium.jsonl'), 'utf-8')
      const lines = raw.trim().split('\n').map(line => JSON.parse(line) as { kind?: string })
      assert.deepEqual(lines.map(line => line.kind), [ADVISORY_OUTCOME_KIND, ADVISORY_HOLDOUT_KIND])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('RIVET_TELEMETRY_LITE=0 disables even lite lines', async () => {
    process.env['RIVET_TELEMETRY_LITE'] = '0'
    try {
      const dir = mkdtempSync(join(tmpdir(), 'rivet-telemetry-lite3-'))
      try {
        const writer = createTelemetryWriter(dir)
        writer.write({ kind: VITALS_LITE_KIND, turn: 1 })
        await writer.flush()
        assert.throws(() => readFileSync(join(dir, '.rivet', 'sensorium.jsonl'), 'utf-8'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      delete process.env['RIVET_TELEMETRY_LITE']
    }
  })
})

// RIVET_DEBUG_TELEMETRY 的两侧语义：遥测通道按真值判断放行全量，而 TUI perf
// 监视器只认字面 '1'。这个差异是有用的（能开全量语料而不常驻 perf 那行 UI），
// 但只要有一侧被"顺手统一"成另一种写法，另一侧就静默改变行为——本机默认值就是
// 靠这个差异设成 full 的。两条一起钉住。
describe('RIVET_DEBUG_TELEMETRY 的取值语义', () => {
  it('任意非空值都开全量遥测，不限于 "1"', async () => {
    const prevDebug = process.env['RIVET_DEBUG_TELEMETRY']
    const prevLite = process.env['RIVET_TELEMETRY_LITE']
    // lite 关掉，这样 full 通道是唯一放行来源，避免用 lite 白名单蒙对。
    process.env['RIVET_TELEMETRY_LITE'] = '0'
    try {
      for (const value of ['1', 'full', 'true', 'yes']) {
        process.env['RIVET_DEBUG_TELEMETRY'] = value
        const dir = mkdtempSync(join(tmpdir(), 'rivet-telemetry-truthy-'))
        try {
          const writer = createTelemetryWriter(dir)
          // 非 lite 白名单的 kind：只有 full 打开时才落盘。
          writer.write({ kind: 'cognitive-frame', turn: 1 } as never)
          await writer.flush()
          const body = readFileSync(join(dir, '.rivet', 'sensorium.jsonl'), 'utf-8')
          assert.match(body, /cognitive-frame/, `值 ${value} 未开启全量遥测`)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    } finally {
      if (prevDebug === undefined) delete process.env['RIVET_DEBUG_TELEMETRY']
      else process.env['RIVET_DEBUG_TELEMETRY'] = prevDebug
      if (prevLite === undefined) delete process.env['RIVET_TELEMETRY_LITE']
      else process.env['RIVET_TELEMETRY_LITE'] = prevLite
    }
  })

  it('TUI perf 监视器只认字面 "1" —— full 不该拉起 perf 那行 UI', () => {
    assert.equal(isTuiPerfEnabled([], { RIVET_DEBUG_TELEMETRY: '1' }), true)
    assert.equal(isTuiPerfEnabled([], { RIVET_DEBUG_TELEMETRY: 'full' }), false)
    assert.equal(isTuiPerfEnabled([], {}), false)
    // 显式开关不受影响。
    assert.equal(isTuiPerfEnabled(['--debug-perf'], {}), true)
  })
})
