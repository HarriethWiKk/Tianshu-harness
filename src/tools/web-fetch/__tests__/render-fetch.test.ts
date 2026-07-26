import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchViaPlaywright } from '../render-fetch.js'
import { SSRFError } from '../../net/ssrf.js'
import type { PwPage, PwRouteHandler } from '../../net/playwright-driver.js'

interface FakeScript {
  /** goto 期间"浏览器"会发出的请求（逐个过 route 拦截器）。 */
  requests?: string[]
  html?: string
  finalUrl?: string
  gotoError?: Error
}

function makeFakePage(script: FakeScript = {}) {
  let handler: PwRouteHandler | undefined
  const calls: string[] = []
  const page: PwPage = {
    route: async (_pattern, h) => {
      handler = h
    },
    goto: async (_url, _opts) => {
      calls.push('goto')
      if (script.gotoError) throw script.gotoError
      for (const reqUrl of script.requests ?? []) {
        await handler!(
          { abort: async () => {}, continue: async () => {} },
          { url: () => reqUrl },
        )
      }
    },
    url: () => script.finalUrl ?? '',
    content: async () => {
      calls.push('content')
      return script.html ?? '<html><body><main><p>真实 README 内容</p></main></body></html>'
    },
    close: async () => {},
    click: async (selector) => {
      calls.push(`click:${selector}`)
    },
    fill: async (selector, text) => {
      calls.push(`fill:${selector}=${text}`)
    },
    press: async (selector, key) => {
      calls.push(`press:${selector}:${key}`)
    },
    evaluate: async (script) => {
      calls.push(`eval:${script.slice(0, 30)}`)
      return undefined
    },
    waitForSelector: async (selector) => {
      calls.push(`waitFor:${selector}`)
    },
  }
  const pool = {
    acquirePage: async () => page,
    releasePage: async (_p: PwPage) => {},
  }
  return { page, pool, calls }
}

/** 公网地址；IP 字面量主机名原样返回（模拟 dns.lookup 对 IP 的行为）。 */
function makeLookup(privateHosts: string[] = []) {
  return async (hostname: string) => ({
    address: privateHosts.includes(hostname) ? hostname : '93.184.216.34',
  })
}

describe('fetchViaPlaywright', () => {
  it('主 URL 预检命中私网 → 抛 SSRFError（不可降级）', async () => {
    const { pool } = makeFakePage()
    await assert.rejects(
      fetchViaPlaywright('http://169.254.169.254/latest/meta-data', {
        pool,
        lookup: makeLookup(['169.254.169.254']),
      }),
      (err) => err instanceof SSRFError,
    )
  })

  it('内网子请求被逐一拦截，渲染流程不中断', async () => {
    const { pool } = makeFakePage({
      requests: [
        'https://cdn.example.com/app.js',
        'http://169.254.169.254/latest/meta-data',
        'http://127.0.0.1:8080/admin',
        'http://10.0.0.5/internal',
      ],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(['169.254.169.254', '127.0.0.1', '10.0.0.5']),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 3)
    assert.ok(result.markdown.includes('真实 README 内容'))
  })

  it('data:/blob:/about: 无网络请求，放行不计拦截', async () => {
    const { pool } = makeFakePage({
      requests: ['data:text/html,<p>x</p>', 'about:blank', 'blob:https://example.com/uuid'],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 0)
  })

  it('file:/ftp: 等非 http(s) scheme 一律阻断', async () => {
    const { pool } = makeFakePage({
      requests: ['file:///etc/passwd', 'ftp://internal.example/secret'],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.equal(result.blockedRequests, 2)
  })

  it('广告/追踪域名子请求被拦截，单独计数', async () => {
    const { pool } = makeFakePage({
      requests: [
        'https://cdn.example.com/app.js',
        'https://www.googlesyndication.com/ads.js',
        'https://sub.doubleclick.net/track',
      ],
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.equal(result.blockedAds, 2)
    assert.equal(result.blockedRequests, 0)
  })

  it('waitMs 水合等待生效', async () => {
    const { pool } = makeFakePage()
    const started = Date.now()
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
      waitMs: 60,
    })
    assert.ok(result)
    assert.ok(Date.now() - started >= 50, `等待应生效（实际 ${Date.now() - started}ms）`)
  })

  it('final URL 跳转到私网主机 → 抛 SSRFError', async () => {
    const { pool } = makeFakePage({ finalUrl: 'http://169.254.169.254/landing' })
    await assert.rejects(
      fetchViaPlaywright('https://example.com/', {
        pool,
        lookup: makeLookup(['169.254.169.254']),
      }),
      (err) => err instanceof SSRFError,
    )
  })

  it('导航超时/失败 → 返回 undefined（交 Jina 兜底）', async () => {
    const { pool } = makeFakePage({ gotoError: new Error('Timeout 30000ms exceeded') })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.equal(result, undefined)
  })

  it('chromium 不可用（acquire 失败）→ 返回 undefined', async () => {
    const pool = {
      acquirePage: async (): Promise<PwPage> => {
        throw new Error('chromium 未安装')
      },
      releasePage: async (_p: PwPage) => {},
    }
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.equal(result, undefined)
  })

  it('主 URL DNS 解析失败（非 SSRF）→ 返回 undefined', async () => {
    const { pool } = makeFakePage()
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: async () => {
        throw new Error('getaddrinfo ENOTFOUND example.com')
      },
    })
    assert.equal(result, undefined)
  })

  it('渲染后 HTML 经 extractMainContent + htmlToMarkdown 转换', async () => {
    const { pool } = makeFakePage({
      html: '<html><body><nav>导航噪音</nav><main><h1>标题</h1><p>正文段落</p></main></body></html>',
    })
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
    })
    assert.ok(result)
    assert.ok(result.markdown.includes('标题'))
    assert.ok(result.markdown.includes('正文段落'))
  })

  it('actions 在 goto 之后、取内容之前执行，结果随 actionResults 返回', async () => {
    const { pool, calls } = makeFakePage()
    const result = await fetchViaPlaywright('https://example.com/', {
      pool,
      lookup: makeLookup(),
      actions: [
        { type: 'click', selector: '.tab' },
        { type: 'execute_js', script: 'document.title' },
      ],
    })
    assert.ok(result)
    assert.deepEqual(calls, ['goto', 'click:.tab', 'eval:document.title', 'content'])
    assert.equal(result.actionResults?.length, 2)
    assert.ok(result.actionResults!.every((r) => r.ok))
  })
})
