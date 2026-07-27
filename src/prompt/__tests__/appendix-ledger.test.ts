import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { CvmInjectionSource } from '../../context/pressure-monitor.js'

/**
 * CVM egress is metered where the bytes are actually written into a
 * <context-update>, not where the content is prepared. The old per-turn-step
 * charging counted every internal turn even though the appendix is only
 * rebuilt at user boundaries — an 11.2x overstatement in session 91abf2f4,
 * which throttled advisories that were never actually costing anything.
 *
 * Design: docs/design/2026-07-26-cvm-overhead-metering-fix.md
 */

const CONTEXT_WINDOW = 200_000

function createEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    appendixDelta: true,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/test/project',
      rivetMd: '# Test Project',
    },
  })
}

function userTurn(text: string): OaiMessage[] {
  return [{ role: 'user', content: text }]
}

/** Bytes booked for one source since the last drain. */
function charged(rows: Array<{ source: CvmInjectionSource; chars: number }>, source: CvmInjectionSource): number {
  return rows.find(r => r.source === source)?.chars ?? 0
}

describe('appendix ledger: charge at the emission point', () => {
  it('books a projection block once at the boundary that emits it', () => {
    const engine = createEngine()
    const projection = '<cognitive-mirror>steady state</cognitive-mirror>'
    engine.setCognitiveProjection(projection)

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    assert.equal(charged(engine.drainAppendixLedger(), 'projection'), projection.length)
  })

  it('charges nothing on tool turns inside the same user boundary', () => {
    const engine = createEngine()
    const projection = '<cognitive-mirror>steady state</cognitive-mirror>'
    engine.setCognitiveProjection(projection)

    const messages = userTurn('do the thing')
    engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
    engine.drainAppendixLedger()

    // Tool turns re-enter buildOaiRequest with the same last user message; the
    // cached appendix is reused verbatim, so no new bytes ship.
    for (let i = 0; i < 5; i++) {
      engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
      assert.deepEqual(engine.drainAppendixLedger(), [], `tool turn ${i} must be free`)
    }
  })

  it('charges nothing at the next boundary when the block is byte-stable', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>unchanged</cognitive-mirror>')

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    engine.drainAppendixLedger()

    engine.buildOaiRequest(userTurn('second'), undefined, CONTEXT_WINDOW)
    assert.equal(charged(engine.drainAppendixLedger(), 'projection'), 0)
  })

  it('books only the sub-block that changed, not the whole appendix', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>v1</cognitive-mirror>')
    engine.setToolContext('<tool-context>read_file, grep</tool-context>')

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    engine.drainAppendixLedger()

    const nextProjection = '<cognitive-mirror>v2 — evidence updated</cognitive-mirror>'
    engine.setCognitiveProjection(nextProjection)
    engine.buildOaiRequest(userTurn('second'), undefined, CONTEXT_WINDOW)

    const rows = engine.drainAppendixLedger()
    assert.equal(charged(rows, 'projection'), nextProjection.length)
    assert.equal(charged(rows, 'tool-context'), 0, 'an unchanged block must not be re-charged')
  })

  it('separates advisory and control-plane blocks by source', () => {
    const engine = createEngine()
    const advisory = '<星域-advisory>verify before delivering</星域-advisory>'
    const control = '<control-plane>focus: inspect</control-plane>'
    engine.setHarnessAdvisoryBlock(advisory)
    engine.setControlPlaneAppendix(control)

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)

    const rows = engine.drainAppendixLedger()
    assert.equal(charged(rows, 'advisory-appendix'), advisory.length)
    assert.equal(charged(rows, 'control-appendix'), control.length)
  })

  it('books ephemeral hints in full — they ship outside the delta every boundary', () => {
    const engine = createEngine()
    const ephemeral = '【瑶光·复现即证】上轮引用了文件名但未读取。'
    engine.setCognitiveProjection('<cognitive-mirror>stable</cognitive-mirror>', ephemeral)

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    assert.equal(charged(engine.drainAppendixLedger(), 'ephemeral'), ephemeral.length)

    engine.buildOaiRequest(userTurn('second'), undefined, CONTEXT_WINDOW)
    assert.equal(
      charged(engine.drainAppendixLedger(), 'ephemeral'),
      ephemeral.length,
      'ephemeral bytes are new every boundary — delta never suppresses them',
    )
  })

  it('leaves unmetered blocks (git status, progress) out of the ledger', () => {
    const engine = new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      appendixDelta: true,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/test/project',
        gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
        rivetMd: '# Test Project',
      },
    })

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    assert.deepEqual(engine.drainAppendixLedger(), [], 'only CVM-tagged blocks are metered')
  })
})

