/**
 * web_crawl 工具——从种子 URL 整站爬取（BFS 跟随链接 + sitemap 阶梯）。
 * 抓取核复用 web_fetch 的 fetchMarkdown（缓存/渲染降级/链接提取自动生效）。
 * 每页 markdown 汇总为单个 artifact（sections 按页切分），摘要回模型。
 */
import type { Tool, ToolCallParams } from '../types.js'
import type { ArtifactSection } from '../../artifact/types.js'
import type { WebFetchOptions } from '../web-fetch/tool.js'
import { fetchMarkdown, type FetchCoreDeps } from '../web-fetch/fetch-core.js'
import { crawl, type CrawlPage, type CrawlResult } from './crawl.js'
import { DENIAL_REASON_TEXT, type DenialReason } from './filter-links.js'
import { collectSitemapUrls } from './sitemap.js'

const DEFAULT_MAX_PAGES = 20
const MAX_MAX_PAGES = 200
const DEFAULT_MAX_DEPTH = 2
const MAX_MAX_DEPTH = 10
const DEFAULT_BUDGET_MS = 180_000
const MAX_BUDGET_MS = 600_000
const MIN_BUDGET_MS = 10_000
const DENIED_EXAMPLES_CAP = 8

export interface WebCrawlDeps extends FetchCoreDeps {}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.min(max, Math.max(min, n))
}

function compileRegexList(raw: unknown): { regexes: RegExp[] } | { error: string } {
  if (raw === undefined) return { regexes: [] }
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) {
    return { error: '必须是字符串数组' }
  }
  const regexes: RegExp[] = []
  for (const pattern of raw as string[]) {
    try {
      regexes.push(new RegExp(pattern))
    } catch {
      return { error: `无效正则：${pattern}` }
    }
  }
  return { regexes }
}

function parseBudgetMs(input: Record<string, unknown>): number {
  return clampInt(input.budgetMs, DEFAULT_BUDGET_MS, MIN_BUDGET_MS, MAX_BUDGET_MS)
}

function buildCrawlArtifact(pages: CrawlPage[]): { rawContent: string; sections: ArtifactSection[] } {
  const chunks: string[] = []
  const sections: ArtifactSection[] = []
  let lineCursor = 1
  for (const page of pages) {
    const header = `# ${page.url}\n\n`
    const body = `${page.markdown}\n\n---\n\n`
    const text = header + body
    const lines = text.split('\n').length - 1
    sections.push({
      name: page.url,
      lineStart: lineCursor,
      lineEnd: lineCursor + lines - 1,
      charCount: text.length,
    })
    lineCursor += lines
    chunks.push(text)
  }
  return { rawContent: chunks.join(''), sections }
}

function formatCrawlSummary(seedUrl: string, result: CrawlResult, artifactNote: string): string {
  const cached = result.pages.filter((p) => p.fromCache).length
  const lines: string[] = []
  lines.push(
    `爬取完成：${seedUrl}（耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
    `成功 ${result.pages.length} 页（缓存命中 ${cached}）/ 失败 ${result.errors.length} / 跳过 ${result.denied.length} 个候选${result.truncated ? '（已达上限/预算，截断）' : ''}`,
  )
  if (result.pages.length > 0) {
    lines.push('', '页面清单：')
    result.pages.slice(0, 15).forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.url}（${p.status}${p.via}，${p.markdown.length} 字符）`)
    })
    if (result.pages.length > 15) lines.push(`  … 其余 ${result.pages.length - 15} 页见 artifact`)
  }
  if (result.denied.length > 0) {
    const counts = new Map<DenialReason, number>()
    for (const d of result.denied) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1)
    const breakdown = [...counts.entries()].map(([r, n]) => `${DENIAL_REASON_TEXT[r]} ×${n}`).join('、')
    lines.push('', `跳过原因分布：${breakdown}`)
    for (const d of result.denied.slice(0, DENIED_EXAMPLES_CAP)) {
      lines.push(`  - ${d.url}（${DENIAL_REASON_TEXT[d.reason]}）`)
    }
  }
  if (result.errors.length > 0) {
    lines.push('', '失败（前 5）：')
    for (const e of result.errors.slice(0, 5)) {
      lines.push(`  - ${e.url} — ${e.error.split('\n')[0]}`)
    }
  }
  return lines.join('\n') + artifactNote
}

