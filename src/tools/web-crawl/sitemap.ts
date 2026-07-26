/**
 * sitemap — crawl/map 的 sitemap 阶梯发现源（firecrawl 同序）：
 *   robots.txt 声明的 Sitemap: → 种子目录 sitemap.xml → origin sitemap.xml
 * sitemapindex 递归（上限 25 个 sitemap）；URL 上限 500。
 *
 * 已知裁减：无 eTLD+1 库，「主域 sitemap」未实现（同 hostname 场景已覆盖
 * 绝大多数文档站）；.gz sitemap 不解压（跳过）。
 */
import { decodeBody } from '../web-fetch/extract.js'
import { httpFetchGuarded, type HttpFetchDeps, type HttpFetchOptions } from '../net/http-fetch.js'

const MAX_SITEMAPS = 25
const MAX_SITEMAP_URLS = 500

export interface SitemapCollectResult {
  urls: string[]
  /** 实际尝试过的 sitemap（诊断用）。 */
  sitemapsHit: string[]
}

async function fetchText(
  url: string,
  deps: HttpFetchDeps,
  options: HttpFetchOptions,
): Promise<string | undefined> {
  try {
    const { status, contentType, bytes } = await httpFetchGuarded(url, deps, options)
    if (status >= 400) return undefined
    // 不做内容形态门禁（robots.txt 是纯文本、soft-404 的 HTML 提不出 <loc>）——
    // 无效内容在 loc 提取层自然落空
    return decodeBody(bytes, contentType)
  } catch {
    return undefined
  }
}

function extractLocs(xml: string): string[] {
  const locs: string[] = []
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1]!.trim())
  }
  return locs
}

export async function collectSitemapUrls(
  seed: URL,
  deps: HttpFetchDeps,
  options: HttpFetchOptions,
): Promise<SitemapCollectResult> {
  const origin = seed.origin

  // 阶梯候选：robots 声明 → 种子目录 → origin 根
  const candidates: string[] = []
  const robots = await fetchText(`${origin}/robots.txt`, deps, options)
  if (robots) {
    for (const line of robots.split('\n')) {
      const m = line.match(/^\s*sitemap:\s*(\S+)\s*$/i)
      if (m) candidates.push(m[1]!)
    }
  }
  const seedDir = seed.pathname.endsWith('/')
    ? seed.pathname
    : seed.pathname.slice(0, seed.pathname.lastIndexOf('/') + 1)
  candidates.push(`${origin}${seedDir}sitemap.xml`)
  candidates.push(`${origin}/sitemap.xml`)

  const sitemapsHit = new Set<string>()
  const urls: string[] = []
  const queue = [...new Set(candidates)]

  while (queue.length > 0 && sitemapsHit.size < MAX_SITEMAPS && urls.length < MAX_SITEMAP_URLS) {
    const sitemapUrl = queue.shift()!
    if (sitemapsHit.has(sitemapUrl) || sitemapUrl.endsWith('.gz')) continue
    sitemapsHit.add(sitemapUrl)
    const body = await fetchText(sitemapUrl, deps, options)
    if (!body) continue
    for (const loc of extractLocs(body)) {
      let locUrl: URL
      try {
        locUrl = new URL(loc)
      } catch {
        continue
      }
      if (/\.xml(\.gz)?$/i.test(locUrl.pathname)) {
        // sitemapindex → 递归子 sitemap
        queue.push(loc)
      } else if (urls.length < MAX_SITEMAP_URLS) {
        urls.push(loc)
      }
    }
  }

  return { urls, sitemapsHit: [...sitemapsHit] }
}
