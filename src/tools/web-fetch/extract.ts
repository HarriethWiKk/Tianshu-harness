/**
 * extract — HTML → Markdown 转换管线（firecrawl 质量工程的原生重写）。
 *
 * 分层结构：
 *   1. extractMainContent —— 正向提取 <main>/<article>（命中即最干净）
 *   2. turndown 规则层 —— 反向清洗：onlyMainContent 黑名单（forceInclude 子树
 *      豁免，选择器清单来自 firecrawl removeUnwantedElements.ts 实战清单）、
 *      图片修复（srcset 取最大档 / data-src 懒加载回退 / 绝对化 / base64 占位）、
 *      链接绝对化（<base href> 感知，回退页面 URL）
 *   3. postProcessMarkdown —— 链接文本内换行转义（防多行链接断裂，跳过代码围栏）、
 *      删 skip-to-content 无障碍链接、折叠多余空行
 *   4. htmlToMarkdownSmart —— 主内容提空（< 200 字符）自动回退全量转换
 *
 * turndown 每调用新建实例：规则闭包携带 baseUrl，并发安全（web_fetch 是
 * concurrency-safe 工具，单例 + 可变 base 会在并发抓取间串扰）。
 */

let _TurndownCtor: any = null

async function loadTurndownCtor(): Promise<any> {
  if (!_TurndownCtor) {
    const { default: TurndownService } = await import('turndown')
    _TurndownCtor = TurndownService
  }
  return _TurndownCtor
}

/** 实质内容最小长度：低于此视为提取失败/错误壳（与 isJinaQualityHeuristic 同阈值）。 */
export const MIN_SUBSTANTIAL_LENGTH = 200

// ─── A1: onlyMainContent 黑名单（firecrawl excludeNonMainTags 实战清单）───────

const EXCLUDE_NON_MAIN_SELECTORS = [
  'header', 'footer', 'nav', 'aside',
  '.header', '.top', '.navbar', '#header', '.footer', '.bottom', '#footer',
  '.sidebar', '.side', '.aside', '#sidebar',
  '.modal', '.popup', '#modal', '.overlay',
  '.ad', '.ads', '.advert', '#ad',
  '.lang-selector', '.language', '#language-selector',
  '.social', '.social-media', '.social-links', '#social',
  '.menu', '.navigation', '#nav',
  '.breadcrumbs', '#breadcrumbs',
  '.share', '#share',
  '.widget', '#widget',
  '.cookie', '#cookie',
]

/** 命中这些选择器的子树豁免黑名单清除（firecrawl 同语义，取其通用部分）。 */
const FORCE_INCLUDE_SELECTORS = ['#main', '#content']

function safeMatches(node: any, selector: string): boolean {
  try {
    return node.matches(selector)
  } catch {
    return false
  }
}

function safeClosest(node: any, selector: string): boolean {
  try {
    return node.closest(selector) !== null
  } catch {
    return false
  }
}

// ─── A3: 图片 srcset / 懒加载修复 ────────────────────────────────────────────

/** srcset 候选取最大档（w 描述符优先，x 描述符 ×1000 归一；含 1x/无描述符候选时把 src 纳入竞争）。 */
function pickBestSrcsetCandidate(srcset: string, src: string | null): string | undefined {
  const candidates: { url: string; score: number }[] = []
  let hasLowRes = false
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/)
    const url = bits[0]
    if (!url) continue
    const desc = bits[1] ?? ''
    let score = 1
    if (desc.endsWith('w')) score = parseFloat(desc) || 1
    else if (desc.endsWith('x')) score = (parseFloat(desc) || 1) * 1000
    else hasLowRes = true
    if (score <= 1000) hasLowRes = true
    candidates.push({ url, score })
  }
  if (src && hasLowRes) candidates.push({ url: src, score: 1000 })
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.url
}

function pickImageSource(el: any): string | undefined {
  const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset')
  if (srcset) {
    const best = pickBestSrcsetCandidate(srcset, el.getAttribute('src'))
    if (best) return best
  }
  // 懒加载占位图回退：data-src 优先于 src（src 常是 1px 占位）
  return el.getAttribute('data-src') || el.getAttribute('src') || undefined
}

