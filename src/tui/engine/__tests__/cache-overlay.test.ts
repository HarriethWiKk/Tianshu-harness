/**
 * `/cache` overlay 接线测试：激活、←/→/Tab 切周期、异步数据到位后重画。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import type { CachePanelData } from '../../format/cache-panel.js'

class MockOut {
  columns = 120; rows = 30; chunks: string[] = []
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

function makeApp(data: () => CachePanelData) {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 30,
    modelName: 'deepseek-chat',
    contextWindow: 128_000,
  })
  app.registerOverlays({ cachePanelData: data })
  return { app, out }
}

function emptyData(): CachePanelData {
  return {
    period: 'today',
    session: null,
    aggregates: null,
    loading: false,
    official: { status: 'unavailable', hint: '未登录' },
  }
}

const sendOverlayKey = (app: TuiApp, key: { name: string; char: string; shift?: boolean }): void => {
  ;(app as any).handleOverlayKey(key)
}

test('/cache 可激活，且渲染 provider 被调用', () => {
  let calls = 0
  const { app } = makeApp(() => { calls += 1; return emptyData() })
  assert.equal(app.activateOverlay('cache'), true)
  assert.equal(app.activeOverlayId(), 'cache')
  assert.ok(calls > 0)
})

test('←/→ 与 Tab/Shift+Tab 循环切换周期页签', () => {
  const { app } = makeApp(emptyData)
  app.activateOverlay('cache')
  const nav = () => app['overlayController'].nav().cachePeriod

  assert.equal(nav(), 'today')
  sendOverlayKey(app, { name: 'right', char: '' })
  assert.equal(nav(), '7d')
  sendOverlayKey(app, { name: 'tab', char: '\t' })
  assert.equal(nav(), '30d')
  // 循环回头
  sendOverlayKey(app, { name: 'right', char: '' })
  assert.equal(nav(), 'today')
  sendOverlayKey(app, { name: 'left', char: '' })
  assert.equal(nav(), '30d')
  sendOverlayKey(app, { name: 'tab', char: '\t', shift: true })
  assert.equal(nav(), '7d')
})

test('周期由 overlay nav 注入渲染，覆盖 provider 返回的 period', () => {
  // provider 恒返回 today —— 画面上高亮哪个页签只能由 nav 决定
  const { app, out } = makeApp(emptyData)
  app.activateOverlay('cache')
  out.chunks.length = 0
  sendOverlayKey(app, { name: 'right', char: '' })
  const painted = out.chunks.join('').replace(/\x1B\[[0-9;]*m/g, '')
  assert.match(painted, /\[7天\]/)
  assert.doesNotMatch(painted, /\[今日\]/)
})

test('q 关闭面板；重开时周期复位为今日', () => {
  const { app } = makeApp(emptyData)
  app.activateOverlay('cache')
  sendOverlayKey(app, { name: 'right', char: '' })
  assert.equal(app['overlayController'].nav().cachePeriod, '7d')

  sendOverlayKey(app, { name: '', char: 'q' })
  assert.equal(app.activeOverlayId(), null)

  app.activateOverlay('cache')
  assert.equal(app['overlayController'].nav().cachePeriod, 'today')
})

test('refreshOverlay 只在该 overlay 活动时重画（异步数据到位的回调入口）', () => {
  let calls = 0
  const { app } = makeApp(() => { calls += 1; return emptyData() })

  // 未激活：不应触发任何渲染
  app.refreshOverlay('cache')
  assert.equal(calls, 0)

  app.activateOverlay('cache')
  const afterActivate = calls
  assert.ok(afterActivate > 0)

  app.refreshOverlay('cache')
  assert.ok(calls > afterActivate)

  // 别的 overlay id 不触发本面板重画
  const before = calls
  app.refreshOverlay('jobs')
  assert.equal(calls, before)
})

test('provider 缺失时给出占位而不是崩', () => {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24,
    modelName: 'deepseek-chat',
    contextWindow: 128_000,
  })
  app.registerOverlays({})
  assert.equal(app.activateOverlay('cache'), true)
  assert.match(out.chunks.join(''), /缓存面板数据不可用/)
})
