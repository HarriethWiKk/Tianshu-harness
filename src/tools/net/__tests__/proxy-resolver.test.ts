import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProxyForUrl, shouldBypassProxy, parseWindowsProxyOutput } from '../proxy-resolver.js'

describe('shouldBypassProxy', () => {
  it('returns false when NO_PROXY unset', () => {
    assert.equal(shouldBypassProxy('example.com', undefined), false)
  })

  it('bypasses all on *', () => {
    assert.equal(shouldBypassProxy('example.com', '*'), true)
  })

  it('matches exact domain (case-insensitive)', () => {
    assert.equal(shouldBypassProxy('api.deepseek.com', 'api.deepseek.com'), true)
    assert.equal(shouldBypassProxy('API.DEEPSEEK.COM', 'api.deepseek.com'), true)
  })

  it('matches .suffix for subdomains and bare domain', () => {
    assert.equal(shouldBypassProxy('docs.example.com', '.example.com'), true)
    assert.equal(shouldBypassProxy('example.com', '.example.com'), true)
  })

  it('does not match unrelated domain', () => {
    assert.equal(shouldBypassProxy('other.com', '.example.com'), false)
  })

  it('handles comma-separated list with whitespace', () => {
    assert.equal(shouldBypassProxy('a.com', 'a.com, b.com , c.com'), true)
    assert.equal(shouldBypassProxy('b.com', 'a.com, b.com , c.com'), true)
    assert.equal(shouldBypassProxy('d.com', 'a.com, b.com , c.com'), false)
  })
})

describe('resolveProxyForUrl', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']

  beforeEach(() => {
    for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('returns undefined when no proxy configured', () => {
    assert.equal(resolveProxyForUrl('https://example.com'), undefined)
  })

  it('reads HTTPS_PROXY for https URLs', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('reads HTTP_PROXY for http URLs', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('http://example.com'), 'http://127.0.0.1:7890')
  })

  it('falls back HTTP_PROXY for https when HTTPS_PROXY absent', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('is case-insensitive on env var names', () => {
    process.env.https_proxy = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('config proxyUrl takes precedence over env', () => {
    process.env.HTTPS_PROXY = 'http://env:7890'
    assert.equal(
      resolveProxyForUrl('https://example.com', { proxyUrl: 'http://config:1080' }),
      'http://config:1080',
    )
  })

  it('config noProxy bypasses even with proxy set', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    assert.equal(
      resolveProxyForUrl('https://localhost:3000', { noProxy: 'localhost' }),
      undefined,
    )
  })

  it('env NO_PROXY bypasses', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    process.env.NO_PROXY = '.internal.example.com'
    assert.equal(
      resolveProxyForUrl('https://api.internal.example.com'),
      undefined,
    )
  })

  it('returns undefined for invalid URL', () => {
    assert.equal(resolveProxyForUrl('not-a-url'), undefined)
  })

  it('returns undefined for non-http protocols', () => {
    assert.equal(resolveProxyForUrl('ftp://example.com'), undefined)
  })
})

/**
 * parseWindowsProxyOutput 纯函数测试——readWindowsSystemProxy 的判定核心。
 * 回归保护：历史上两个 bug——
 *   bug 1（顺序）：先读 ProxyServer 就 return，导致 ProxyEnable=0（代理禁用）时
 *                 仍返回残留的代理地址。Windows 关代理只翻 ProxyEnable 不清
 *                 ProxyServer，所以这个顺序必须反过来。
 *   bug 2（规范化）：裸 host:port 缺 http:// 前缀，new ProxyAgent 报 Invalid URL。
 */
describe('parseWindowsProxyOutput', () => {
  it('ProxyEnable=1 + ProxyServer 有值 → 返回规范化后的代理', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    127.0.0.1:7890'
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://127.0.0.1:7890')
  })

  it('ProxyEnable=0（代理禁用）+ ProxyServer 残留 → 返回 undefined（bug 1 回归保护）', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x0'
    const server = '    ProxyServer    REG_SZ    127.0.0.1:10808'
    // 修复前：先读 ProxyServer 直接 return 'http://127.0.0.1:10808'，无视 ProxyEnable=0
    assert.equal(parseWindowsProxyOutput(enable, server), undefined)
  })

  it('ProxyEnable 非 0x1（如空输出/键不存在）→ 返回 undefined', () => {
    assert.equal(parseWindowsProxyOutput('', '    ProxyServer    REG_SZ    127.0.0.1:7890'), undefined)
    assert.equal(parseWindowsProxyOutput('    ProxyEnable    REG_DWORD    0x1', ''), undefined)
  })

  it('裸 host:port 被 normalizeProxyUrl 加 http:// 前缀（bug 2 回归保护）', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    127.0.0.1:10808'
    // 修复前：直接返回 '127.0.0.1:10808'，new ProxyAgent 报 Invalid URL
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://127.0.0.1:10808')
  })

  it('已带 http:// 前缀的 ProxyServer 原样返回', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    http://10.0.0.1:8080'
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://10.0.0.1:8080')
  })

  it('多协议格式 http=a;https=b 优先取 https', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    http=127.0.0.1:80;https=127.0.0.1:443'
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://127.0.0.1:443')
  })
})
