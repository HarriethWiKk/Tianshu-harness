/**
 * 读屏档的渲染侧行为。
 *
 * 断言的是「屏上真的没有动态段」而不是「标志位为 true」——这套东西的价值全在
 * 于 live region 不再每 120ms 重画，标志位测试挡不住把开关接错地方的回归。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'

interface AppInternals {
  streamRenderController: { ticker: ReturnType<typeof setInterval> | null }
  renderLive(): void
}

function makeApp(screenReader: boolean) {
  const out = new MockOut(120, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  app.start()
  if (screenReader) app.setScreenReader(true)
  return { app, out, internals: app as unknown as AppInternals }
}

const tick = () => new Promise(r => setTimeout(r, 10))

/**
 * 进入 thinking 后返回屏上文本。
 *
 * 不能「清空 chunks 再 renderLive」：LiveEngine 有无变化短路，内容与屏上一致时
 * 一个字节都不写，那样取到的永远是空串（对照组会跟着一起假绿）。这里取的是
 * delta 触发的那次真实渲染的输出。
 */
async function renderThinking(screenReader: boolean): Promise<string> {
  const { app, out } = makeApp(screenReader)
  out.chunks.length = 0
  app.callbacks.onThinkingDelta('reasoning about the problem')
  await tick()
  return stripAnsi(out.chunks.join(''))
}

describe('读屏档 — 动态段出局', () => {
  test('常规档下 thinking 会渲染出动态段（对照组）', async () => {
    const text = await renderThinking(false)
    assert.match(text, /reasoning about the problem|Thinking/i, '常规档本该显示思考态')
  })

  test('读屏档下同样的 thinking 不渲染动态段', async () => {
    const text = await renderThinking(true)
    assert.doesNotMatch(text, /reasoning about the problem/, '读屏档不该把流式内容画进 live 区')
  })

  test('中途切进读屏档：动态段被擦掉，输入框留下', async () => {
    // 借「切档」这个内容确实会变的时刻观测——内容不变时无变化短路会让任何
    // 重绘都不写字节，forceRedraw 也绕不过去（它只失效 memo）。
    const { app, out } = makeApp(false)
    app.callbacks.onThinkingDelta('reasoning about the problem')
    await tick()

    out.chunks.length = 0
    app.setScreenReader(true)
    const text = stripAnsi(out.chunks.join(''))

    assert.ok(text.trim().length > 0, '切档必须触发一次真实重绘')
    assert.doesNotMatch(text, /reasoning about the problem/, '切档后动态段应已消失')
    assert.match(text, /❯/, '输入框提示符必须留下 —— 用户还要打字')
  })
})

describe('读屏档 — ticker 不起转', () => {
  test('常规档进入活动态会启动 120ms ticker（对照组）', async () => {
    const { app, internals } = makeApp(false)
    app.callbacks.onThinkingDelta('x')
    await tick()
    assert.notEqual(internals.streamRenderController.ticker, null, '常规档活动期应有 ticker')
  })

  test('读屏档进入活动态不启动 ticker', async () => {
    const { app, internals } = makeApp(true)
    app.callbacks.onThinkingDelta('x')
    await tick()
    assert.equal(internals.streamRenderController.ticker, null, '读屏档不该有周期重绘')
  })

  test('运行中开启读屏档会停掉已在转的 ticker', async () => {
    const { app, internals } = makeApp(false)
    app.callbacks.onThinkingDelta('x')
    await tick()
    assert.notEqual(internals.streamRenderController.ticker, null)

    app.setScreenReader(true)
    assert.equal(internals.streamRenderController.ticker, null, '切档后周期重绘必须停')
  })
})

describe('读屏档 — 门禁留在屏上', () => {
  test('读屏档下审批提示与选项列表不被动态段出局连累', async () => {
    const { app, out } = makeApp(true)
    out.chunks.length = 0
    // 发起审批但不决议——提示必须持久可见，读屏用户才知道该按什么。
    void app.callbacks.onApprovalRequired('a1', 'bash', { command: 'rm -rf build' })
    await tick()
    const text = stripAnsi(out.chunks.join(''))
    assert.match(text, /bash/, '审批工具名必须留下')
    assert.match(text, /批准/, '选项列表必须留下')
  })

  test('常规档下审批提示同样渲染（对照组）', async () => {
    const { app, out } = makeApp(false)
    out.chunks.length = 0
    void app.callbacks.onApprovalRequired('a1', 'bash', { command: 'rm -rf build' })
    await tick()
    assert.match(stripAnsi(out.chunks.join('')), /批准/)
  })
})

describe('读屏档 — 开关语义', () => {
  test('isScreenReader 反映当前档位', () => {
    const { app } = makeApp(false)
    assert.equal(app.isScreenReader(), false)
    app.setScreenReader(true)
    assert.equal(app.isScreenReader(), true)
    app.setScreenReader(false)
    assert.equal(app.isScreenReader(), false)
  })

  test('重复设同一值是 no-op，不触发重绘风暴', () => {
    const { app, out } = makeApp(true)
    out.chunks.length = 0
    app.setScreenReader(true)
    assert.equal(out.chunks.length, 0, '同值重设不该产生输出')
  })

  test('关档后动态段回来', async () => {
    const { app, out } = makeApp(true)
    app.setScreenReader(false)
    out.chunks.length = 0
    app.callbacks.onThinkingDelta('reasoning about the problem')
    await tick()
    assert.match(stripAnsi(out.chunks.join('')), /reasoning about the problem|Thinking/i)
  })
})
