import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGateBlockGuardHook } from '../hooks/gate-block-guard-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryEntry } from '../advisory-bus.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { turn, cwd: '/proj', recentToolHistory: [] },
    effects: {},
  } as unknown as RuntimeHookContext
}

function setup(kindsByTurn: Record<number, string[]>) {
  const submitted: AdvisoryEntry[] = []
  let currentTurn = 0
  const hook = createGateBlockGuardHook({
    advisoryBus: { submit: s => { submitted.push(s) } },
    drainBlockedKinds: () => kindsByTurn[currentTurn]?.splice(0) ?? [],
  })
  return {
    submitted,
    runTurn(turn: number) {
      currentTurn = turn
      hook.run(makeCtx(turn))
    },
  }
}

describe('gate-block-guard hook', () => {
  it('does not fire with 0 or 1 blocks in a turn', () => {
    const h = setup({ 1: [], 2: ['tdd'] })
    h.runTurn(1)
    h.runTurn(2)
    assert.equal(h.submitted.length, 0)
  })

  it('fires when a single turn has >=2 blocks', () => {
    const h = setup({ 1: ['tdd', 'destructive'] })
    h.runTurn(1)
    assert.equal(h.submitted.length, 1)
    const adv = h.submitted[0]!
    assert.equal(adv.key, 'gate-block-guard')
    assert.equal(adv.category, 'discipline')
    assert.ok(adv.content.includes('tdd/destructive'), 'content should name the gate kinds')
    assert.ok(adv.content.includes('替代路径'))
    assert.deepEqual(adv.expect, { kind: 'tool_appears', tools: ['read_file', 'grep', 'glob', 'list_dir', 'run_tests'], withinTurns: 2 })
  })

  it('applies per-key cooldown: consecutive blocked turns do not spam', () => {
    const h = setup({
      1: ['destructive', 'destructive'],
      2: ['destructive', 'destructive'],
      3: ['destructive', 'destructive'],
      4: ['destructive', 'destructive'],
    })
    h.runTurn(1) // fires
    h.runTurn(2) // cooldown (2-1 < 3)
    h.runTurn(3) // cooldown (3-1 < 3)
    h.runTurn(4) // cooldown elapsed (4-1 >= 3) → fires again
    assert.equal(h.submitted.length, 2)
  })

  it('drains the counter even during cooldown (no cross-turn accumulation)', () => {
    const kinds: Record<number, string[]> = {
      1: ['tdd', 'deny'],
      2: ['plan-mode'], // 1 block during cooldown — drained, must not stack with turn 3
      3: ['reliability'], // 1 block — even if turn 2's leaked, this stays below threshold
    }
    const h = setup(kinds)
    h.runTurn(1)
    h.runTurn(2)
    h.runTurn(3)
    assert.equal(h.submitted.length, 1, 'single blocks must not accumulate across turns')
    assert.equal(kinds[2]!.length, 0, 'turn 2 kinds must be drained')
  })

  it('dedupes kind names in the advisory content', () => {
    const h = setup({ 1: ['deny', 'deny', 'deny'] })
    h.runTurn(1)
    assert.equal(h.submitted.length, 1)
    assert.ok(h.submitted[0]!.content.includes('3 次'))
    assert.ok(h.submitted[0]!.content.includes('（deny）'))
  })

  // 2026-07-25 桌面「退不出」复盘：plan-mode 被拦占多数时必须点名真退出通道
  // （submit 审批 / exit_mode 放弃规划），通用文案不提，模型会口头宣布退出。
  it('uses plan-mode-tailored content when plan-mode blocks dominate', () => {
    const h = setup({ 1: ['plan-mode', 'plan-mode'] })
    h.runTurn(1)
    assert.equal(h.submitted.length, 1)
    const adv = h.submitted[0]!
    assert.ok(adv.content.includes('plan action=exit_mode'), 'should name the exit tool')
    assert.ok(adv.content.includes('plan action=submit'), 'should name submit')
    assert.ok(adv.content.includes('只认工具调用'), 'should warn text-claims do not exit')
    assert.deepEqual(adv.expect, { kind: 'tool_appears', tools: ['plan'], withinTurns: 2 })
  })

  it('keeps generic content when plan-mode is a minority of blocks', () => {
    const h = setup({ 1: ['plan-mode', 'tdd', 'destructive'] })
    h.runTurn(1)
    assert.equal(h.submitted.length, 1)
    assert.ok(h.submitted[0]!.content.includes('替代路径'))
    assert.ok(!h.submitted[0]!.content.includes('exit_mode'))
  })
})