export function createWebCrawlTool(deps: WebCrawlDeps = {}, opts: WebFetchOptions = {}): Tool {
  return {
    definition: {
      name: 'web_crawl',
      description: `从种子 URL 出发整站爬取（BFS 跟随链接 + sitemap 发现），批量获取各页正文。
适合「把这个文档站/知识库读完」。礼貌抓取：并发 4、同域名 300ms 间隔、页数/深度/预算受限；重复页面走缓存。
结果汇总为 artifact（可用 read_section 分页细读）。因发起大量网络请求，需要用户审批。`,
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '种子 URL（只跟随同域名链接）' },
          maxPages: { type: 'number', description: `页数上限（默认 ${DEFAULT_MAX_PAGES}，最大 ${MAX_MAX_PAGES}）` },
          maxDepth: { type: 'number', description: `距种子跳数上限（默认 ${DEFAULT_MAX_DEPTH}，最大 ${MAX_MAX_DEPTH}）` },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description: '正则数组：只抓 pathname+query 命中的页面',
          },
          excludePaths: {
            type: 'array',
            items: { type: 'string' },
            description: '正则数组：跳过 pathname+query 命中的页面',
          },
          allowBackward: { type: 'boolean', description: '允许跳出种子路径之外（默认 false，只抓种子之下）' },
          budgetMs: { type: 'number', description: `总预算 ms（默认 ${DEFAULT_BUDGET_MS}，最大 ${MAX_BUDGET_MS}）` },
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

      const include = compileRegexList(params.input.includePaths)
      if ('error' in include) return { content: `includePaths 参数错误：${include.error}`, isError: true }
      const exclude = compileRegexList(params.input.excludePaths)
      if ('error' in exclude) return { content: `excludePaths 参数错误：${exclude.error}`, isError: true }

      const maxPages = clampInt(params.input.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES)
      const maxDepth = clampInt(params.input.maxDepth, DEFAULT_MAX_DEPTH, 0, MAX_MAX_DEPTH)
      const budgetMs = parseBudgetMs(params.input)

      // sitemap 阶梯预收集（失败不阻塞 crawl）
      let sitemapUrls: string[] | undefined
      try {
        const sm = await collectSitemapUrls(seed, deps, opts)
        sitemapUrls = sm.urls
      } catch {
        sitemapUrls = undefined
      }

      const fetcher = (u: string) => fetchMarkdown(u, deps, { ...opts, cwd: params.cwd })
      const result = await crawl(rawUrl, fetcher, {
        maxPages,
        maxDepth,
        includePaths: include.regexes.length > 0 ? include.regexes : undefined,
        excludePaths: exclude.regexes.length > 0 ? exclude.regexes : undefined,
        allowBackward: params.input.allowBackward === true,
        budgetMs,
        concurrency: 4,
        sitemapUrls,
      })

      // 汇总落 artifact（sections 按页切分，模型可 read_section 分页细读）
      let artifactNote = ''
      if (params.artifactStore && result.pages.length > 0) {
        try {
          const { rawContent, sections } = buildCrawlArtifact(result.pages)
          const id = await params.artifactStore.save({
            tool: 'web_crawl',
            target: rawUrl,
            rawContent,
            summary: `crawl ${rawUrl}：${result.pages.length} 页正文`,
            sections,
          })
          artifactNote = `\n\n完整内容已存 artifact：${id}（可用 read_section 分页细读）`
        } catch {
          artifactNote = '\n\n（artifact 持久化失败，仅返回摘要）'
        }
      }

      return { content: formatCrawlSummary(rawUrl, result, artifactNote) }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    // 预算 + 30s 收尾余量（sitemap 预收集与 artifact 写入）
    timeoutMs: (params) => parseBudgetMs(params?.input ?? {}) + 30_000,
  }
}
