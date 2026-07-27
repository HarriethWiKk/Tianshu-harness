/**
 * TuiApp job event handling — 后台 job 事件 → 读模型 / scrollback 通知
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import type { JobEvent } from '../../../tools/job-store.js'

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, out, stdin }
}

function started(id: string, cmd: string): JobEvent {
  return { kind: 'started', job: { id, command: cmd, status: 'running', startedAt: Date.now(), lastLine: '' } }
}
function exit(id: string, cmd: string, code: number): JobEvent {
  return { kind: 'exit', job: { id, command: cmd, status: 'exited', exitCode: code, startedAt: Date.now() - 3000, endedAt: Date.now(), lastLine: 'done' } }
}

function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') }

test('records a started job into the jobs read model', () => {
  const { app } = makeApp()
  app.handleJobEvent(started('a1', 'npm run dev'))
  const data = app.getJobsData()
  assert.equal(data.rows.length, 1)
  assert.equal(data.rows[0]!.command, 'npm run dev')
  assert.equal(data.rows[0]!.status, 'running')
})

test('commits a completion line to scrollback on exit', () => {
  const { app, out } = makeApp()
  app.handleJobEvent(started('a1', 'build'))
  app.handleJobEvent(exit('a1', 'build', 0))
  const joined = out.chunks.join('\n')
  const plain = stripAnsi(joined)
  assert.match(plain, /后台任务.*完成|build/)
})

test('does not throw when a malformed event arrives', () => {
  const { app } = makeApp()
  assert.doesNotThrow(() => app.handleJobEvent({ kind: 'output', job: undefined as never }))
})

test('getJobsData returns empty list before any events', () => {
  const { app } = makeApp()
  const data = app.getJobsData()
  assert.equal(data.rows.length, 0)
  assert.equal(data.selectedIndex, 0)
})

// ── /jobs overlay keyboard interaction ──────────────────────────

test('setJobKill wires kill callback that marks job as killed in model', () => {
  const { app } = makeApp()
  app.setJobKill(id => {
    // Simulate what handleOverlayKey does on 'x': call jobKill and on success
    // emit a synthetic exit event to update the model
    app.handleJobEvent({ kind: 'exit', job: { id, command: 'test', status: 'killed', startedAt: Date.now(), endedAt: Date.now(), lastLine: 'stopped' } })
    return true
  })
  app.handleJobEvent(started('a1', 'build'))
  const killFn = (app as unknown as { jobKill: ((id: string) => boolean) | null }).jobKill
  assert.ok(killFn)
  const ok = killFn('a1')
  assert.equal(ok, true)
  const row = app.getJobsData().rows[0]
  assert.ok(row)
  assert.equal(row.status, 'killed')
})

test('x does nothing when jobKill returns false (terminal job guard)', () => {
  const { app } = makeApp()
  let called = false
  app.setJobKill(() => { called = true; return false })
  app.handleJobEvent(started('a1', 'build'))
  // Mark as terminal first
  app.handleJobEvent(exit('a1', 'build', 0))
  const killFn = (app as unknown as { jobKill: ((id: string) => boolean) | null }).jobKill
  assert.ok(killFn)
  const ok = killFn('a1')
  assert.equal(ok, false)
  assert.equal(called, true)
  // Row should still be 'exited', not 'killed'
  const row = app.getJobsData().rows[0]
  assert.ok(row)
  assert.equal(row.status, 'exited')
})

test('getJobsData.selectedIndex updates with jobsIndex nav state', () => {
  const { app } = makeApp()
  app.handleJobEvent(started('a1', 'cmd1'))
  app.handleJobEvent(started('a2', 'cmd2'))
  // Simulate nav state changes (what handleOverlayKey does)
  const nav = (app as unknown as { overlayController: { nav(): { jobsIndex: number } } }).overlayController.nav()
  assert.equal(app.getJobsData().selectedIndex, 0)
  nav.jobsIndex = 1
  assert.equal(app.getJobsData().selectedIndex, 1)
  nav.jobsIndex = 0
  assert.equal(app.getJobsData().selectedIndex, 0)
})

test('setJobLogs wires log callback for job detail view', () => {
  const { app } = makeApp()
  app.setJobLogs(id => id === 'a1' ? 'log content' : null)
  const view = app.getJobDetailView('a1')
  assert.equal(view, 'log content')
  const empty = app.getJobDetailView('unknown')
  assert.equal(empty, null)
})

// ── /jobs 激活路径（阻断回归：activateOverlay 的 switch 曾漏 'jobs' case）──

test('/jobs 可经 activateOverlay 激活并正常关闭', () => {
  const { app } = makeApp()
  app.start()
  app.registerOverlays({})
  assert.equal(app.activateOverlay('jobs'), true, '/jobs 必须能激活 overlay（曾落 default 静默 false）')
  const overlay = (app as unknown as { overlay: { isActive(): boolean; activeId(): string | null } }).overlay
  assert.equal(overlay.isActive(), true)
  assert.equal(overlay.activeId(), 'jobs')
  app.deactivateOverlay()
  assert.equal(overlay.isActive(), false)
})

test('非搜索型 overlay 未消费的键不漏进输入框（幽灵输入/幽灵提交）', async () => {
  const { app, stdin } = makeApp()
  app.start()
  app.registerOverlays({})
  let submitted = 0
  app.onSubmit(() => { submitted++ })
  assert.equal(app.activateOverlay('jobs'), true)

  stdin.dataHandler!('a')   // 可打印字符（jobs overlay 不消费）
  stdin.dataHandler!('\r')  // Enter（jobs overlay 空列表不消费）
  await new Promise(r => setTimeout(r, 10))

  const inputLine = (app as unknown as { inputLine: { value: string } }).inputLine
  assert.equal(inputLine.value, '', '可打印字符不得幽灵进 composer')
  assert.equal(submitted, 0, 'Enter 不得幽灵提交被遮住的输入框')
})

test('选中按 id 稳定——job 退出换组重排后 selectedIndex 跟随同一个 job', () => {
  const { app } = makeApp()
  const now = Date.now()
  app.handleJobEvent({ kind: 'started', job: { id: 'run1', command: 'cmd1', status: 'running', startedAt: now - 2000, lastLine: '' } })
  app.handleJobEvent({ kind: 'started', job: { id: 'run2', command: 'cmd2', status: 'running', startedAt: now - 1000, lastLine: '' } })
  const nav = (app as unknown as { overlayController: { nav(): { jobsIndex: number; jobsSelectedId?: string } } }).overlayController.nav()

  // 选中 run2（startedAt 较新，running 组内排第 1 行，index 0）
  nav.jobsIndex = 0
  nav.jobsSelectedId = 'run2'
  assert.equal(app.getJobsData().selectedIndex, 0)

  // run2 退出 → 换到终态组（index 变 1）；若按 index 选中就漂到 run1 上
  app.handleJobEvent({ kind: 'exit', job: { id: 'run2', command: 'cmd2', status: 'exited', exitCode: 0, startedAt: now - 1000, endedAt: now, lastLine: 'done' } })
  const data = app.getJobsData()
  assert.equal(data.rows[data.selectedIndex]!.id, 'run2', '选中必须跟随 job id，不随行重排漂移')
})
