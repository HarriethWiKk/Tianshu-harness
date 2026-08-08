import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentArgs, harvestSessionData, summarizeStreamJson } from '../executor.js'

describe('summarizeStreamJson', () => {
  it('collects agent turns, tool calls, cache rate, and cost from headless events', () => {
    const summary = summarizeStreamJson([
      JSON.stringify({ type: 'tool_use', id: 'a', name: 'read_file' }),
      JSON.stringify({ type: 'tool_use', id: 'b', name: 'grep' }),
      JSON.stringify({ type: 'turn_complete', turn: 1, usage: { inputTokens: 100, cacheReadInputTokens: 60, costUsd: 0.02 } }),
      JSON.stringify({ type: 'result', is_error: false }),
    ].join('\n'))

    assert.deepEqual(summary.metrics, {
      turns: 1,
      toolCalls: 2,
      retries: 0,
      cacheHitRate: 0.6,
      costUsd: 0.02,
    })
  })

  it('keeps parsing metrics when diagnostics add non-JSON lines', () => {
    const summary = summarizeStreamJson('provider warning\n' + JSON.stringify({ type: 'error', error: 'network unavailable' }))
    assert.equal(summary.metrics.turns, 0)
    assert.equal(summary.resultError, 'network unavailable')
  })
})

describe('buildAgentArgs（测量回路 Phase 1：provider/model 真透传）', () => {
  it('pins --provider/--model into the spawn args', () => {
    const args = buildAgentArgs('dist/main.js', 'do the task', {
      provider: 'deepseek-spark',
      model: 'deepseek-v4-flash',
      allowWriteTools: true,
    })
    assert.deepEqual(args, [
      'dist/main.js', '--print', 'do the task', '--stream-json',
      '--provider', 'deepseek-spark', '--model', 'deepseek-v4-flash',
      '--dangerously-skip-permissions',
    ])
  })

  it('omits the flags when unpinned（回退 workspace 默认，与旧行为一致）', () => {
    assert.deepEqual(
      buildAgentArgs('dist/main.js', 'p', {}),
      ['dist/main.js', '--print', 'p', '--stream-json'],
    )
  })
})

describe('harvestSessionData（会话遥测回收）', () => {
  it('reads speculationStats + provider-dimension cache rows from a flat session dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-harvest-'))
    try {
      // 主会话 meta（含观察态统计）+ 一个 worker meta（必须被过滤）
      writeFileSync(join(dir, 'sess-1.meta.json'), JSON.stringify({
        sessionId: 'sess-1',
        model: 'deepseek-v4-flash',
        updatedAt: 2000,
        speculationStats: {
          'tool-pattern': { enqueued: 10, hits: 4 },
          llm: { enqueued: 3, hits: 2 },
        },
        llmSpeculationEngine: { fired: 3, enqueued: 3, parseFailures: 0, errors: 0 },
      }))
      writeFileSync(join(dir, 'worker-batch-0-abc.meta.json'), JSON.stringify({
        sessionId: 'worker-batch-0-abc', updatedAt: 9999,
      }))
      mkdirSync(join(dir, 'sess-1'), { recursive: true })
      writeFileSync(join(dir, 'sess-1', 'cache-log.jsonl'), [
        JSON.stringify({ t: Date.now(), turn: 1, model: 'deepseek-v4-flash', provider: 'deepseek-spark', input: 1000, cacheRead: 900, cacheCreate: 50, output: 40 }),
        JSON.stringify({ event: 'side_path', kind: 'llm-speculation', t: Date.now(), model: 'deepseek-v4-flash', provider: 'deepseek-spark', input: 500, cacheRead: 490, output: 10 }),
      ].join('\n'))

      const session = harvestSessionData(dir)
      assert.ok(session)
      assert.equal(session.sessionId, 'sess-1', 'worker meta 的更晚 updatedAt 不得抢占主会话')
      assert.equal(session.model, 'deepseek-v4-flash')
      assert.equal(session.speculationStats?.['tool-pattern']?.hits, 4)
      assert.equal(session.llmSpeculationEngine?.fired, 3)
      assert.equal(session.cache?.requests, 1, '主轮口径不含 side_path')
      assert.equal(session.cache?.hitRatePct, 90)
      const bucket = session.cache?.byProviderModel.find(b => b.provider === 'deepseek-spark')
      assert.ok(bucket, 'provider 维度行必须成桶')
      assert.equal(bucket.model, 'deepseek-v4-flash')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a dir that never got a session（agent 早夭）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-harvest-empty-'))
    try {
      assert.equal(harvestSessionData(dir), undefined)
      assert.equal(harvestSessionData(join(dir, 'never-created')), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
