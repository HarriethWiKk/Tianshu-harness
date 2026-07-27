/**
 * 分档等待提示接线（Ink→ANSI 迁移孤儿重接）。
 *
 * 背景：fluency 策略层曾接在 Ink 版 src/tui/app.tsx 上，`25bcc523` 退役 Ink 双栈时
 * 连同 app.tsx 一起删除，策略引擎与其完整单测留了下来但**再无生产消费方**。
 * 因此本文件刻意断言「消息进入了渲染输出」而不是「策略函数返回了消息」——
 * 后者在断线的两个月里一直是绿的，挡不住同一类回归。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'

interface AppInternals {
  streamRenderController: { lastActivityMs: number }
  renderLive(): void
}

function makeApp() {
  const out = new MockOut(120, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  app.start()
  return { app, out, internals: app as unknown as AppInternals }
}

const tick = () => new Promise(r => setTimeout(r, 10))

/** 让 app 进入某个 phase，再把「最后活动时间」回拨到指定静默时长。 */
async function silentFor(ms: number, enter: (app: TuiApp) => void) {
  const { app, out, internals } = makeApp()
  enter(app)
  await tick()
  internals.streamRenderController.lastActivityMs = Date.now() - ms
  out.chunks.length = 0
  internals.renderLive()
  return stripAnsi(out.chunks.join(''))
}

test('thinking 静默越过 action 档 → 渲染出可执行提示（Ctrl+C）', async () => {
  const text = await silentFor(200_000, app => { app.callbacks.onThinkingDelta('reasoning') })
  assert.match(text, /Ctrl\+C/, 'action 档必须告诉用户可以中止')
})

test('thinking 静默在 info 档 → 渲染出温和提示，不喊中止', async () => {
  const text = await silentFor(40_000, app => { app.callbacks.onThinkingDelta('reasoning') })
  assert.match(text, /Thinking deeply/, 'info 档提示应出现在渲染输出里')
  assert.doesNotMatch(text, /Ctrl\+C to stop/, 'info 档不应催用户中止')
})

test('streaming 静默越过 warn 档 → 渲染出等待时长', async () => {
  const text = await silentFor(70_000, app => { app.callbacks.onTextDelta('hello') })
  assert.match(text, /Still waiting/, 'streaming 的 warn 档提示应出现')
})

test('静默未到阈值 → 不渲染任何等待提示', async () => {
  const text = await silentFor(5_000, app => { app.callbacks.onThinkingDelta('reasoning') })
  assert.doesNotMatch(text, /Thinking deeply|Still waiting|Ctrl\+C to stop/, '短等待不该加噪音')
})
