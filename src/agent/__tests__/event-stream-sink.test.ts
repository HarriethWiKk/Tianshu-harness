import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNdjsonEventSink } from '../event-stream-sink.js'
import type { SessionEvent } from '../../server/protocol.js'

const ROOT = mkdtempSync(join(tmpdir(), 'rivet-event-sink-'))
after(() => { rmSync(ROOT, { recursive: true, force: true }) })

const ev = (seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent =>
  ({ seq, ts: 1_700_000_000_000, type, data })

describe('ndjson event sink', () => {
  test('每个事件一行，且逐行可 JSON.parse（jq 可消费）', async () => {
    const path = join(ROOT, 'a.jsonl')
    const { sink, close } = createNdjsonEventSink(path)

    sink(ev(1, 'tool_use', { id: 't1', name: 'read' }))
    sink(ev(2, 'tool_result', { id: 't1', isError: false }))
    await close()

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)

    const parsed = lines.map(l => JSON.parse(l) as SessionEvent)
    assert.deepEqual(parsed.map(p => p.type), ['tool_use', 'tool_result'])
    assert.equal(parsed[0]?.seq, 1)
  })

  test('含换行的负载不会撑破逐行格式', async () => {
    const path = join(ROOT, 'b.jsonl')
    const { sink, close } = createNdjsonEventSink(path)

    sink(ev(1, 'tool_result', { result: 'line1\nline2\nline3' }))
    await close()

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal((JSON.parse(lines[0] ?? '{}') as SessionEvent).data.result, 'line1\nline2\nline3')
  })

  test('父目录不存在时自动创建', async () => {
    const path = join(ROOT, 'nested', 'deep', 'c.jsonl')
    const { sink, close } = createNdjsonEventSink(path)

    sink(ev(1, 'status', { status: 'running' }))
    await close()

    assert.ok(existsSync(path))
  })

  test('不可写路径不抛错 —— 事件流是诊断通道，不能拖垮 run', async () => {
    // 用一个已存在的文件当目录段，open 必然失败。
    const blocker = join(ROOT, 'blocker.jsonl')
    const seed = createNdjsonEventSink(blocker)
    seed.sink(ev(1, 'status', {}))
    await seed.close()

    const { sink, close } = createNdjsonEventSink(join(blocker, 'nope.jsonl'))
    sink(ev(1, 'status', {}))
    sink(ev(2, 'status', {}))
    await assert.doesNotReject(close())
  })

  test('close 可重复调用', async () => {
    const path = join(ROOT, 'idempotent.jsonl')
    const { sink, close } = createNdjsonEventSink(path)
    sink(ev(1, 'status', {}))
    await close()
    await assert.doesNotReject(close())
  })

  test('首次事件之前不碰磁盘', () => {
    const path = join(ROOT, 'lazy.jsonl')
    createNdjsonEventSink(path)
    assert.equal(existsSync(path), false)
  })
})
