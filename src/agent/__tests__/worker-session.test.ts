import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { createReadOnlyWorkOrder } from '../work-order.js'
import {
  runWorkerSession,
  detectApprovalDeadlock,
  buildMaxTurnsExhaustedResult,
  HEADLESS_DENY_MARKER,
  type WorkerTranscript,
} from '../worker-session.js'
import { HEADLESS_DENY_MARKER as PIPELINE_HEADLESS_DENY_MARKER } from '../tool-pipeline.js'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function clientFromTexts(texts: string[]): StreamClient {
  let index = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      const text = texts[Math.min(index, texts.length - 1)]!
      index++
      cb.onTextDelta(text)
      cb.onContentBlock(textBlock(text))
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

function makePromptEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
}

function validPacket(workOrderId: string) {
  return JSON.stringify({
    workOrderId,
    status: 'passed',
    summary: 'Worker found one seam.',
    findings: [{ claim: 'AgentLoop is injectable', evidence: 'src/agent/loop.ts constructor', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: ['Use an independent SessionContext'],
  })
}

describe('runWorkerSession', () => {
  it('runs a headless worker and returns a schema-valid result', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find AgentLoop constructor seams.',
      scope: { files: ['src/agent/loop.ts'] },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_1')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.session.getTurnCount(), 1)
    assert.deepEqual(run.transcript.toolUses, [])
  })

  it('uses an independent SessionContext instead of mutating the primary session', async () => {
    const primary = new SessionContext()
    primary.addUserMessage('primary user message')
    const before = primary.getMessages().length

    const order = createReadOnlyWorkOrder({
      id: 'wo_2',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review isolation.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_2')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(primary.getMessages().length, before)
    assert.ok(run.session.getMessages().length > 0)
  })

  it('recovers without repair when prose contains incidental JSON before the result packet', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_incidental',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find worker result parser seams across coordinator and worker session modules.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const text = `Observed tool input {"pattern":"WorkerResult"}. Final packet:\n${validPacket('wo_incidental')}`
    const run = await runWorkerSession({
      order,
      client: clientFromTexts([text]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 0)
  })

  it('runs one repair prompt after invalid worker JSON', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_3',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan coordinator tests.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const client = clientFromTexts(['not valid json', validPacket('wo_3')])
    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1)
  })

  it('returns blocked after retry budget is exhausted', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_4',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review invalid result handling.',
      scope: {},
      budget: { maxRetries: 0 },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts(['not valid json']),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'blocked')
    assert.ok(run.result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('forceJsonRepair sends response_format on the repair request and recovers', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_json',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan json repair.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    // Capture whether the repair request carried response_format.
    let sawResponseFormat = false
    let repairCallCount = 0
    const client = {
      stream: mock.fn(async (req: { response_format?: unknown }, cb: StreamCallbacks) => {
        // First call: invalid output (no response_format — normal turn via AgentLoop).
        // Second call: json-mode repair (response_format set).
        if (req.response_format) {
          sawResponseFormat = true
          repairCallCount++
          cb.onTextDelta(validPacket('wo_json'))
          cb.onContentBlock(textBlock(validPacket('wo_json')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          return
        }
        // The AgentLoop also issues calls without response_format; only emit
        // invalid text the first time so repair triggers.
        cb.onTextDelta('definitely not json at all')
        cb.onContentBlock(textBlock('definitely not json at all'))
        cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
      }),
    } as unknown as StreamClient

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      forceJsonRepair: true,
    })

    assert.equal(run.result.status, 'passed', 'json-mode repair should recover to passed')
    assert.ok(sawResponseFormat, 'repair request must carry response_format: json_object')
    assert.equal(repairCallCount, 1, 'exactly one json-mode repair call')
  })
})

describe('buildMaxTurnsExhaustedResult (2026-07-24 假 summary 事故)', () => {
  // classifyInfraFailure (review-coordinator-deps.ts) 的 budget 分流正则——
  // blocked summary 必须命中它，否则 review-router 会当瞬时故障重试（同预算必死）。
  const BUDGET_CLASSIFIER_RE = /max.?turns|exhausted without a final turn/i

  function makeOrder(id: string) {
    return createReadOnlyWorkOrder({
      id,
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review the wiring of the plan approval chain.',
      scope: {},
    })
  }

  function exploringTranscript(toolCalls: number): WorkerTranscript {
    return {
      text: '',
      thinking: '',
      toolUses: Array.from({ length: toolCalls }, (_, i) => (i % 2 === 0 ? 'read_file' : 'grep')),
      toolResults: [],
      errors: [],
      repairAttempts: 0,
    }
  }

  it('终轮已产出合法报告 → 返回 null（soft-landing 成功，走正常路径）', () => {
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt1'), exploringTranscript(8), validPacket('wo_mt1'), 12)
    assert.equal(result, null)
  })

  it('纯探索散文 → 结构化 budget blocked，绝不进修复梯', () => {
    const prose = '我需要检查提交的差异。先看 session-manager.ts 的 onToolResult……'
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt2'), exploringTranscript(21), prose, 12)
    assert.ok(result, 'expected a structured result')
    assert.equal(result!.status, 'blocked')
    assert.equal(result!.failureReason, 'max_turns')
    assert.match(result!.summary, /max-turns: exhausted without a final turn/)
    assert.match(result!.summary, /21 tool calls/)
    assert.match(result!.summary, BUDGET_CLASSIFIER_RE)
    // 半成品散文只作为 artifact 留痕，不进 summary（防"缺上下文"假象上桌）
    const note = result!.artifacts.find(a => a.title === 'Max-turns worker partial output')
    assert.ok(note, 'partial output preserved as artifact')
    assert.match(note!.content, /session-manager/)
  })

  it('空输出 → blocked 且不附 partial artifact', () => {
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt3'), exploringTranscript(3), '   ', 12)
    assert.ok(result)
    assert.equal(result!.status, 'blocked')
    assert.equal(result!.failureReason, 'max_turns')
    assert.equal(result!.artifacts.some(a => a.title === 'Max-turns worker partial output'), false)
  })

  it('半成品报告可字段级抢救 → findings 保留 + max_turns 标注（不丢工作成果）', () => {
    // 一个 finding 的 "claim": 键名丢失 → 整体 JSON.parse 失败，但其余 finding 可独立抢救
    const malformed = `{
      "workOrderId": "wo_mt4",
      "status": "passed",
      "summary": "wiring 审查中间产物",
      "findings": [
        { "claim": "plan_submitted 事件断链", "evidence": "src/server/session-manager.ts:2101", "confidence": "high" },
        { 缺键名的坏对象" }
      ],
      "artifacts": [],
      "changedFiles": [],
      "risks": [],
      "nextActions": []
    }`
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt4'), exploringTranscript(15), malformed, 12)
    assert.ok(result)
    assert.equal(result!.failureReason, 'max_turns')
    assert.ok(result!.findings.length >= 1, 'salvaged findings preserved')
    assert.ok(
      result!.risks.some(r => BUDGET_CLASSIFIER_RE.test(r)),
      'budget marker present in risks for classifyInfraFailure routing',
    )
  })
})

describe('detectApprovalDeadlock', () => {
  function transcriptWithErrors(errors: string[]): WorkerTranscript {
    return { text: '', thinking: '', toolUses: [], toolResults: [], errors, repairAttempts: 0 }
  }

  it('drift guard: local marker matches the one tool-pipeline actually emits', () => {
    // worker-session keeps a local copy of the marker to avoid an import cycle;
    // if the two constants drift apart, deadlock detection silently goes blind.
    assert.equal(HEADLESS_DENY_MARKER, PIPELINE_HEADLESS_DENY_MARKER)
  })

  it('returns null when no headless denial appears in the transcript', () => {
    assert.equal(detectApprovalDeadlock(transcriptWithErrors([])), null)
    assert.equal(detectApprovalDeadlock(transcriptWithErrors(['some other tool error'])), null)
  })

  it('names the approval gate when headless denials are present', () => {
    const hint = detectApprovalDeadlock(transcriptWithErrors([
      `Tool "run_migration" is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
      'unrelated error',
      `Tool "run_migration" is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
    ]))
    assert.ok(hint, 'expected a diagnostic hint')
    assert.match(hint!, /2 approval-required tool call/)
    assert.match(hint!, /NOT malformed JSON/)
  })
})