// ─── A3: 链接/图片绝对化（<base href> 感知）──────────────────────────────────

function absolutizeUrl(url: string, base: string | undefined): string | undefined {
  if (!base || /^(data|blob|about):/i.test(url)) return undefined
  try {
    return new URL(url, base).href
  } catch {
    return undefined
  }
}

/**
 * 从原始 HTML 提取 <a href> 链接并绝对化（crawl 发现源）。
 * 必须在转换/黑名单清洗之前提取——sidebar/menu 里的文档目录链接会被
 * onlyMainContent 剔除，markdown 层再提就丢了。
 */
export function extractLinks(html: string, pageUrl?: string): string[] {
  const base = resolveBaseUrl(html, pageUrl)
  const links = new Set<string>()
  const re = /<a\b[^>]*?href=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1]!.trim()
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue
    const abs = absolutizeUrl(href, base)
    if (abs && (abs.startsWith('http:') || abs.startsWith('https:'))) links.add(abs)
  }
  return [...links]
}

/** 从 markdown 提取绝对链接（缓存命中 / Jina 路径的 crawl 发现源）。 */
export function extractLinksFromMarkdown(markdown: string): string[] {
  const links = new Set<string>()
  const re = /\]\((https?:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    links.add(m[1]!)
  }
  return [...links]
}

/** <base href> 只存在于 <head>，窗口扫描即可；base 本身可为相对地址，按页面 URL 解析。 */
function resolveBaseUrl(html: string, pageUrl: string | undefined): string | undefined {
  const headWindow = html.slice(0, 16_384)
  const baseHref = headWindow.match(/<base\b[^>]*?href=["']([^"']+)["']/i)?.[1]
  if (baseHref) {
    try {
      return pageUrl ? new URL(baseHref, pageUrl).href : baseHref
    } catch {
      return baseHref
    }
  }
  return pageUrl
}

// ─── A4: markdown 后处理 ─────────────────────────────────────────────────────

function postProcessMarkdown(md: string): string {
  // 1) 链接文本内换行转义（markdown 多行链接会断裂成两个链接）。
  //    跟踪未转义 [ ] 配对深度；代码围栏内的 [ ] 是代码，跳过。
  let out = ''
  let depth = 0
  let inFence = false
  for (let i = 0; i < md.length; i++) {
    const ch = md[i]!
    if (ch === '`' && md.startsWith('```', i)) {
      inFence = !inFence
      out += '```'
      i += 2
      continue
    }
    if (!inFence) {
      const prev = i > 0 ? md[i - 1] : ''
      if (ch === '[' && prev !== '\\') depth++
      else if (ch === ']' && prev !== '\\' && depth > 0) depth--
      else if (ch === '\n' && depth > 0) {
        out += '\\\n'
        continue
      }
    }
    out += ch
  }
  // 2) 删无障碍跳转链接（skip-to-content 系）
  out = out.replace(/\[ *skip to (?:main )?content *\]\([^)]*\) *\n?/gi, '')
  // 3) 保险：markdown 层残留 base64 图（img 规则已拦截，双保险）
  out = out.replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '<Base64-Image-Removed>')
  // 4) 折叠 3+ 连续换行
  out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

// ─── turndown 装配 ───────────────────────────────────────────────────────────

