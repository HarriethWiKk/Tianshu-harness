/**
 * map — web_map 的 URL 发现逻辑（firecrawl /map 原生重写）。
 *
 * 三路来源汇合：
 *   1. sitemap 阶梯（collectSitemapUrls）
 *   2. 种子页链接（fetchMarkdown.links）
 *   3. `site:host` 搜索（search 参数存在时，复用 web_search 后端链）
 * 过滤：同域 → 可选子域 → filterByPath（种子含非根 path 才前缀过滤）→ 去重。
 * search 存在时纯词频 cosine 重排（无 embedding，firecrawl map-cosine 同款）。
 */

export interface MapCandidate {
  url: string
  title?: string
  sources: Set<'sitemap' | 'page' | 'search'>
}

/** 同域/子域判定。 */
export function isSameOrSubDomain(hostname: string, seedHost: string, includeSubdomains: boolean): boolean {
  if (hostname === seedHost) return true
  return includeSubdomains && hostname.endsWith(`.${seedHost}`)
}

/** 种子含非根 path 时只保留该前缀下的 URL（firecrawl filterByPath 同义）。 */
export function filterByPathPrefix(url: string, seedPath: string): boolean {
  if (!seedPath || seedPath === '/') return true
  const dir = seedPath.endsWith('/') ? seedPath : `${seedPath}/`
  try {
    return new URL(url).pathname.startsWith(dir)
  } catch {
    return false
  }
}

// ─── 词频 cosine（firecrawl map-cosine.ts 同款：无 embedding，URL 字符串词频）───

function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (token.length < 2) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const v of a.values()) normA += v * v
  for (const v of b.values()) normB += v * v
  if (normA === 0 || normB === 0) return 0
  for (const [k, v] of a) {
    const bv = b.get(k)
    if (bv) dot += v * bv
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 有 search 词时按词频 cosine 降序重排（零分排后，保持原相对顺序）。 */
export function rerankByCosine<T extends { url: string }>(items: T[], search: string): T[] {
  const queryVec = tokenize(search)
  return items
    .map((item, index) => ({ item, index, score: cosineSim(queryVec, tokenize(item.url)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item)
}

export class MapCollector {
  private readonly candidates = new Map<string, MapCandidate>()

  add(url: string, source: 'sitemap' | 'page' | 'search', title?: string): void {
    const existing = this.candidates.get(url)
    if (existing) {
      existing.sources.add(source)
      if (title && !existing.title) existing.title = title
      return
    }
    this.candidates.set(url, { url, title, sources: new Set([source]) })
  }

  list(): MapCandidate[] {
    return [...this.candidates.values()]
  }
}
