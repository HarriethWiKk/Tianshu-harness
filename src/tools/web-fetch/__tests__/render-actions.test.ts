import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  executeRenderActions,
  parseRenderActions,
  MAX_ACTIONS,
  MAX_TOTAL_WAIT_MS,
  type RenderAction,
} from '../render-actions.js'
import type { PwPage } from '../../net/playwright-driver.js'

/** 记录调用序列的 fake page。 */
function makeFakePage(opts: { failOn?: string; evalValue?: unknown } = {}) {
  const calls: string[] = []
  const page: PwPage = {
    goto: async () => {},
    url: () => 'https://ex.com/',
    content: async () => '',
    route: async () => {},
    close: async () => {},
    click: async (selector) => {
      calls.push(`click:${selector}`)
      if (opts.failOn === 'click') throw new Error('Timeout 10000ms exceeded')
    },
    fill: async (selector, text) => {
      calls.push(`fill:${selector}=${text}`)
    },
    press: async (selector, key) => {
      calls.push(`press:${selector}:${key}`)
    },
    keyboard: {
      press: async (key) => {
        calls.push(`keyboard:${key}`)
      },
    },
    evaluate: async (script) => {
      calls.push(`eval:${script.slice(0, 40)}`)
      if (opts.failOn === 'evaluate') throw new Error('js crash')
      return opts.evalValue
    },
    waitForSelector: async (selector) => {
      calls.push(`waitFor:${selector}`)
    },
  }
  return { page, calls }
}

describe('parseRenderActions', () => {
  it('非数组/空数组/超步数直接拒绝', () => {
    assert.deepEqual(parseRenderActions('x'), { error: 'actions 必须是数组' })
    assert.deepEqual(parseRenderActions([]), { error: 'actions 不能为空数组' })
    const tooMany = Array.from({ length: MAX_ACTIONS + 1 }, () => ({ type: 'wait', ms: 1 }))
    const result = parseRenderActions(tooMany)
    assert.ok('error' in result && result.error.includes('步数超限'))
  })

  it('wait 总时长超 60s 拒绝', () => {
    const result = parseRenderActions([
      { type: 'wait', ms: MAX_TOTAL_WAIT_MS },
      { type: 'wait', ms: 1 },
    ])
    assert.ok('error' in result && result.error.includes('总时长超限'))
  })

  it('selector/text/script/key 缺失逐步报错', () => {
    assert.ok('error' in parseRenderActions([{ type: 'click' }]))
    assert.ok('error' in parseRenderActions([{ type: 'write', selector: '#a' }]))
    assert.ok('error' in parseRenderActions([{ type: 'press' }]))
    assert.ok('error' in parseRenderActions([{ type: 'execute_js' }]))
    assert.ok('error' in parseRenderActions([{ type: 'wait' }]))
    assert.ok('error' in parseRenderActions([{ type: 'fly' }]))
  })

  it('合法序列规范化通过（scroll 默认 down，press selector 可选）', () => {
    const result = parseRenderActions([
      { type: 'click', selector: ' .btn ', all: true },
      { type: 'scroll' },
      { type: 'press', key: 'Enter' },
      { type: 'wait', selector: '.done' },
    ])
    assert.ok('actions' in result)
    assert.deepEqual(result.actions, [
      { type: 'click', selector: '.btn', all: true },
      { type: 'scroll', direction: 'down' },
      { type: 'press', key: 'Enter' },
      { type: 'wait', selector: '.done' },
    ])
  })
})

describe('executeRenderActions', () => {
  it('按序执行并记录全部成功', async () => {
    const { page, calls } = makeFakePage({ evalValue: { n: 42 } })
    const actions: RenderAction[] = [
      { type: 'click', selector: '.btn' },
      { type: 'write', selector: '#q', text: 'hello' },
      { type: 'press', key: 'Enter', selector: '#q' },
      { type: 'press', key: 'Escape' },
      { type: 'wait', selector: '.result' },
      { type: 'scroll', direction: 'bottom' },
      { type: 'execute_js', script: '({n: 42})' },
    ]
    const results = await executeRenderActions(page, actions)
    assert.equal(results.length, 7)
    assert.ok(results.every((r) => r.ok))
    assert.deepEqual(calls, [
      'click:.btn',
      'fill:#q=hello',
      'press:#q:Enter',
      'keyboard:Escape',
      'waitFor:.result',
      'eval:window.scrollTo(0, document.body.scrollH',
      'eval:({n: 42})',
    ])
    assert.equal(results[6]!.detail, '{"n":42}')
  })

  it('click all 走 querySelectorAll forEach DOM 点击', async () => {
    const { page, calls } = makeFakePage()
    await executeRenderActions(page, [{ type: 'click', selector: '.tab', all: true }])
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.startsWith('eval:document.querySelectorAll'))
  })

  it('单步失败即中止并记录原因', async () => {
    const { page, calls } = makeFakePage({ failOn: 'click' })
    const results = await executeRenderActions(page, [
      { type: 'click', selector: '.missing' },
      { type: 'write', selector: '#q', text: 'x' },
    ])
    assert.equal(results.length, 1)
    assert.equal(results[0]!.ok, false)
    assert.ok(results[0]!.detail!.includes('Timeout'))
    assert.equal(calls.length, 1) // write 未执行
  })

  it('execute_js 返回值截断到 2K', async () => {
    const { page } = makeFakePage({ evalValue: 'x'.repeat(5000) })
    const results = await executeRenderActions(page, [{ type: 'execute_js', script: '"..."' }])
    assert.ok(results[0]!.ok)
    assert.ok(results[0]!.detail!.length < 2100)
    assert.ok(results[0]!.detail!.includes('截断'))
  })

  it('wait ms 真实等待', async () => {
    const { page } = makeFakePage()
    const started = Date.now()
    await executeRenderActions(page, [{ type: 'wait', ms: 60 }])
    assert.ok(Date.now() - started >= 50)
  })
})
