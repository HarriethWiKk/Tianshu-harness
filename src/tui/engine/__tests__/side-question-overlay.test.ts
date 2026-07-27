/**
 * `/btw` 侧问浮层的交互契约（Wave 1-3）。
 *
 * 最重要的断言是**关掉即弃**：浮层状态清空，没有任何东西被写回。侧问一旦漏进
 * 历史，它的两个卖点（不打断、极便宜）就同时消失——主对话字节变了，下一轮前缀
 * 就得重建。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut(100, 30)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 30, modelName: 'test',
  })
  app.registerOverlays()
  app.start()
  return { app, out, stdin }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

/** 直接注入一个已解析的按键，绕开 lone-ESC 的消歧超时。 */
function sendOverlayKey(app: TuiApp, key: { name: string; char: string }): void {
  ;(app as unknown as { handleOverlayKey(k: unknown): boolean }).handleOverlayKey(key)
}

function screen(out: MockOut): string {
  return out.chunks.join('').replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
}

test('/btw 开浮层并流式填充回答', async () => {
  const { app, out, stdin } = makeApp()
  app.setSideQuestionAsker(async (_q, onDelta) => {
    onDelta('类型不')
    onDelta('匹配。')
    return '类型不匹配。'
  })

  app.askSideQuestion('刚才那个报错什么意思')
  await tick(30)

  const text = screen(out)
  assert.match(text, /侧问/)
  assert.match(text, /刚才那个报错什么意思/)
  assert.match(text, /类型不匹配。/)
  void stdin
})

test('Esc 关掉即弃：状态清空，什么都不留下', async () => {
  const { app, stdin } = makeApp()
  app.setSideQuestionAsker(async () => '答案在此')

  app.askSideQuestion('问题')
  await tick(30)
  assert.ok(app.getSideQuestion(), '前置条件：浮层有内容')

  stdin.dataHandler!('\x1b') // lone ESC 经消歧超时派发
  await tick(150)

  assert.equal(app.getSideQuestion(), null, '关掉后不得留存')
})

test('q 也能关闭且同样清空', async () => {
  const { app } = makeApp()
  app.setSideQuestionAsker(async () => '答案')
  app.askSideQuestion('问题')
  await tick(30)

  sendOverlayKey(app, { name: 'q', char: 'q' })
  await tick()

  assert.equal(app.activeOverlayId(), null)
  assert.equal(app.getSideQuestion(), null)
})

test('切换到别的 overlay 也丢弃侧问状态', async () => {
  const { app } = makeApp()
  app.setSideQuestionAsker(async () => '答案')
  app.askSideQuestion('问题')
  await tick(30)

  app.activateOverlay('cockpit')
  await tick()

  assert.equal(app.getSideQuestion(), null, '不该在切走后还留着')
})

test('未注入执行器 → 浮层显示不可用，而不是静默无反应', async () => {
  const { app } = makeApp()
  app.askSideQuestion('问题')
  await tick()

  const state = app.getSideQuestion()
  assert.equal(state?.pending, false)
  assert.match(String(state?.error), /不可用/)
})

test('执行器抛错 → 浮层显示错误，不崩', async () => {
  const { app } = makeApp()
  app.setSideQuestionAsker(async () => { throw new Error('network down') })

  app.askSideQuestion('问题')
  await tick(30)

  assert.match(String(app.getSideQuestion()?.error), /network down/)
  assert.equal(app.getSideQuestion()?.pending, false)
})

test('迟到的增量不得回灌到已关闭的浮层', async () => {
  const { app } = makeApp()
  let leak: ((c: string) => void) | null = null
  app.setSideQuestionAsker((_q, onDelta) => {
    leak = onDelta
    return new Promise(() => { /* 永不 resolve */ })
  })

  app.askSideQuestion('第一个问题')
  await tick()
  sendOverlayKey(app, { name: 'q', char: 'q' })
  await tick()

  leak!('迟到的内容')
  await tick()

  assert.equal(app.getSideQuestion(), null, '关掉之后不该被增量复活')
})

test('空问题不开浮层', async () => {
  const { app } = makeApp()
  app.setSideQuestionAsker(async () => '答案')
  app.askSideQuestion('   ')
  await tick()
  assert.equal(app.getSideQuestion(), null)
})
