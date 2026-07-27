import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serializeEvent, resultMaxLen, type StreamJsonEvent } from '../stream-json.js'

function parse(line: string): Record<string, unknown> {
  assert.equal(line.endsWith('\n'), true, 'each event line must end with \\n')
  const body = line.slice(0, -1)
  assert.equal(body.includes('\n'), false, 'serialized body must be single-line')
  return JSON.parse(body) as Record<string, unknown>
}

describe('serializeEvent', () => {
  it('preserves the legacy text_delta shape (backward compat)', () => {
    const ev: StreamJsonEvent = { type: 'text_delta', text: 'hi' }
    assert.deepEqual(parse(serializeEvent(ev)), { type: 'text_delta', text: 'hi' })
  })

  it('preserves the legacy tool_use shape', () => {
    const ev: StreamJsonEvent = { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }
    assert.deepEqual(parse(serializeEvent(ev)), { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } })
  })

  it('emits a session init envelope with session_id and model', () => {
    const ev: StreamJsonEvent = { type: 'system', subtype: 'init', session_id: 's1', model: 'deepseek-v4', cwd: '/repo' }
    const o = parse(serializeEvent(ev))
    assert.equal(o.type, 'system')
    assert.equal(o.subtype, 'init')
    assert.equal(o.session_id, 's1')
    assert.equal(o.model, 'deepseek-v4')
  })

  it('emits a result envelope with success + usage', () => {
    const ev: StreamJsonEvent = { type: 'result', subtype: 'success', session_id: 's1', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } }
    const o = parse(serializeEvent(ev))
    assert.equal(o.type, 'result')
    assert.equal(o.is_error, false)
    assert.equal(o.result, 'done')
    assert.deepEqual(o.usage, { input_tokens: 10, output_tokens: 5 })
  })

  it('emits a worker (subagent) progress event with nesting via parent_tool_id', () => {
    const ev: StreamJsonEvent = {
      type: 'worker', work_order_id: 'wo1', parent_tool_id: 't9', status: 'running',
      profile: 'code_scout', tool_use_count: 3, token_count: 1200, objective: 'find X',
    }
    const o = parse(serializeEvent(ev))
    assert.equal(o.type, 'worker')
    assert.equal(o.work_order_id, 'wo1')
    assert.equal(o.parent_tool_id, 't9')
    assert.equal(o.status, 'running')
    assert.equal(o.tool_use_count, 3)
  })

  it('truncates tool_result over the cap and sets truncated=true', () => {
    const big = 'x'.repeat(resultMaxLen() + 500)
    const ev: StreamJsonEvent = { type: 'tool_result', id: 't1', name: 'bash', result: big, isError: false }
    const o = parse(serializeEvent(ev))
    assert.equal((o.result as string).length, resultMaxLen())
    assert.equal(o.truncated, true)
  })

  it('does not set truncated for a short tool_result', () => {
    const ev: StreamJsonEvent = { type: 'tool_result', id: 't1', name: 'bash', result: 'ok', isError: false }
    const o = parse(serializeEvent(ev))
    assert.equal(o.result, 'ok')
    assert.equal('truncated' in o, false)
  })
})

describe('resultMaxLen', () => {
  it('reads RIVET_STREAM_RESULT_MAX when set, else defaults to 8000', () => {
    const prev = process.env.RIVET_STREAM_RESULT_MAX
    delete process.env.RIVET_STREAM_RESULT_MAX
    assert.equal(resultMaxLen(), 8000)
    process.env.RIVET_STREAM_RESULT_MAX = '100'
    assert.equal(resultMaxLen(), 100)
    if (prev === undefined) delete process.env.RIVET_STREAM_RESULT_MAX
    else process.env.RIVET_STREAM_RESULT_MAX = prev
  })

  it('treats 0 as unlimited (no truncation)', () => {
    const prev = process.env.RIVET_STREAM_RESULT_MAX
    process.env.RIVET_STREAM_RESULT_MAX = '0'
    const big = 'y'.repeat(20000)
    const ev: StreamJsonEvent = { type: 'tool_result', id: 't1', name: 'bash', result: big, isError: false }
    const o = JSON.parse(serializeEvent(ev).trimEnd()) as Record<string, unknown>
    assert.equal((o.result as string).length, 20000)
    assert.equal('truncated' in o, false)
    if (prev === undefined) delete process.env.RIVET_STREAM_RESULT_MAX
    else process.env.RIVET_STREAM_RESULT_MAX = prev
  })
})
