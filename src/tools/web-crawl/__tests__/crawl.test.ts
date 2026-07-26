import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { crawl, type CrawlFetcher } from '../crawl.js'
import type { FetchMarkdownOutcome } from '../../web-fetch/fetch-core.js'

/** 静态站点图 fake fetcher。 */
function graphFetcher(graph: Record<string, { links?: string[]; markdown?: string; delayMs?: number }>): CrawlFetcher {
  return async (url) => {
    const node = graph[url]
    if (node?.delayMs) await new Promise((r) => setTimeout(r, node.delayMs))
    if (!node) return { ok: false, error: `HTTP 404：${url}` }
    return {
      ok: true,
      status: 200,
      markdown: node.markdown ?? `内容 ${url}`,
      via: '',
      links: node.links ?? [],
      rawBytes: 100,
      fromCache: false,
    } satisfies FetchMarkdownOutcome
  }
}

const SITE = {
  'https://ex.com/': {
    links: [
      'https://ex.com/a',
      'https://ex.com/b',
      'https://other.com/ext', // cross_domain
      'https://ex.com/logo.png', // file_extension
      'mailto:x@y.z', // non_http
    ],
  },
  'https://ex.com/a': { links: ['https://ex.com/b', 'https://ex.com/a/child'] },
  'https://ex.com/b': { links: ['https://www.ex.com/a'] }, // www 变体（应去重）
  'https://ex.com/a/child': { links: [] },
}

describe('crawl（进程内 BFS）', () => {
  it('基本遍历 + 去重 + www 变体去重 + 结构化拒绝', async () => {
    const result = await crawl('https://ex.com/', graphFetcher(SITE), { maxDepth: 3, minIntervalPerHostMs: 0 })
    const urls = result.pages.map((p) => p.url)
    assert.deepEqual(urls.sort(), [
      'https://ex.com/',
      'https://ex.com/a',
      'https://ex.com/a/child',
      'https://ex.com/b',
    ])
    assert.equal(result.truncated, false)
    const reasons = new Map(result.denied.map((d) => [d.reason, d.url]))
    assert.equal(reasons.get('cross_domain'), 'https://other.com/ext')
    assert.equal(reasons.get('file_extension'), 'https://ex.com/logo.png')
    assert.equal(reasons.get('non_http'), 'mailto:x@y.z')
    // www 变体被静默去重（不进 pages 也不进 denied）
    assert.ok(!result.pages.some((p) => p.url.includes('www.')))
    assert.ok(!result.denied.some((d) => d.url.includes('www.')))
    assert.equal(result.errors.length, 0)
  })

  it('maxDepth 限制跳数（depth 1 的链接不再跟随）', async () => {
    const result = await crawl('https://ex.com/', graphFetcher(SITE), { maxDepth: 1, minIntervalPerHostMs: 0 })
    const urls = result.pages.map((p) => p.url)
    assert.ok(!urls.includes('https://ex.com/a/child'))
    assert.ok(urls.includes('https://ex.com/a'))
    assert.ok(urls.includes('https://ex.com/b'))
  })

  it('maxPages 截断并标记 truncated', async () => {
    const result = await crawl('https://ex.com/', graphFetcher(SITE), {
      maxPages: 2,
      maxDepth: 3,
      minIntervalPerHostMs: 0,
    })
    assert.equal(result.pages.length, 2)
    assert.equal(result.truncated, true)
  })

  it('预算到期截断（等 inFlight 收尾）', async () => {
    const slow = {
      'https://ex.com/': { delayMs: 60, links: ['https://ex.com/a', 'https://ex.com/b'] },
      'https://ex.com/a': { links: [] },
      'https://ex.com/b': { links: [] },
    }
    // seed 抓取耗时 60ms > 预算 30ms——seed 完成后预算必到期，不再调度新页
    const result = await crawl('https://ex.com/', graphFetcher(slow), {
      budgetMs: 30,
      minIntervalPerHostMs: 0,
    })
    assert.equal(result.pages.length, 1)
    assert.equal(result.truncated, true)
  })

  it('同 host 限速间隔生效', async () => {
    const site = {
      'https://ex.com/': { links: ['https://ex.com/a', 'https://ex.com/b'] },
      'https://ex.com/a': { links: [] },
      'https://ex.com/b': { links: [] },
    }
    const timestamps: number[] = []
    const result = await crawl(
      'https://ex.com/',
      async (url) => {
        timestamps.push(Date.now())
        return graphFetcher(site)(url)
      },
      { minIntervalPerHostMs: 300, maxDepth: 1 },
    )
    assert.equal(result.pages.length, 3)
    const sorted = [...timestamps].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i]! - sorted[i - 1]! >= 250, `间隔应 ≥250ms（实际 ${sorted[i]! - sorted[i - 1]!}ms）`)
    }
  })

  it('sitemapUrls 作为 depth-1 候选（仍过过滤链）', async () => {
    const site = {
      'https://ex.com/': { links: [] },
      'https://ex.com/from-sitemap': { links: [] },
    }
    const result = await crawl('https://ex.com/', graphFetcher(site), {
      sitemapUrls: ['https://ex.com/from-sitemap', 'https://ex.com/sitemap.png'],
      minIntervalPerHostMs: 0,
    })
    const urls = result.pages.map((p) => p.url)
    assert.ok(urls.includes('https://ex.com/from-sitemap'))
    assert.ok(result.denied.some((d) => d.url === 'https://ex.com/sitemap.png' && d.reason === 'file_extension'))
  })

  it('抓取失败进 errors 不影响其余页面', async () => {
    const site = { 'https://ex.com/': { links: ['https://ex.com/missing', 'https://ex.com/a'] }, 'https://ex.com/a': { links: [] } }
    const result = await crawl('https://ex.com/', graphFetcher(site), { minIntervalPerHostMs: 0 })
    assert.ok(result.pages.some((p) => p.url === 'https://ex.com/a'))
    assert.equal(result.errors.length, 1)
    assert.ok(result.errors[0]!.url === 'https://ex.com/missing')
  })
})
