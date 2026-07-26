/**
 * crawl — 进程内隐式 BFS 引擎（firecrawl 自增殖 job 图原生重写）。
 *
 * firecrawl 的 crawl 是 job 自我增殖构成的图（每个 job 完成后「提链接 →
 * 原子去重 → 派新 job」），收敛靠 jobs==jobs_done 集合基数判定。进程内化
 * 后等价物：frontier 数组 + visited Set + inFlight 计数，
 * **收敛 = frontier 空 && inFlight == 0**。
 */
import { normalizeCacheUrl } from '../web-fetch/fetch-cache.js'
import type { FetchMarkdownOutcome } from '../web-fetch/fetch-core.js'
import { filterLink, getUrlDepth, type DenialReason } from './filter-links.js'

export interface CrawlOptions {
  /** 页数上限（默认 20，由工具层 clamp 到 ≤200）。 */
  maxPages?: number
  /** 距种子跳数上限（默认 2；同时换算为路径段数上限 = 种子深度 + maxDepth）。 */
  maxDepth?: number
  includePaths?: RegExp[]
  excludePaths?: RegExp[]
  allowBackward?: boolean
  /** 总预算 ms（默认 180s）；到期停调新页，等 inFlight 收尾后返回（截断标记）。 */
  budgetMs?: number
  /** 并发（默认 4）。 */
  concurrency?: number
  /** 同 host 请求最小间隔 ms（默认 300，礼貌抓取）。 */
  minIntervalPerHostMs?: number
  /** sitemap 预收集的 URL（调用方负责收集；作为 depth-1 候选，仍过过滤链）。 */
  sitemapUrls?: string[]
}

export interface CrawlPage {
  url: string
  depth: number
  status: number
  markdown: string
  via: string
  fromCache: boolean
}

export interface CrawlDenied {
  url: string
  reason: DenialReason
}

export interface CrawlError {
  url: string
  error: string
}

export interface CrawlResult {
  pages: CrawlPage[]
  denied: CrawlDenied[]
  errors: CrawlError[]
  /** 因页数/预算截断（frontier 还有未抓的候选）。 */
  truncated: boolean
  durationMs: number
}

export type CrawlFetcher = (url: string) => Promise<FetchMarkdownOutcome>

/** www/非 www 变体（轻量相似 URL 去重——firecrawl generateURLPermutations 的最小子集）。 */
function wwwVariant(normalizedUrl: string): string {
  if (normalizedUrl.includes('://www.')) return normalizedUrl.replace('://www.', '://')
  return normalizedUrl.replace('://', '://www.')
}

export async function crawl(
  seedUrl: string,
  fetcher: CrawlFetcher,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 20
  const maxDepth = opts.maxDepth ?? 2
  const budgetMs = opts.budgetMs ?? 180_000
  const concurrency = opts.concurrency ?? 4
  const minInterval = opts.minIntervalPerHostMs ?? 300

  const seed = new URL(seedUrl) // 调用方已校验
  const filterOpts = {
    seedHost: seed.hostname.toLowerCase(),
    seedPath: seed.pathname,
    seedDepth: getUrlDepth(seed.pathname),
    maxDepth,
    includePaths: opts.includePaths,
    excludePaths: opts.excludePaths,
    allowBackward: opts.allowBackward,
  }

  const visited = new Set<string>()
  const frontier: { url: string; depth: number }[] = []
  const pages: CrawlPage[] = []
  const denied: CrawlDenied[] = []
  const errors: CrawlError[] = []
  const hostLastFetch = new Map<string, number>()
  const startedAt = Date.now()

  const pushFrontier = (rawLink: string, depth: number): void => {
    let link: URL
    try {
      link = new URL(rawLink)
    } catch {
      denied.push({ url: rawLink, reason: 'non_http' })
      return
    }
    const key = normalizeCacheUrl(rawLink)
    if (visited.has(key) || visited.has(wwwVariant(key))) return
    visited.add(key)
    const reason = filterLink(link, filterOpts)
    if (reason) {
      denied.push({ url: rawLink, reason })
      return
    }
    frontier.push({ url: rawLink, depth })
  }

  // 种子本身不入过滤链（backward 会挡住自己）
  visited.add(normalizeCacheUrl(seedUrl))
  frontier.push({ url: seedUrl, depth: 0 })

  // sitemap 预收集 URL 作为 depth-1 候选（仍过过滤链）
  for (const u of opts.sitemapUrls ?? []) {
    pushFrontier(u, 1)
  }

  const throttle = async (host: string): Promise<void> => {
    const now = Date.now()
    const last = hostLastFetch.get(host) ?? 0
    // 立即占位（读-改-写同步完成）——并发 throttle 按 slot 串行，不会叠在同一时刻
    const slot = Math.max(now, last + minInterval)
    hostLastFetch.set(host, slot)
    const wait = slot - now
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  return await new Promise<CrawlResult>((resolve) => {
    let inFlight = 0
    let settled = false

    const finish = (truncated: boolean): void => {
      if (settled) return
      settled = true
      resolve({ pages, denied, errors, truncated, durationMs: Date.now() - startedAt })
    }

    const pump = (): void => {
      if (settled) return
      const overBudget = Date.now() - startedAt >= budgetMs
      const overPages = pages.length >= maxPages
      const canSchedule = !overBudget && !overPages

      while (canSchedule && inFlight < concurrency && frontier.length > 0 && pages.length + inFlight < maxPages) {
        const item = frontier.shift()!
        inFlight += 1
        void (async () => {
          try {
            let host = ''
            try {
              host = new URL(item.url).hostname.toLowerCase()
            } catch {
              /* 入队时已校验，防御 */
            }
            if (host) await throttle(host)
            const outcome = await fetcher(item.url)
            if (!outcome.ok) {
              errors.push({ url: item.url, error: outcome.error })
            } else {
              pages.push({
                url: item.url,
                depth: item.depth,
                status: outcome.status,
                markdown: outcome.markdown,
                via: outcome.via,
                fromCache: outcome.fromCache,
              })
              if (item.depth < maxDepth) {
                for (const link of outcome.links) {
                  pushFrontier(link, item.depth + 1)
                }
              }
            }
          } catch (err) {
            errors.push({ url: item.url, error: err instanceof Error ? err.message : String(err) })
          } finally {
            inFlight -= 1
            pump()
          }
        })()
      }

      // 收敛：frontier 空 && inFlight==0（等价 jobs==jobs_done）；
      // 或因预算/页数停调且 inFlight 收尾完毕（截断）
      if (inFlight === 0 && (frontier.length === 0 || overBudget || overPages)) {
        finish(frontier.length > 0 || overBudget)
      }
    }

    pump()
  })
}