describe('appendix ledger: drain semantics', () => {
  it('is consume-once — a second drain returns nothing', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>once</cognitive-mirror>')
    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)

    assert.ok(engine.drainAppendixLedger().length > 0)
    assert.deepEqual(
      engine.drainAppendixLedger(),
      [],
      'a replayed request (failover) must not be charged twice',
    )
  })
})

describe('appendix ledger: side-path hermeticity', () => {
  it('books nothing for a side-path build', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>summary prompt</cognitive-mirror>')

    engine.buildOaiRequest(userTurn('summarize this'), undefined, CONTEXT_WINDOW, { sidePath: true })

    assert.deepEqual(
      engine.drainAppendixLedger(),
      [],
      'compaction-summary bytes never enter the main history, so they must not be metered',
    )
  })

  it('a side-path build between two boundaries does not disturb main-path accounting', () => {
    const engine = createEngine()
    const projection = '<cognitive-mirror>stable across compaction</cognitive-mirror>'
    engine.setCognitiveProjection(projection)

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    assert.equal(charged(engine.drainAppendixLedger(), 'projection'), projection.length)

    engine.buildOaiRequest(userTurn('summarize'), undefined, CONTEXT_WINDOW, { sidePath: true })
    assert.deepEqual(engine.drainAppendixLedger(), [])

    engine.buildOaiRequest(userTurn('second'), undefined, CONTEXT_WINDOW)
    assert.equal(
      charged(engine.drainAppendixLedger(), 'projection'),
      0,
      'the side path must not have reset the delta baseline',
    )
  })
})

describe('appendix ledger: Top-K eviction', () => {
  // appendixMaxChars = clamp(window * 0.05 * 4, 2_000, …) → a 3k window leaves
  // the 2k floor, where plan-mode (salience 0.95) evicts tool-context (0.7).
  const TIGHT_WINDOW = 3_000
  const toolContext = '<tool-context>' + 'x'.repeat(4_000) + '</tool-context>'

  it('does not charge a metered block that the budget dropped', () => {
    const engine = createEngine()
    engine.setToolContext(toolContext)
    engine.setPlanModeState('planning')

    const request = engine.buildOaiRequest(userTurn('plan it'), undefined, TIGHT_WINDOW)

    assert.ok(
      !JSON.stringify(request.messages).includes('<tool-context>'),
      'fixture precondition: the budget must actually evict tool-context',
    )
    assert.equal(
      charged(engine.drainAppendixLedger(), 'tool-context'),
      0,
      'a block that never reached the wire costs nothing',
    )
  })

  it('charges the truncated length when Top-K shortens a block', () => {
    const engine = createEngine()
    engine.setToolContext(toolContext)

    engine.buildOaiRequest(userTurn('go'), undefined, TIGHT_WINDOW)

    const booked = charged(engine.drainAppendixLedger(), 'tool-context')
    assert.ok(booked > 0)
    assert.ok(
      booked < toolContext.length,
      `truncated block must book its shortened length, got ${booked} of ${toolContext.length}`,
    )
  })
})

describe('appendix ledger: reset alignment', () => {
  it('resetAppendixBaseline fires the registered CVM reset', () => {
    const engine = createEngine()
    const monitor = new PressureMonitor(CONTEXT_WINDOW)
    engine.setOnResetAppendixBaseline(() => { monitor.resetCvmOverhead() })

    monitor.recordCvmInjection(20_000, 'projection')
    assert.ok(monitor.getCvmOverheadRatio() > 0)

    engine.resetAppendixBaseline()
    assert.equal(monitor.getCvmOverheadRatio(), 0)
    assert.deepEqual(monitor.getCvmInjectionBySource(), {})
  })

  it('drops pending un-drained bytes on reset — they left the context too', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>about to be compacted away</cognitive-mirror>')
    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)

    engine.resetAppendixBaseline()
    assert.deepEqual(engine.drainAppendixLedger(), [])
  })

  it('re-charges the full baseline after a reset', () => {
    const engine = createEngine()
    const projection = '<cognitive-mirror>re-enters after compaction</cognitive-mirror>'
    engine.setCognitiveProjection(projection)

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    engine.drainAppendixLedger()

    engine.resetAppendixBaseline()
    engine.buildOaiRequest(userTurn('second'), undefined, CONTEXT_WINDOW)
    assert.equal(
      charged(engine.drainAppendixLedger(), 'projection'),
      projection.length,
      're-sent baseline bytes are a real cost and must be booked',
    )
  })
})
