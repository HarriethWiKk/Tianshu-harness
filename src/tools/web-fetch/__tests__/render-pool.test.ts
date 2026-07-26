import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RenderPool } from '../render-pool.js'
import type { PwBrowser, PwPage } from '../../net/playwright-driver.js'

function makeFakePage() {
  const state = { closed: false }
  const page: PwPage = {
    goto: async () => {},
    url: () => 'about:blank',
    content: async () => '',
    route: async () => {},
    close: async () => {
      state.closed = true
    },
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    evaluate: async () => undefined,
    waitForSelector: async () => {},
  }
  return { page, state }
}

function makeFakeBrowser() {
  const state = { closeCount: 0, connected: true, createdPages: 0, contextCloseCount: 0 }
  const browser: PwBrowser = {
    newPage: async () => {
      state.createdPages += 1
      return makeFakePage().page
    },
    newContext: async (_opts) => ({
      newPage: async () => {
        state.createdPages += 1
        return makeFakePage().page
      },
      close: async () => {
        state.contextCloseCount += 1
      },
    }),
    close: async () => {
      state.closeCount += 1
      state.connected = false
    },
    on: () => {},
    isConnected: () => state.connected,
  }
  return { browser, state }
}

describe('RenderPool', () => {
  it('懒启动：首次 acquirePage 才拉起 Browser；release 只关 Page 不关 Browser', async () => {
    let launches = 0
    const { browser, state } = makeFakeBrowser()
    const pool = new RenderPool({
      launchBrowser: async () => {
        launches += 1
        return browser
      },
      idleTimeoutMs: 60_000,
    })
    assert.equal(launches, 0)
    const page = await pool.acquirePage()
    assert.equal(launches, 1)
    assert.equal(pool.pageCount, 1)
    await pool.releasePage(page)
    assert.equal(pool.pageCount, 0)
    // release 关闭本页 context（隔离单元），不关 Browser
    assert.equal(state.contextCloseCount, 1)
    assert.equal(state.closeCount, 0)
    assert.equal(pool.isRunning, true)
    await pool.closeBrowser()
    assert.equal(state.closeCount, 1)
    assert.equal(pool.isRunning, false)
  })

  it('并发 acquire 复用同一次 launch', async () => {
    let launches = 0
    const { browser } = makeFakeBrowser()
    const pool = new RenderPool({
      launchBrowser: async () => {
        launches += 1
        // 模拟真实启动延迟，确保两个 acquire 重叠在 launching 窗口内
        await new Promise((r) => setTimeout(r, 20))
        return browser
      },
      idleTimeoutMs: 60_000,
    })
    const [p1, p2] = await Promise.all([pool.acquirePage(), pool.acquirePage()])
    assert.equal(launches, 1)
    assert.equal(pool.pageCount, 2)
    await pool.releasePage(p1)
    await pool.releasePage(p2)
    await pool.closeBrowser()
  })

  it('Page 数超限直接报错', async () => {
    const { browser } = makeFakeBrowser()
    const pool = new RenderPool({ launchBrowser: async () => browser, maxPages: 1 })
    await pool.acquirePage()
    await assert.rejects(() => pool.acquirePage(), /超限/)
    await pool.closeBrowser()
  })

  it('空闲超时自动关闭 Browser', async () => {
    const { browser, state } = makeFakeBrowser()
    const pool = new RenderPool({ launchBrowser: async () => browser, idleTimeoutMs: 30 })
    const page = await pool.acquirePage()
    await pool.releasePage(page)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(state.closeCount, 1)
    assert.equal(pool.isRunning, false)
  })

  it('Browser 崩溃（连接断开）后下次 acquire 重新拉起', async () => {
    let launches = 0
    const first = makeFakeBrowser()
    const second = makeFakeBrowser()
    const browsers = [first.browser, second.browser]
    const pool = new RenderPool({
      launchBrowser: async () => {
        launches += 1
        return browsers[launches - 1]!
      },
      idleTimeoutMs: 60_000,
    })
    const page = await pool.acquirePage()
    await pool.releasePage(page)
    first.state.connected = false // 模拟崩溃：playwright 连接断开
    const page2 = await pool.acquirePage()
    assert.equal(launches, 2)
    await pool.releasePage(page2)
    await pool.closeBrowser()
  })
})
