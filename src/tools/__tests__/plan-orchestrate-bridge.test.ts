import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeamOrchestrateTool } from '../team-orchestrate.js'
import { createPlanTaskTool } from '../plan-task.js'
import type { CoordinatorRun, DelegationCoordinator, DelegationRequest } from '../../agent/coordinator.js'
import type { PlanExecutorDeps } from '../../agent/plan-executor.js'
import { storePlan, consumePlan, getStoredPlan, clearPlan } from '../../agent/plan-store.js'
import { getWaveResults, clearWaveResults } from '../../agent/wave-results-store.js'

type RunResult = CoordinatorRun['results'][number]

function mkResult(over: Partial<RunResult> = {}): RunResult {
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

function run(results: RunResult[] = [], packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results, packet }
}

function twoWavePlan(sessionId: string): string {
  // T2 depends on T1 → grouping yields wave0=[T1], wave1=[T2].
  return JSON.stringify({
    version: 1,
    objective: 'bridge two waves',
    tasks: [
      { id: 'T1', title: 'edit foo', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit bar', objective: 'Modify src/agent/bar.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/bar.ts'], dependsOn: ['T1'], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
}

// ── plan_task writes wave results to the session-scoped store ─────────────

test('plan_task(execute:true) records wave results into the session store', async () => {
  const sessionId = 'bridge-plan-write'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const executorDeps: PlanExecutorDeps = {
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:S1', status: 'passed' })], 'plan-wave0'),
  }
  const tool = createPlanTaskTool({
    getCoordinator: () => ({}) as unknown as DelegationCoordinator,
    getExecutorDeps: () => executorDeps,
    getSessionId: () => sessionId,
  })

  const result = await tool.execute({
    input: { objective: 'refactor the cache module for clarity and add tests', execute: true },
    cwd: process.cwd(),
    toolUseId: 'pt-bridge',
    sessionId,
  })

  assert.notEqual(result.isError, true)
  const stored = getWaveResults(sessionId)
  assert.ok(stored, 'plan_task should write its wave results to the session store')
  assert.equal(stored!.length, 1)
  assert.equal(stored![0]!.workOrderId, 'team:S1')
})

// ── cross-tool bridge: a failed wave-0 result blocks a dependent wave-1 task
//    across SEPARATE tool instances (the old per-instance closure could not). ──

test('wave-0 failure bridges across tool instances to block the dependent wave-1 task', async () => {
  const sessionId = 'bridge-cross-tool'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  // Simulate plan_task's bridge: the serialized plan is in the session store.
  storePlan(twoWavePlan(sessionId), sessionId)

  // Wave 0 (tool instance A): dispatch T1, report it FAILED.
  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' })], 'wave0'),
  })
  const r0 = await toolA.execute({
    input: { mode: 'standard', objective: 'force: bridge wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-bridge-0',
    sessionId,
  })
  assert.equal(r0.isError, false)
  const stored = getWaveResults(sessionId)
  assert.ok(stored && stored.length === 1 && stored[0]!.status === 'failed', 'wave-0 failure should be stored session-scoped')

  // Wave 1 (a DIFFERENT tool instance): auto-consume the plan, read prior results
  // from the store, and block T2 because its dependency T1 failed.
  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: bridge wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-bridge-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), 'T2 must be blocked by the bridged wave-0 failure')
})

// ── Phase D: an explicit planJson clears any stale stored plan ──────────────

test('explicit planJson clears a stale stored plan and is not re-stored', async () => {
  const sessionId = 'bridge-stale-clean'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  // A stale plan left over from a prior run.
  storePlan('STALE-NOT-VALID-JSON', sessionId)

  const explicit = JSON.stringify({
    version: 1,
    objective: 'explicit run',
    tasks: [
      { id: 'T1', title: 'edit foo', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => run([], 'explicit') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: run explicit plan', planJson: explicit },
    cwd: process.cwd(),
    toolUseId: 'tu-stale',
    sessionId,
  })

  assert.equal(result.isError, false)
  // Stale plan dropped; explicit planJson takes priority and is NOT re-stored.
  assert.equal(getStoredPlan(sessionId), null)
})

// ── T5 回归：多任务计划经完整桥接链路不坍缩 ────────────────────────────────
// docs/analysis/2026-07-29-team-mode-e2e-repro-and-gaps.md §四 #5：e2e 实测
// 观察到「7 任务 2 波计划进 team 后坍缩成单任务单波 + files:[]」。归因见
// src/agent/__tests__/plan-collapse-t5.test.ts —— 坍缩发生在 plan 生成侧
// （decomposeObjective 对 files 缺席的退化），桥接与分组链路本身忠实。
// 本测试锁定端到端不回退：storePlan → team_orchestrate 派发层看到全部任务与波次。

test('T5: 7 任务多波 UnifiedPlan 经 storePlan → team_orchestrate 原样到达派发层', async () => {
  const sessionId = 't5-e2e-seven'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const patchers = ['a', 'b', 'c', 'd', 'e', 'f'].map((m, i) => ({
    id: `T${i + 2}`,
    title: `edit module ${m}`,
    objective: `Modify src/mod${m}/impl.ts`,
    profile: 'patcher',
    kind: 'patch_proposal',
    files: [`src/mod${m}/impl.ts`],
    dependsOn: ['T1'],
    riskTier: 'low',
  }))
  storePlan(JSON.stringify({
    version: 1,
    objective: 'seven task multi wave plan',
    tasks: [
      { id: 'T1', title: 'explore', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      ...patchers,
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  }), sessionId)

  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async requests => {
      captured = requests
      return run(requests.map(r => mkResult({ workOrderId: r.parentTurnId, status: 'passed' })), 'wave0')
    },
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: t5 seven task regression', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-t5-seven',
    sessionId,
  })

  assert.equal(result.isError, false)
  // 波次结构完整：scout 先行 + 写工按每波上限 3 分两波 → 3 波，7 任务全部在列。
  assert.match(result.content, /3 waves/)
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
    assert.ok(result.content.includes(id), `任务 ${id} 必须出现在波次结构中`)
  }
  // wave 0 只派 scout（写工依赖它）——派发数不坍缩也不越波。
  assert.equal(captured.length, 1)
  clearPlan(sessionId)
})

test('T5: 编号清单目标（无 files）经 plan_task → team_orchestrate 并行派发多分片', async () => {
  const sessionId = 't5-e2e-numbered'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const planTool = createPlanTaskTool({
    getCoordinator: () => ({}) as unknown as DelegationCoordinator,
    getExecutorDeps: () => ({ delegateBatch: async () => run([], 'unused') }),
    getSessionId: () => sessionId,
    writeTodos: () => {},
  })
  const objective = [
    '在 toolkit2/ 目录下创建零依赖工具库，三个相互独立的模块，纯 ESM（.mjs）。',
    '',
    '1. toolkit2/slug.mjs + toolkit2/slug.test.mjs —— slugify(text)。',
    '2. toolkit2/clamp.mjs + toolkit2/clamp.test.mjs —— clamp 与 lerp。',
    '3. toolkit2/dedent.mjs + toolkit2/dedent.test.mjs —— dedent(text)。',
  ].join('\n')
  const planResult = await planTool.execute({
    input: { objective },
    cwd: process.cwd(),
    toolUseId: 'pt-t5-numbered',
    sessionId,
  })
  assert.notEqual(planResult.isError, true)

  let captured: DelegationRequest[] = []
  const teamTool = createTeamOrchestrateTool({
    delegateBatch: async requests => {
      captured = requests
      return run(requests.map(r => mkResult({ workOrderId: r.parentTurnId, status: 'passed' })), 'wave0')
    },
  })
  const teamResult = await teamTool.execute({
    input: { mode: 'standard', objective: `force: ${objective}`, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-t5-numbered',
    sessionId,
  })

  assert.equal(teamResult.isError, false)
  // 修复前的坍缩形状：1 个 monolith patcher、files:[]。修复后：3 个编号分片
  // 文件互不重叠 → 同一波并行派发 3 个写工。
  assert.equal(captured.length, 3, `wave 0 应并行派发 3 个分片，实际 ${captured.length}`)
  clearPlan(sessionId)
})

// ── Phase D: clear error when standard mode has nothing to run ──────────────

test('team_orchestrate reports a clear error when no plan is provided or stored', async () => {
  const sessionId = 'bridge-no-plan'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const tool = createTeamOrchestrateTool({ delegateBatch: async () => run([], 'nope') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: nothing to orchestrate here at all' },
    cwd: process.cwd(),
    toolUseId: 'tu-noplan',
    sessionId,
  })

  assert.equal(result.isError, true)
  assert.match(result.content, /未提供计划，也未找到已存储的计划/)
})
