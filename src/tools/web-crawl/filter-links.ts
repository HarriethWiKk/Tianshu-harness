/**
 * filter-links — crawl 链接过滤链（firecrawl filterLinks 原生重写）。
 *
 * 每个被拒 URL 产出结构化 denial reason——crawl 摘要按原因聚合计数，
 * agent 能向用户自述「为什么跳过」（firecrawl denial reason 设计的核心
 * 价值：过滤即数据）。
 */

export type DenialReason =
  | 'non_http'
  | 'cross_domain'
  | 'max_depth'
  | 'excluded_path'
  | 'not_included_path'
  | 'backward_path'
  | 'file_extension'

export const DENIAL_REASON_TEXT: Record<DenialReason, string> = {
  non_http: '非 http(s) 协议',
  cross_domain: '跨域名',
  max_depth: '超过路径深度上限',
  excluded_path: '命中 excludePaths',
  not_included_path: '不在 includePaths 内',
  backward_path: '位于种子路径之外',
  file_extension: '二进制/媒体文件扩展名',
}

/**
 * crawl 无文本价值的扩展名黑名单。当前管线消费不了 pdf/office/媒体/压缩包
 * （web_fetch 对它们返回二进制提示），跟随它们只会浪费一次抓取。
 */
const BLOCKED_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
  'mp4', 'mp3', 'avi', 'mov', 'webm', 'wav', 'flac', 'ogg',
  'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dmg', 'msi', 'apk', 'deb', 'rpm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf',
  'csv', 'parquet', 'db', 'sqlite',
  'wasm', 'so', 'dll', 'dylib', 'jar', 'class',
  'css', 'map',
]

const BLOCKED_EXT_RE = new RegExp(`\\.(${BLOCKED_EXTENSIONS.join('|')})$`, 'i')

/** URL 路径深度 = pathname 段数（firecrawl getURLDepth 同义）。 */
export function getUrlDepth(pathname: string): number {
  return pathname.split('/').filter(Boolean).length
}

export interface LinkFilterOptions {
  /** 种子 hostname（小写）；跨域拒绝。 */
  seedHost: string
  /** 种子 pathname（backward 边界：候选须位于其下）。 */
  seedPath: string
  /** 种子自身深度——绝对深度上限 = seedDepth + maxDepth（firecrawl getAdjustedMaxDepth 同义）。 */
  seedDepth: number
  /** 距种子允许的跳数；同时换算为路径段数上限。 */
  maxDepth: number
  includePaths?: RegExp[]
  excludePaths?: RegExp[]
  allowBackward?: boolean
}

/**
 * 过滤单个候选 URL；返回 null 表示通过，否则为结构化拒绝原因。
 * 顺序与 firecrawl 一致：协议 → 扩展名 → 深度 → exclude → include → backward。
 */
export function filterLink(url: URL, opts: LinkFilterOptions): DenialReason | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'non_http'
  if (url.hostname.toLowerCase() !== opts.seedHost) return 'cross_domain'
  if (BLOCKED_EXT_RE.test(url.pathname)) return 'file_extension'
  if (getUrlDepth(url.pathname) > opts.seedDepth + opts.maxDepth) return 'max_depth'
  const path = url.pathname + url.search
  if (opts.excludePaths?.some((re) => re.test(path))) return 'excluded_path'
  if (opts.includePaths && opts.includePaths.length > 0 && !opts.includePaths.some((re) => re.test(path))) {
    return 'not_included_path'
  }
  if (!opts.allowBackward) {
    // 须位于种子路径之下：种子视为目录（/docs/guide → 允许 /docs/guide/…）
    const seedDir = opts.seedPath.endsWith('/') ? opts.seedPath : `${opts.seedPath}/`
    if (seedDir !== '/' && !url.pathname.startsWith(seedDir)) return 'backward_path'
  }
  return null
}
