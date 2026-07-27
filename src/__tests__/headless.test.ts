import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCliArgs, runHeadless } from '../headless.js'
import { GoalTracker, buildGoalModePrompt } from '../agent/goal-tracker.js'
import type { AgentCallbacks } from '../agent/loop-types.js'

describe('headless CLI parsing', () => {
  it('recognizes -p prompt input', () => {
    assert.deepEqual(parseCliArgs(['-p', 'echo hello']), { headless: true, prompt: 'echo hello', json: false, streamJson: false })
  })

  it('recognizes --print prompt input with --json', () => {
    assert.deepEqual(parseCliArgs(['--print', 'summarize', '--json']), { headless: true, prompt: 'summarize', json: true, streamJson: false })
  })

  it('leaves interactive args alone', () => {
    assert.deepEqual(parseCliArgs([]), { headless: false, json: false, streamJson: false })
  })

  it('recognizes --goal with --budget', () => {
    assert.deepEqual(
      parseCliArgs(['--goal', 'make tests pass', '--budget', '20']),
      { headless: true, prompt: undefined, json: false, streamJson: false, goal: 'make tests pass', budget: 20 },
    )
  })

  it('--goal defaults budget to 100', () => {
    const result = parseCliArgs(['--goal', 'fix lint'])
    assert.equal(result.goal, 'fix lint')
    assert.equal(result.budget, 100)
    assert.equal(result.headless, true)
  })
})

describe('runHeadless', () => {
  it('returns stdout-friendly text output', async () => {
    const result = await runHeadless({
      prompt: 'hello',
      json: false,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Hello')
          callbacks.onTextDelta(' world')
          callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 3 }, 1)
        },
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'Hello world')
    assert.equal(result.json, undefined)
  })

  it('returns structured JSON output in json mode', async () => {
    const result = await runHeadless({
      prompt: 'hello',
      json: true,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Done')
          callbacks.onTurnComplete({ input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 }, 1)
        },
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, JSON.stringify(result.json))
    assert.deepEqual(result.json, {
      success: true,
      text: 'Done',
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 },
    })
  })

  it('returns structured error output when the agent fails', async () => {
    const result = await runHeadless({
      prompt: 'fail',
      json: true,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onError(new Error('boom'))
        },
      }),
    })

    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.json, { success: false, text: '', error: 'boom' })
  })
})

// Headless --goal reuses the same AgentLoop + GoalTracker as the TUI /goal
// command: createAgent attaches a GoalTracker, the continuation loop runs inside
// agent.run() (TurnOrchestrator), and main.ts reads tracker.isGoalAchieved()
// afterwards to derive the exit code. These tests pin that wiring contract
// without needing a live provider.
describe('runHeadless goal-mode wiring', () => {
  it('passes the goal-mode prompt verbatim and surfaces achievement via the tracker', async () => {
    let tracker: GoalTracker | null = null
    await runHeadless({
      prompt: buildGoalModePrompt('finish the task'),
      json: false,
      streamJson: false,
      createAgent: () => {
        tracker = new GoalTracker({ goal: 'finish the task', maxIterations: 5, contextWindow: 1000 })
        return {
          run: async (prompt: string, callbacks: AgentCallbacks) => {
            assert.ok(prompt.includes('finish the task'))
            assert.ok(prompt.includes('GOAL ACHIEVED'))
            callbacks.onTextDelta('working...')
            // The TurnOrchestrator deactivates with 'achieved' when it detects
            // the completion marker; emulate that terminal transition here.
            tracker!.deactivate('achieved')
            callbacks.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1)
          },
        }
      },
    })
    // main.ts maps this to exit code 0.
    assert.equal((tracker as GoalTracker | null)?.isGoalAchieved(), true)
  })

  it('reports not-achieved when the budget is exhausted (maps to exit 1)', async () => {
    let tracker: GoalTracker | null = null
    await runHeadless({
      prompt: buildGoalModePrompt('unreachable goal'),
      json: false,
      streamJson: false,
      createAgent: () => {
        tracker = new GoalTracker({ goal: 'unreachable goal', maxIterations: 1, contextWindow: 1000 })
        return {
          run: async (_prompt: string, callbacks: AgentCallbacks) => {
            callbacks.onTextDelta('still working, not done')
            tracker!.deactivate('budget_exhausted')
            callbacks.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1)
          },
        }
      },
    })
    assert.equal((tracker as GoalTracker | null)?.isGoalAchieved(), false)
  })

  it('stream-json: emits system init, forwards worker events, and closes with result', async () => {
    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true }
    try {
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: true,
        sessionId: 's-test',
        model: 'deepseek-v4',
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onToolUse('t1', 'read_file', { path: 'a.ts' })
            cb.onToolResult('t1', 'read_file', 'file body', false)
            cb.onDelegationActivity?.({ workOrderId: 'wo1', parentToolId: 't1', status: 'running', profile: 'code_scout', toolUseCount: 1 })
            cb.onTextDelta('answer')
            cb.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1, true)
          },
        }),
      })
    } finally {
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
    }
    const events = lines.join('').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.equal(events[0]!.type, 'system')
    assert.equal(events[0]!.subtype, 'init')
    assert.equal(events[0]!.session_id, 's-test')
    assert.ok(events.some(e => e.type === 'tool_use' && e.id === 't1'))
    assert.ok(events.some(e => e.type === 'worker' && e.work_order_id === 'wo1'))
    const last = events[events.length - 1]!
    assert.equal(last.type, 'result')
    assert.equal(last.is_error, false)
    assert.equal(last.result, 'answer')
  })
})

  it('stream-json: 密钥模式全链路脱敏（tool_use/tool_result/text/result）', async () => {
    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true }
    try {
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: true,
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onToolUse('t1', 'bash', { command: 'curl -H "Authorization: Bearer sk-live-abc123" x', api_key: 'sk-in-field' })
            cb.onToolResult('t1', 'bash', 'token=sk-secret-xyz', false)
            cb.onTextDelta('got Authorization: Bearer sk-ant-def456 back')
            cb.onTurnComplete({ input_tokens: 1 }, 1, true)
          },
        }),
      })
    } finally {
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
    }
    const out = lines.join('')
    assert.ok(!out.includes('sk-live-abc123'), 'tool_use 不得泄钥')
    assert.ok(!out.includes('sk-in-field'), 'tool_use 敏感字段不得泄钥')
    assert.ok(!out.includes('sk-secret-xyz'), 'tool_result 不得泄钥')
    assert.ok(!out.includes('sk-ant-def456'), 'text_delta/result 不得泄钥')
    // result 信封仍是最后一行（脱敏不得改变协议形状）
    const events = out.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.equal(events[events.length - 1]!.type, 'result')
  })

  it('stream-json: 不返回遗留 payload（终止态只由 result 信封承载）', async () => {
    const streamResult = await runHeadless({
      prompt: 'hi',
      json: false,
      streamJson: true,
      createAgent: () => ({ run: async () => {} }),
    })
    assert.equal(streamResult.json, undefined, 'streamJson 下遗留 payload 必须缺省——同流双 schema 收尾')
    assert.equal(streamResult.stdout, '')

    const jsonResult = await runHeadless({
      prompt: 'hi',
      json: true,
      streamJson: false,
      createAgent: () => ({ run: async () => {} }),
    })
    assert.ok(jsonResult.json, '--json 模式 payload 不受影响')
  })
