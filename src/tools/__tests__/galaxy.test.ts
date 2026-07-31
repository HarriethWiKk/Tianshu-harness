import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGalaxyTool, type GalaxyCoordinator } from '../galaxy.js'
import { deriveStableWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../../agent/coordinator.js'

function makeRun(requests: DelegationRequest[]): CoordinatorRun {
  return {
    status: 'completed',
    results: requests.map(r => ({
      workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
      status: 'passed',
      summary: 'Worker completed.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    })),
    packet: '<worker_results>packet</worker_results>',
  }
}

function capturingCoordinator(calls: Array<{ requests: DelegationRequest[] }>): GalaxyCoordinator {
  return {
    delegateBatch: async (requests) => {
      calls.push({ requests })
      return makeRun(requests)
    },
  }
}

describe('GALAXY_TOOL', () => {
  it('DP 副本跨维度不撞 work order ID（B2 回归）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_dp',
      cwd: '/repo',
      input: {
        objective: '两个 DP 维度各两个只读副本',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'research', objective: '独立调研同一问题', authority: 'tianxuan', parallelism: 'data', replicas: 2 },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const ids = calls[0]!.requests.map(r => deriveStableWorkOrderId(r.parentTurnId ?? ''))
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4, `work order IDs must be unique, got: ${ids.join(', ')}`)
  })

  it('只读单 authority 维度不追加写工 TDD 要求（W4）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_ro',
      cwd: '/repo',
      input: {
        objective: '一个写工维度 + 一个只读维度',
        dimensions: [
          { name: 'frontend', objective: '实现 UI 组件', authority: 'wenqu' },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const writer = reqs.find(r => r.profile === 'patcher')!
    const reader = reqs.find(r => r.profile === 'code_scout')!
    assert.ok(writer.objective.includes('工业级交付要求'), 'write-capable worker should get TDD requirements')
    assert.ok(!reader.objective.includes('工业级交付要求'), 'read-only worker must not get TDD requirements')
    assert.ok(reader.objective.includes('只读分析'), 'read-only worker should get read-only instructions')
  })

  it('外层超时按有效 profile 与 autoReview 波次放宽（W2）', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun([]) })
    const execDims = [
      { name: 'frontend', objective: '实现 UI', authority: 'wenqu' },
      { name: 'backend', objective: '实现逻辑', authority: 'tianji' },
    ]

    const withReview = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: true } } as any)
    const withoutReview = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: false } } as any)
    assert.ok(withReview! > withoutReview!, `autoReview wave must widen the budget (${withReview} vs ${withoutReview})`)

    // profile 省略时执行侧会落到 patcher（写工，续跑轮次更多）——外层不能按只读算
    const readOnlyDims = execDims.map(d => ({ ...d, profile: 'code_scout' }))
    const writeBudget = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: false } } as any)
    const readBudget = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: readOnlyDims, autoReview: false } } as any)
    assert.ok(writeBudget! > readBudget!, `effective write profile must widen the budget (${writeBudget} vs ${readBudget})`)
  })

  it('报告展示聚合缓存用量与 DP per-replica cacheRead（P0-2）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        status: 'completed',
        results: requests.map((r, i) => ({
          workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
          status: 'passed' as const,
          summary: 'Worker completed.',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: (i + 1) * 100 },
        })),
        packet: '',
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_usage',
      cwd: '/repo',
      input: {
        objective: 'DP 用量展示',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(result.content.includes('缓存用量'), '报告必须含聚合缓存用量行')
    assert.ok(result.content.includes('input Σ3000'), `聚合 input 应求和，got:\n${result.content}`)
    assert.ok(result.content.includes('cacheRead Σ600'), `聚合 cacheRead 应求和，got:\n${result.content}`)
    assert.ok(result.content.includes('replica cacheRead: 100 / 200'), `DP 组必须含 per-replica cacheRead 行，got:\n${result.content}`)
  })

  it('终态事件与批次进度经 onWorkerActivity/onOutput 上行（P1-2）', async () => {
    const terminalEvents: Array<{ workOrderId?: string; status?: string }> = []
    const outputs: string[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, _policy, _signal, onProgress, onWorkerSettled) => {
        const run = makeRun(requests)
        for (const r of run.results) onWorkerSettled?.(r)
        onProgress?.(run.results.length, requests.length)
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_stream',
      cwd: '/repo',
      input: {
        objective: '终态事件上行',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authority: 'wenqu' },
          { name: 'backend', objective: '实现逻辑', authority: 'tianji' },
        ],
        autoReview: false,
        confirm: true,
      },
      onWorkerActivity: (ev: any) => { if (ev.status) terminalEvents.push(ev) },
      onOutput: (text: string) => outputs.push(text),
    } as any)

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(terminalEvents.length, 2, '每个 worker 落定必须发一条终态事件')
    assert.ok(terminalEvents.every(e => e.status === 'passed'))
    assert.ok(outputs.some(t => t.includes('galaxy progress: 2/2')), `批次进度必须走 onOutput，got: ${outputs.join('')}`)
  })

  it('未核验发现触发核验护栏行（P1-2）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        run.results[0]!.findings.push({ claim: '疑似空指针', evidence: ['src/a.ts:12'] } as any)
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_guard',
      cwd: '/repo',
      input: {
        objective: '护栏行',
        dimensions: [
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
          { name: 'research', objective: '调研方案', authority: 'tianxuan' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(result.content.includes('待核验假设'), `有未核验发现时必须出现护栏行，got:\n${result.content}`)
  })

  it('文件重叠：只读维度不去重、可写维度剥离且显式进报告（P2-1）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_overlap',
      cwd: '/repo',
      input: {
        objective: '两个写工维度文件重叠 + 一个只读维度同文件',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authority: 'wenqu', files: ['src/a.ts', 'src/b.ts'] },
          { name: 'backend', objective: '实现逻辑', authority: 'tianji', files: ['src/a.ts', 'src/c.ts'] },
          { name: 'search', objective: '只读检索同一文件', authority: 'tianxuan', profile: 'code_scout', files: ['src/a.ts'] },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const byProfile = (p: string) => reqs.filter(r => r.profile === p)
    const frontend = byProfile('patcher').find(r => r.authority === 'wenqu')!
    const backend = byProfile('patcher').find(r => r.authority === 'tianji')!
    const reader = byProfile('code_scout')[0]!
    assert.deepEqual(frontend.scope?.files, ['src/a.ts', 'src/b.ts'], '首个可写维度保留全部文件')
    assert.deepEqual(backend.scope?.files, ['src/c.ts'], '后写维度被剥离重叠文件')
    assert.deepEqual(reader.scope?.files, ['src/a.ts'], '只读维度不参与去重')
    assert.ok(result.content.includes('文件重叠已剥离'), `剥离清单必须进报告，got:\n${result.content}`)
    assert.ok(result.content.includes('src/a.ts'), '被剥离文件必须可见')
  })

  it('tierFloor 透传到 DelegationRequest（P2-2）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_floor',
      cwd: '/repo',
      input: {
        objective: '护栏席位声明 strong 档',
        dimensions: [
          { name: 'review', objective: '审查改动', authority: 'yaoguang', tierFloor: 'strong' },
          { name: 'search', objective: '检索代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const review = calls[0]!.requests.find(r => r.tierFloor === 'strong')
    assert.ok(review, 'tierFloor 必须透传到 request')
  })

  it('modelOverride 与实际模型不一致时报告标注回退（P2-3）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        ...makeRun(requests),
        workerModels: requests.map(r => ({
          workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
          model: 'actual-cheap-model',
        })),
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_fb',
      cwd: '/repo',
      input: {
        objective: '回退可见性',
        dimensions: [
          { name: 'review', objective: '强模型审查', authority: 'yaoguang', modelOverride: { provider: 'deepseek', model: 'requested-strong-model' } },
          { name: 'search', objective: '检索代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(
      result.content.includes('模型回退：请求 requested-strong-model → 实际 actual-cheap-model'),
      `静默回退必须进报告，got:\n${result.content}`,
    )
  })
})