async function createTurndown(baseUrl: string | undefined): Promise<any> {
  const TurndownService = await loadTurndownCtor()
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  })
  // 无条件剥离（firecrawl 同：head/meta 层 + 脚本样式 + 惰性容器）
  td.remove(['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head'])

  // A1: onlyMainContent 黑名单清除（forceInclude 子树豁免）
  td.addRule('excludeNonMain', {
    filter: (node: any) =>
      node.nodeType === 1 &&
      EXCLUDE_NON_MAIN_SELECTORS.some((sel) => safeMatches(node, sel)) &&
      !FORCE_INCLUDE_SELECTORS.some((sel) => safeClosest(node, sel)),
    replacement: () => '',
  })

  // A3a: 图片修复——srcset 最大档 / data-src 回退 / base64 占位 / 绝对化
  td.addRule('imageFix', {
    filter: 'img',
    replacement: (_content: string, node: any) => {
      const src = pickImageSource(node)
      if (!src) return ''
      if (src.startsWith('data:')) return '<Base64-Image-Removed>'
      const abs = absolutizeUrl(src, baseUrl) ?? src
      const alt = (node.getAttribute('alt') || '').replace(/[[\]]/g, '').trim()
      return `![${alt}](${abs})`
    },
  })

  // A3b: 链接绝对化（锚点/协议链接直接还原文本；skip-to-content 无障碍链接丢弃）
  td.addRule('absolutizeLink', {
    filter: 'a',
    replacement: (content: string, node: any) => {
      const href: string | null = node.getAttribute('href')
      const text = content.trim()
      if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) {
        if (href?.startsWith('#') && /skip to/i.test(text)) return ''
        return text || ''
      }
      const final = absolutizeUrl(href, baseUrl) ?? href
      if (!text) return final
      const title: string | null = node.getAttribute('title')
      return title ? `[${text}](${final} "${title}")` : `[${text}](${final})`
    },
  })

  return td
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

export interface HtmlToMarkdownOptions {
  /** 页面 URL：链接/图片绝对化的回退 base（<base href> 优先于它）。 */
  pageUrl?: string
}

export async function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): Promise<string> {
  const td = await createTurndown(resolveBaseUrl(html, opts.pageUrl))
  return postProcessMarkdown(td.turndown(html))
}

export interface SmartConvertOptions extends HtmlToMarkdownOptions {
  /** 主内容提取开关（对应 config fetch.extractMainContent，默认 true）。 */
  onlyMainContent?: boolean
}

/**
 * 智能转换：先正向提取 <main>/<article> 转换，产出过薄（< 200 字符）自动
 * 回退全量文档转换——SPA div 布局没有 <main>/<article> 时正向提取必然提空，
 * 黑名单规则在两种路径上都生效（firecrawl transformers 同款「提空回退」）。
 */
export async function htmlToMarkdownSmart(html: string, opts: SmartConvertOptions = {}): Promise<string> {
  if (opts.onlyMainContent !== false) {
    const md = await htmlToMarkdown(extractMainContent(html), opts)
    if (md.trim().length >= MIN_SUBSTANTIAL_LENGTH) return md
  }
  return htmlToMarkdown(html, opts)
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = detectCharset(bytes, contentType)
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

function detectCharset(bytes: Uint8Array, contentType: string): string {
  const header = contentType
    .match(/charset=([^;]+)/i)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  if (header) return header.toLowerCase()

  if (contentType.includes('text/html')) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024))
    const meta = head.match(/<meta[^>]+charset=["']?([^"';>\s]+)/i)?.[1]
    if (meta) return meta.toLowerCase()
  }

  return 'utf-8'
}

const NOISE_TAGS = ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside']

export function extractMainContent(html: string): string {
  const region = extractRegion(html, 'main') ?? extractRegion(html, 'article')
  const source = region ?? html

  const noisePattern = new RegExp(`<(${NOISE_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'gi')
  const stripped = source.replace(noisePattern, '')
  return stripped.trim()
}

function extractRegion(html: string, tag: string): string | undefined {
  const openRegex = new RegExp(`<${tag}\\b[^>]*>`, 'i')
  const openMatch = html.match(openRegex)
  if (!openMatch) return undefined

  const start = openMatch.index! + openMatch[0].length
  const openScanner = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  const closeScanner = new RegExp(`</${tag}>`, 'gi')

  let depth = 1
  let idx = start
  while (depth > 0) {
    openScanner.lastIndex = idx
    closeScanner.lastIndex = idx
    const nextOpen = openScanner.exec(html)
    const nextClose = closeScanner.exec(html)
    if (!nextClose) return undefined

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++
      idx = nextOpen.index + nextOpen[0].length
    } else {
      depth--
      if (depth === 0) return html.slice(start, nextClose.index)
      idx = nextClose.index + nextClose[0].length
    }
  }

  return undefined
}
