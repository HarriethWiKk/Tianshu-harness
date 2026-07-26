import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collectSitemapUrls } from '../sitemap.js'
import type { FetchLike } from '../../net/http-fetch.js'

/** URL → 内容 的静态响应表（未命中返回 404）。 */
function fakeFetch(table: Record<string, string>): FetchLike {
  return ((url: string) => {
    const body = table[url]
    if (body === undefined) {
      return Promise.resolve(new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }))
    }
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } }))
  }) as unknown as FetchLike
}

const OPTS = {}

function publicLookup() {
  return async (_h: string) => ({ address: '93.184.216.34' })
}

describe('collectSitemapUrls', () => {
  it('robots.txt 声明优先，sitemapindex 递归', async () => {
    const fetch = fakeFetch({
      'https://ex.com/robots.txt': 'User-agent: *\nSitemap: https://ex.com/main-sitemap.xml\n',
      'https://ex.com/main-sitemap.xml':
        '<sitemapindex><sitemap><loc>https://ex.com/sub1.xml</loc></sitemap><sitemap><loc>https://ex.com/sub2.xml</loc></sitemap></sitemapindex>',
      'https://ex.com/sub1.xml': '<urlset><url><loc>https://ex.com/a</loc></url></urlset>',
      'https://ex.com/sub2.xml': '<urlset><url><loc>https://ex.com/b</loc></url></urlset>',
    })
    const result = await collectSitemapUrls(new URL('https://ex.com/docs'), { fetch, lookup: publicLookup() }, OPTS)
    assert.deepEqual(result.urls.sort(), ['https://ex.com/a', 'https://ex.com/b'])
    assert.ok(result.sitemapsHit.includes('https://ex.com/main-sitemap.xml'))
    assert.ok(result.sitemapsHit.includes('https://ex.com/sub1.xml'))
  })

  it('robots 缺失时按阶梯回退：种子目录 → origin 根', async () => {
    const fetch = fakeFetch({
      'https://ex.com/docs/sitemap.xml': '<urlset><url><loc>https://ex.com/docs/a</loc></url></urlset>',
      'https://ex.com/sitemap.xml': '<urlset><url><loc>https://ex.com/root</loc></url></urlset>',
    })
    const result = await collectSitemapUrls(new URL('https://ex.com/docs/guide'), { fetch, lookup: publicLookup() }, OPTS)
    assert.deepEqual(result.urls.sort(), ['https://ex.com/docs/a', 'https://ex.com/root'])
  })

  it('404 sitemap 静默跳过，.gz 不处理', async () => {
    const fetch = fakeFetch({
      'https://ex.com/robots.txt': 'Sitemap: https://ex.com/sitemap.xml.gz\nSitemap: https://ex.com/ok.xml\n',
      'https://ex.com/ok.xml': '<urlset><url><loc>https://ex.com/ok</loc></url></urlset>',
    })
    const result = await collectSitemapUrls(new URL('https://ex.com/'), { fetch, lookup: publicLookup() }, OPTS)
    assert.deepEqual(result.urls, ['https://ex.com/ok'])
    assert.ok(!result.sitemapsHit.some((s) => s.endsWith('.gz')))
  })

  it('sitemap 数量上限 25', async () => {
    const table: Record<string, string> = {
      'https://ex.com/robots.txt': '',
      'https://ex.com/sitemap.xml': `<sitemapindex>${Array.from({ length: 30 }, (_, i) => `<sitemap><loc>https://ex.com/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
    }
    for (let i = 0; i < 30; i++) {
      table[`https://ex.com/s${i}.xml`] = `<urlset><url><loc>https://ex.com/p${i}</loc></url></urlset>`
    }
    const result = await collectSitemapUrls(new URL('https://ex.com/'), { fetch: fakeFetch(table), lookup: publicLookup() }, OPTS)
    assert.ok(result.sitemapsHit.length <= 25)
    assert.ok(result.urls.length <= 25)
  })
})
