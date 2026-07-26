/**
 * web_map 工具——站点 URL 发现（sitemap 阶梯 + 种子页链接 + site: 搜索三路）。
 * 轻量：只抓种子页与 sitemap，不爬全站。
 */
import type { Tool, ToolCallParams } from '../types.js'
import type { WebFetchOptions } from '../web-fetch/tool.js'
import { fetchMarkdown, type FetchCoreDeps } from '../web-fetch/fetch-core.js'
import { runBackendChain } from '../web-search/chain.js'
import type { SearchBackend } from '../web-search/types.js'
import { collectSitemapUrls } from './sitemap.js'
import { filterByPathPrefix, isSameOrSubDomain, MapCollector, rerankByCosine } from './map.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 5_000
const SEARCH_TIMEOUT_MS = 15_000

export interface WebMapDeps extends FetchCoreDeps {
  /** site: 搜索后端链（注册表 searchBackends 通道注入；缺省时跳过搜索源）。 */
  searchBackends?: SearchBackend[]
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

export function createWebMapTool(deps: WebMapDeps = {}, opts: WebFetchOptions = {}): Tool {
  return {
    definition: {
      name: 'web_map',
      description: `发现站点内的 URL 清单（sitemap + 种子页链接 + site: 搜索三路汇合）。
适合「先看看这个站有哪些页面」或为 web_crawl 探路。轻量：不爬全站。
因发起网络请求，需要用户审批。`,
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '站点 URL（建议给 base domain 效果更好）' },
          search: { type: 'string', description: '可选关键词：触发 site:host 搜索并按相关度重排结果' },
          limit: { type: 'number', description: `返回条数上限（默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}）` },
          includeSubdomains: { type: 'boolean', description: '包含子域名（默认 false，只同域名）' },
        },
        required: ['url'],
      },
    },

    async execute(params: ToolCallParams) {
      const rawUrl = params.input.url as string
      let seed: URL
      try {
        seed = new URL(rawUrl)
      } catch {
        return { content: `无效 URL：${rawUrl}`, isError: true }
      }
      if (seed.protocol !== 'http:' && seed.protocol !== 'https:') {
        return { content: `不支持的协议：${seed.protocol}。仅允许 http 和 https。`, isError: true }
      }

      const search = typeof params.input.search === 'string' ? params.input.search.trim() : ''
      const limit = clampLimit(params.input.limit)
      const includeSubdomains = params.input.includeSubdomains === true
      const seedHost = seed.hostname.toLowerCase()

      const collector = new MapCollector()
      const sourceStats = { sitemap: 0, page: 0, search: 0 }

      // 来源 1：sitemap 阶梯（失败静默）
      try {
        const sm = await collectSitemapUrls(seed, deps, opts)
        for (const u of sm.urls) collector.add(u, 'sitemap')
      } catch {
        /* sitemap 不可得不阻塞其余来源 */
      }

      // 来源 2：种子页链接
      const seedOutcome = await fetchMarkdown(rawUrl, deps, { ...opts, cwd: params.cwd })
      if (seedOutcome.ok) {
        for (const link of seedOutcome.links) collector.add(link, 'page')
      }

      // 来源 3：site: 搜索（仅给关键词时）
      let searchBackend: string | null = null
      if (search && deps.searchBackends && deps.searchBackends.length > 0) {
        try {
          const chain = await runBackendChain(deps.searchBackends, `${search} site:${seedHost}`, limit, SEARCH_TIMEOUT_MS)
          searchBackend = chain.backend
          for (const r of chain.results) collector.add(r.url, 'search', r.title)
        } catch {
          /* 搜索失败不阻塞其余来源 */
        }
      }

      // 过滤：同域/子域 → filterByPath → 排序截断
      const filtered = collector.list().filter((c) => {
        try {
          const host = new URL(c.url).hostname.toLowerCase()
          return isSameOrSubDomain(host, seedHost, includeSubdomains) && filterByPathPrefix(c.url, seed.pathname)
        } catch {
          return false
        }
      })
      for (const c of filtered) {
        if (c.sources.has('sitemap')) sourceStats.sitemap += 1
        if (c.sources.has('page')) sourceStats.page += 1
        if (c.sources.has('search')) sourceStats.search += 1
      }
      const ranked = search ? rerankByCosine(filtered, search) : filtered
      const results = ranked.slice(0, limit)

      const lines: string[] = []
      lines.push(
        `站点地图：${rawUrl}（共 ${results.length} 个 URL${ranked.length > limit ? `，已按 limit=${limit} 截断` : ''}）`,
        `来源分布：sitemap ×${sourceStats.sitemap}、种子页链接 ×${sourceStats.page}${search ? `、搜索 ×${sourceStats.search}（${searchBackend ?? '无可用后端'}）` : ''}`,
        '',
      )
      for (const r of results) {
        lines.push(r.title ? `${r.url} — ${r.title}` : r.url)
      }
      if (results.length <= 1 && seed.pathname !== '/') {
        lines.push(
          '',
          `⚠ 只找到 ${results.length} 个结果——建议改用 base domain（${seed.origin}）作为 url 再试，sitemap 与链接发现通常更全。`,
        )
      }
      if (results.length === 0) {
        return { content: lines.join('\n'), isError: false }
      }
      return { content: lines.join('\n') }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}
