import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobRegistry } from '../job-registry.js'
import type { JobEvent } from '../../tools/job-store.js'
import { renderJobsOverlay } from '../format/jobs-panel.js'
import { getTheme } from '../theme.js'

function started(id: string, command: string): JobEvent {
  return { kind: 'started', job: { id, command, status: 'running', startedAt: 1000, lastLine: '' } }
}
function output(id: string, command: string, lastLine: string): JobEvent {
  return { kind: 'output', job: { id, command, status: 'running', startedAt: 1000, lastLine }, chunk: lastLine }
}
function exit(id: string, command: string, code: number): JobEvent {
  return { kind: 'exit', job: { id, command, status: 'exited', exitCode: code, startedAt: 1000, endedAt: 5000, lastLine: 'done' } }
}

describe('JobRegistry', () => {
  it('adds a running job on started', () => {
    const reg = new JobRegistry()
    reg.apply(started('a1', 'npm run dev'))
    const rows = reg.rows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, 'a1')
    assert.equal(rows[0]!.status, 'running')
    assert.equal(rows[0]!.command, 'npm run dev')
  })

  it('updates lastLine on output without duplicating the row', () => {
    const reg = new JobRegistry()
    reg.apply(started('a1', 'npm run dev'))
    reg.apply(output('a1', 'npm run dev', 'Listening on :3000'))
    const rows = reg.rows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.lastLine, 'Listening on :3000')
  })

  it('marks terminal + unread on exit, and reports the transition once', () => {
    const reg = new JobRegistry()
    reg.apply(started('a1', 'npm run dev'))
    const t1 = reg.apply(exit('a1', 'npm run dev', 0))
    assert.equal(t1?.becameTerminal, true)
    const row = reg.rows()[0]!
    assert.equal(row.status, 'exited')
    assert.equal(row.terminal, true)
    assert.equal(row.unread, true)
    assert.equal(row.exitCode, 0)
    const t2 = reg.apply(exit('a1', 'npm run dev', 0))
    assert.equal(t2?.becameTerminal, false)
  })

  it('clears unread when markSeen is called', () => {
    const reg = new JobRegistry()
    reg.apply(started('a1', 'x'))
    reg.apply(exit('a1', 'x', 1))
    reg.markSeen('a1')
    assert.equal(reg.rows()[0]!.unread, false)
  })

  it('sorts running jobs before terminal, newest first within a group', () => {
    const reg = new JobRegistry()
    reg.apply(started('old', 'a'))
    reg.apply({ kind: 'started', job: { id: 'new', command: 'b', status: 'running', startedAt: 2000, lastLine: '' } })
    reg.apply(exit('old', 'a', 0))
    const ids = reg.rows().map(r => r.id)
    assert.deepEqual(ids, ['new', 'old'])
  })
})

describe('JobRegistry → renderJobsOverlay integration', () => {
  it('produces newline-free overlay lines end to end', () => {
    const reg = new JobRegistry()
    reg.apply({ kind: 'started', job: { id: 'x1', command: 'npm run dev', status: 'running', startedAt: 1000, lastLine: '' } })
    reg.apply({ kind: 'output', job: { id: 'x1', command: 'npm run dev', status: 'running', startedAt: 1000, lastLine: 'ready\nextra' }, chunk: 'ready\nextra' })
    const lines = renderJobsOverlay(reg.rows(), 100, 30, getTheme(), 0)
    assert.ok(lines.length > 0)
    for (const l of lines) assert.equal(l.includes('\n'), false)
  })

  it('renders terminal job with exit code end to end', () => {
    const reg = new JobRegistry()
    reg.apply({ kind: 'started', job: { id: 'a1', command: 'build', status: 'running', startedAt: 1000, lastLine: '' } })
    reg.apply({ kind: 'exit', job: { id: 'a1', command: 'build', status: 'exited', exitCode: 1, startedAt: 1000, endedAt: 5000, lastLine: 'failed' } })
    const lines = renderJobsOverlay(reg.rows(), 80, 24, getTheme(), 0)
    const plain = lines.join('\n').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    assert.match(plain, /build/)
    assert.match(plain, /exit 1|✗/)
  })
})

it('终态行超出上限时淘汰最旧的，running 永不淘汰', () => {
  const reg = new JobRegistry()
  const base = Date.now() - 100_000
  for (let i = 0; i < JobRegistry.MAX_TERMINAL_ROWS + 5; i++) {
    reg.apply({ kind: 'exit', job: { id: `j${i}`, command: `cmd${i}`, status: 'exited', exitCode: 0, startedAt: base + i * 1000, endedAt: base + i * 1000 + 1, lastLine: 'x' } })
  }
  reg.apply({ kind: 'started', job: { id: 'run1', command: 'sleep', status: 'running', startedAt: base - 999_000, lastLine: '' } })

  const rows = reg.rows()
  const terminal = rows.filter(r => r.terminal)
  assert.equal(terminal.length, JobRegistry.MAX_TERMINAL_ROWS)
  assert.ok(!rows.some(r => r.id === 'j0'), '最旧的终态行应被淘汰')
  assert.ok(rows.some(r => r.id === `j${JobRegistry.MAX_TERMINAL_ROWS + 4}`), '最新终态行必须保留')
  assert.ok(rows.some(r => r.id === 'run1' && !rows.find(r => r.id === 'run1')!.terminal), 'running 行不得被淘汰')
})
