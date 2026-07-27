import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateBatchTool, progressiveTaskCap } from '../tools/delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { profileRegistry } from '../agent/profile-registry.js'
import { WORKER_EXIT_GRACE_MS } from '../agent/timeout-ladder.js'
import { MAX_BUDGET_CONTINUATIONS } from '../agent/worker-continuation.js'
import type { ClaimProposal } from '../context/claims.js'

function makeFiveTasks(): Array<{ objective: string; kind: string; profile: string }> {
  return [
    { objective: 'search for auth patterns in src/agent', kind: 'code_search', profile: 'code_scout' },
    { objective: 'review error handling in src/tools', kind: 'review', profile: 'reviewer' },
    { objective: 'find test coverage gaps', kind: 'code_search', profile: 'code_scout' },
    { objective: 'plan API refactor approach', kind: 'plan', profile: 'planner' },
    { objective: 'verify import graph integrity', kind: 'verify', profile: 'verifier' },
  ]
}

describe('delegate_batch tool', () => {
  it('exposes profile schema from the profile registry', () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
    const tasksSchema = tool.definition.input_schema!.properties.tasks as {
      items: { properties: { profile: { enum: string[] } } }
    }
    const profileEnum = tasksSchema.items.properties.profile.enum

    assert.deepEqual(profileEnum, profileRegistry.getProfileNames())
    assert.ok(profileEnum.includes('adversarial_verifier'))
    assert.ok(profileEnum.includes('architect'))
    assert.ok(profileEnum.includes('troubleshooter'))
  })

  it('delegates multiple tasks and returns combined packet', async () => {
    let batchCaptured: DelegationRequest[] = []
    const tool = createDelegateBatchTool({
      delegateBatch: async (requests) => {
        batchCaptured = requests
        return {
          status: 'completed' as const,
          results: requests.map((_, i) => ({
            workOrderId: `wo-${i}`,
            status: 'passed' as const,
            summary: `Task ${i} done`,
            findings: [{ claim: `finding-${i}`, evidence: 'test output', confidence: 'high' as const }],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
          })),
          packet: '<worker_results>batch done</worker_results>',
        } as CoordinatorRun
      },
    })

    const result = await tool.execute({
      toolUseId: 'tu-batch-1',
      cwd: '/tmp',
      input: {
        tasks: [
          { objective: 'search for auth patterns in src/agent', kind: 'code_search' },
          { objective: 'review error handling in src/tools', kind: 'review', profile: 'reviewer' },
        ],
      },
    })

    assert.equal(batchCaptured.length, 2)
    assert.equal(batchCaptured[0]!.kind, 'code_search')
    assert.equal(batchCaptured[1]!.kind, 'review')
    assert.equal(result.isError, false)
  })

  it('uses unique claim and evidence ids for batch findings', async () => {
    const proposals: ClaimProposal[] = []
    const tool = createDelegateBatchTool(
      {
        delegateBatch: async () => ({
          status: 'completed' as const,
          results: [0, 1].map(i => ({
            workOrderId: `wo-${i}`,
            status: 'passed' as const,
            summary: `Task ${i} done`,
            findings: [
              { claim: `finding-${i}-a`, evidence: 'test output a', confidence: 'high' as const },
              { claim: `finding-${i}-b`, evidence: 'test output b', confidence: 'medium' as const },
            ],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
          })),
          packet: '<worker_results>batch done</worker_results>',
        } as CoordinatorRun),
      },
      () => ({ propose: (proposal: ClaimProposal) => { proposals.push(proposal); return {} as never } }) as never,
      () => 'session-test',
    )

    await tool.execute({
      toolUseId: 'tu-batch-claims',
      cwd: '/tmp',
      input: {
        tasks: [
          { objective: 'search for auth patterns in src/agent', kind: 'code_search' },
          { objective: 'review error handling in src/tools', kind: 'review', profile: 'reviewer' },
        ],
      },
    })

    assert.equal(proposals.length, 4)
    assert.equal(new Set(proposals.map(p => p.source.eventId)).size, 4)
    assert.equal(new Set(proposals.map(p => p.evidence[0]!.id)).size, 4)
  })

  it('returns actionable error when coordinator throws (timeout/crash)', async () => {
    const tool = createDelegateBatchTool({
      delegateBatch: async () => {
        throw new Error('Tool delegate_batch timed out after 180s')
      },
    })

    const result = await tool.execute({
      toolUseId: 'tu-timeout',
      cwd: '/tmp',
      sessionTurnCount: 5,
      input: {
        tasks: [{ objective: 'search for patterns', kind: 'code_search' }],
      },
    })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('delegate_batch 失败'))
    assert.ok(result.content.includes('不要用相同参数重试'))
    assert.ok(result.content.includes('恢复选项'))
    assert.ok(result.content.includes('内联工具'))
  })

  describe('progressive timeout', () => {
    const base = { input: {}, toolUseId: 'tu', cwd: '/tmp' }
    const GRACE = WORKER_EXIT_GRACE_MS
    // 预算耗尽自动续跑，每一轮都是一次带完整 budget 的 runWorker——外层必须覆盖
    // 最坏运行次数，否则续跑撞上工具层硬 reject，连首轮 partial 都一起丢。
    const RUNS = 1 + MAX_BUDGET_CONTINUATIONS

    it('returns 120s × runs + grace for turn 0-1 (cold open)', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 0 }), 120_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 1 }), 120_000 * RUNS + GRACE)
    })

    it('returns 240s × runs + grace for turn 2-4 (warming)', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 2 }), 240_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 4 }), 240_000 * RUNS + GRACE)
    })

    it('returns 480s × runs + grace for turn 5+ (mature)', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 5 }), 480_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 20 }), 480_000 * RUNS + GRACE)
    })

    it('tiers are monotonically increasing', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      const cold = tool.timeoutMs?.({ ...base, sessionTurnCount: 0 })!
      const warming = tool.timeoutMs?.({ ...base, sessionTurnCount: 3 })!
      const mature = tool.timeoutMs?.({ ...base, sessionTurnCount: 10 })!
      assert.ok(cold < warming)
      assert.ok(warming < mature)
    })

    it('defaults to mature when sessionTurnCount is undefined', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results: [], packet: '' }) as CoordinatorRun })
      assert.equal(tool.timeoutMs?.(base), 480_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.(), 480_000 * RUNS + GRACE)
    })
  })

  describe('progressive task cap', () => {
    it('limits to 1 task on turn 0-1 (cold open)', async () => {
      let dispatchedCount = -1
      const tool = createDelegateBatchTool({
        delegateBatch: async (reqs) => {
          dispatchedCount = reqs.length
          return {
            status: 'completed' as const,
            results: reqs.map((_, i) => ({
              workOrderId: `wo-${i}`, status: 'passed' as const, summary: 'ok',
              findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [],
              evidenceStatus: 'verified' as const,
            })),
            packet: '<results/>',
          } as CoordinatorRun
        },
      })

      const result = await tool.execute({
        toolUseId: 'tu-cap-0',
        cwd: '/tmp',
        sessionTurnCount: 0,
        input: { tasks: makeFiveTasks() },
      })

      assert.equal(dispatchedCount, 1)
      assert.ok(result.content.includes('[批次已裁剪]'))
      assert.ok(result.content.includes('已派发 1/5'))
    })

    it('limits to 3 tasks on turn 2-4 (warming)', async () => {
      let dispatchedCount = -1
      const tool = createDelegateBatchTool({
        delegateBatch: async (reqs) => {
          dispatchedCount = reqs.length
          return {
            status: 'completed' as const,
            results: reqs.map((_, i) => ({
              workOrderId: `wo-${i}`, status: 'passed' as const, summary: 'ok',
              findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [],
              evidenceStatus: 'verified' as const,
            })),
            packet: '<results/>',
          } as CoordinatorRun
        },
      })

      await tool.execute({
        toolUseId: 'tu-cap-3',
        cwd: '/tmp',
        sessionTurnCount: 3,
        input: { tasks: makeFiveTasks() },
      })

      assert.equal(dispatchedCount, 3)
    })

    it('dispatches all 5 tasks on turn 5+ (mature)', async () => {
      let dispatchedCount = -1
      const tool = createDelegateBatchTool({
        delegateBatch: async (reqs) => {
          dispatchedCount = reqs.length
          return {
            status: 'completed' as const,
            results: reqs.map((_, i) => ({
              workOrderId: `wo-${i}`, status: 'passed' as const, summary: 'ok',
              findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [],
              evidenceStatus: 'verified' as const,
            })),
            packet: '<results/>',
          } as CoordinatorRun
        },
      })

      const result = await tool.execute({
        toolUseId: 'tu-cap-5',
        cwd: '/tmp',
        sessionTurnCount: 6,
        input: { tasks: makeFiveTasks() },
      })

      assert.equal(dispatchedCount, 5)
      assert.ok(!result.content.includes('[批次已裁剪]'))
    })

    it('progressiveTaskCap unit: 1→3→5 by turn tier', () => {
      assert.equal(progressiveTaskCap(0), 1)
      assert.equal(progressiveTaskCap(1), 1)
      assert.equal(progressiveTaskCap(2), 3)
      assert.equal(progressiveTaskCap(4), 3)
      assert.equal(progressiveTaskCap(5), 5)
      assert.equal(progressiveTaskCap(100), 5)
      assert.equal(progressiveTaskCap(), 5) // undefined → mature
    })
  })
})
