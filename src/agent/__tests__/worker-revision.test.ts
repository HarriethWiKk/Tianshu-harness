import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EVIDENCE_REVISIONS,
  buildRevisionObjective,
  decideRevision,
  detectEvidenceShortfall,
  markRevised,
  type RevisionInput,
} from '../worker-revision.js'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'passed',
    summary: '扫了一遍路由层，定位到三处接缝',
    findings: [{ claim: '接缝在 overlay.ts', evidence: 'overlay.ts:733', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...over,
  }
}

function transcript(over: Partial<WorkerTranscript> = {}): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses: ['grep', 'read_file'],
    toolResults: [],
    errors: [],
    repairAttempts: 0,
    bashCommands: [],
    failedBashCommands: [],
    ...over,
  }
}

describe('detectEvidenceShortfall', () => {
  it('宣称 verified 但没有验证执行痕迹 → 打回', () => {
    const shortfall = detectEvidenceShortfall(result({ evidenceStatus: 'verified' }), 'code_scout', transcript())
    assert.equal(shortfall, 'claimed_verified_downgraded')
  })

  it('summary 里有验证宣称但没有执行痕迹 → 打回', () => {
    const shortfall = detectEvidenceShortfall(result({ summary: '改完了，typecheck 干净，所有测试通过' }), 'code_scout', transcript())
    assert.equal(shortfall, 'unproven_claim_in_summary')
  })

  it('宣称有真实执行痕迹撑着 → 不打回', () => {
    const proven = transcript({ toolUses: ['run_tests'] })
    assert.equal(detectEvidenceShortfall(result({ summary: '所有测试通过' }), 'code_scout', proven), undefined)
  })

  it('没有宣称就没有缺口', () => {
    assert.equal(detectEvidenceShortfall(result(), 'code_scout', transcript()), undefined)
  })

  it('没有 transcript 时不打回——无取证依据，闸门那边也不会因此降级', () => {
    assert.equal(detectEvidenceShortfall(result({ evidenceStatus: 'verified' }), 'code_scout', undefined), undefined)
  })
})

describe('decideRevision', () => {
  function input(over: Partial<RevisionInput> = {}): RevisionInput {
    return {
      result: result(),
      shortfall: 'claimed_verified_downgraded',
      attempt: 0,
      aborted: false,
      isWrite: false,
      hasSessionMessages: true,
      ...over,
    }
  }

  it('只读工证据不达标时打回一轮', () => {
    const decision = decideRevision(input())
    assert.equal(decision.proceed, true)
    if (decision.proceed) assert.equal(decision.shortfall, 'claimed_verified_downgraded')
  })

  it('没有缺口 / 已中止 / 没有会话消息都不打回', () => {
    assert.equal(decideRevision(input({ shortfall: undefined })).proceed, false)
    assert.equal(decideRevision(input({ aborted: true })).proceed, false)
    assert.equal(decideRevision(input({ hasSessionMessages: false })).proceed, false)
  })

  it('写工不走这条路——它有写闸门的有界修复', () => {
    const decision = decideRevision(input({ isWrite: true }))
    assert.equal(decision.proceed, false)
    if (!decision.proceed) assert.match(decision.skipReason, /写闸门/)
  })

  it('上限一轮，之后照常降级交回', () => {
    const decision = decideRevision(input({ attempt: MAX_EVIDENCE_REVISIONS }))
    assert.equal(decision.proceed, false)
    if (!decision.proceed) assert.match(decision.skipReason, /上限/)
  })
})

describe('buildRevisionObjective', () => {
  it('给出二选一：复现或撤回，并要求保住既有 findings', () => {
    const text = buildRevisionObjective('定位路由接缝', 'claimed_verified_downgraded', '全绿')
    assert.match(text, /二选一/)
    assert.match(text, /run_tests/)
    assert.match(text, /unverified/)
    assert.match(text, /不要删掉上一轮已经查到的 findings/)
    assert.match(text, /定位路由接缝/)
  })

  it('两种缺口的诊断措辞不同', () => {
    const a = buildRevisionObjective('x', 'claimed_verified_downgraded', 'y')
    const b = buildRevisionObjective('x', 'unproven_claim_in_summary', 'y')
    assert.match(a, /evidenceStatus 报成了 verified/)
    assert.match(b, /summary 里有验证结论/)
  })
})

describe('markRevised', () => {
  it('留痕与续跑分开，且幂等', () => {
    const once = markRevised(result(), 'claimed_verified_downgraded')
    assert.match(once.risks[0]!, /evidence-revision/)
    assert.doesNotMatch(once.risks[0]!, /budget-continuation/)
    assert.equal(markRevised(once, 'claimed_verified_downgraded').risks.length, 1)
  })
})
