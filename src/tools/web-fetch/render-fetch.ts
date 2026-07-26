/**
 * render-fetch — 用本地 headless chromium 渲染 SPA 页面并转 Markdown。
 *
 * web_fetch 三级降级的中间层：本地 turndown 质量差时，本地渲染拿 JS 执行
 * 后的真实 DOM（无外发请求、不受网络封锁影响），仍失败才走 Jina 兜底。
 *
 * SSRF 双层防护（现有 web_fetch 不执行 JS，渲染引入了新攻击面——必做、不可裁剪）：
 *   1. goto 前 resolveAndAssertPublic 预检主 URL（浏览器自解析 DNS，必须预检）
 *   2. page.route 逐请求拦截（主文档 + 全部子资源）——只检主 URL 会被页面内
 *      169.254.169.254 / 127.0.0.1 等内网子资源打穿；请求级拦截同时关闭
 *      预检与浏览器 DNS 解析之间的 rebinding 窗口
 *   3. domcontentloaded 后复检 final URL（防客户端跳转带出域）
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { resolveAndAssertPublic, SSRFError, type LookupFn } from '../net/ssrf.js'
import { resolveProxyForUrl, type ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { PwPage } from '../net/playwright-driver.js'
import { htmlToMarkdownSmart, extractLinks } from './extract.js'
import { executeRenderActions, type ActionResult, type RenderAction } from './render-actions.js'
import { getDefaultRenderPool, type RenderPool } from './render-pool.js'

const DEFAULT_RENDER_TIMEOUT_MS = 30_000

/** 广告/追踪域名清单（firecrawl playwright-service AD_SERVING_DOMAINS 同款）。 */
const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
]

function isAdHost(hostname: string): boolean {
  return AD_SERVING_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))
}

export interface RenderFetchResult {
  markdown: string
  /** 被 SSRF 拦截的子请求数（>0 说明页面试图触达内网/非 http 资源）。 */
  blockedRequests: number
  /** 被广告域名清单拦截的子请求数。 */
  blockedAds: number
  /** 动作序列执行结果（仅带 actions 时存在；含失败中止记录）。 */
  actionResults?: ActionResult[]
  /** 渲染后 DOM 提取的绝对链接（crawl 发现源）。 */
  links?: string[]
}

export interface RenderFetchOptions {
  /** 渲染超时（默认 30s，独立于 web_fetch 的 15s 请求超时）。 */
  timeoutMs?: number
  /** domcontentloaded 后的额外等待 ms（SPA 水合用，默认 0；上限由 build-options 钳制 ≤ timeoutMs/2）。 */
  waitMs?: number
  /** 渲染动作序列（goto + waitMs 之后、取内容之前按序执行）。 */
  actions?: RenderAction[]
  proxy?: ProxyResolverOptions
  lookup?: LookupFn
  /** 与主链路一致的 extractMainContent 开关（默认 true）。 */
  extractMainContent?: boolean
  /** 测试注入：替换默认渲染池。 */
  pool?: Pick<RenderPool, 'acquirePage' | 'releasePage'>
}

/** data:/blob:/about: 不产生网络请求，放行；其余非 http(s) scheme 一律阻断。 */
function isLocalScheme(protocol: string): boolean {
  return protocol === 'data:' || protocol === 'blob:' || protocol === 'about:'
}

/**
 * 渲染抓取。返回 undefined 表示渲染路径失败（chromium 缺失/启动失败/导航
 * 超时等），调用方应继续走 Jina 兜底；SSRFError 上抛（安全拦截不可静默降级）。
 */
export async function fetchViaPlaywright(
  rawUrl: string,
  opts: RenderFetchOptions = {},
): Promise<RenderFetchResult | undefined> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return undefined
  }

  const lookup: LookupFn = opts.lookup ?? ((hostname) => dnsLookup(hostname))
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS

  // 第一层：主 URL 预检。DNS 失败（非 SSRFError）按渲染不可用处理，降级 Jina。
  try {
    await resolveAndAssertPublic(target.hostname, lookup)
  } catch (err) {
    if (err instanceof SSRFError) throw err
    return undefined
  }

  const proxyServer = resolveProxyForUrl(rawUrl, opts.proxy)
  const pool = opts.pool ?? getDefaultRenderPool(proxyServer ? { proxy: { server: proxyServer } } : {})

  let page: PwPage
  try {
    page = await pool.acquirePage()
  } catch {
    return undefined
  }

  let blockedRequests = 0
  let blockedAds = 0
  try {
    // 第二层：逐请求拦截（主文档 + 全部子资源）
    await page.route('**/*', async (route, request) => {
      const reqUrl = request.url()
      let parsed: URL
      try {
        parsed = new URL(reqUrl)
      } catch {
        blockedRequests += 1
        await route.abort()
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        if (isLocalScheme(parsed.protocol)) {
          await route.continue()
          return
        }
        blockedRequests += 1
        await route.abort()
        return
      }
      // 广告/追踪域名直接掐（省带宽省渲染时间，对正文无影响）
      if (isAdHost(parsed.hostname)) {
        blockedAds += 1
        await route.abort()
        return
      }
      try {
        await resolveAndAssertPublic(parsed.hostname, lookup)
        await route.continue()
      } catch {
        // 私网目标或 DNS 失败一律阻断（fail-closed）
        blockedRequests += 1
        await route.abort()
      }
    })

    await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    // SPA 水合等待（firecrawl wait_after_load 同款）
    if (opts.waitMs && opts.waitMs > 0) {
      await new Promise((r) => setTimeout(r, opts.waitMs))
    }

    // 动作序列：goto + 水合等待之后、取内容之前（单步失败即中止并记录）
    let actionResults: ActionResult[] | undefined
    if (opts.actions && opts.actions.length > 0) {
      actionResults = await executeRenderActions(page, opts.actions)
    }

    // 第三层：final URL 复检（客户端跳转/动作导航可能把页面带出已验证的域）
    const finalUrl = page.url()
    if (finalUrl.startsWith('http:') || finalUrl.startsWith('https:')) {
      const finalHost = new URL(finalUrl).hostname
      if (finalHost !== target.hostname) {
        await resolveAndAssertPublic(finalHost, lookup)
      }
    }

    const html = await page.content()
    const pageUrl = finalUrl.startsWith('http') ? finalUrl : rawUrl
    const markdown = await htmlToMarkdownSmart(html, {
      pageUrl,
      onlyMainContent: opts.extractMainContent !== false,
    })
    return {
      markdown,
      blockedRequests,
      blockedAds,
      ...(actionResults ? { actionResults } : {}),
      links: extractLinks(html, pageUrl),
    }
  } catch (err) {
    // SSRF 拦截必须显式上抛；其余失败（导航超时、Browser 崩溃等）降级 Jina
    if (err instanceof SSRFError) throw err
    return undefined
  } finally {
    await pool.releasePage(page)
  }
}
