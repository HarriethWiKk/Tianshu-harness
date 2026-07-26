/**
 * fetch-cache — web_fetch 的 maxAge 缓存（firecrawl「缓存即引擎」语义原生重写）。
 *
 * 语义：
 *   - 命中在降级链最前端直接返回，不发起任何请求——agent 重复读文档站是最大
 *     的 token 成本，缓存是最大单项节省
 *   - key = normalizeURL(url) + variant（extractMainContent 等改变产出的开关）
 *   - 只写成功（markdown 达实质阈值）：失败永不覆盖好条目（「宁旧勿错」简化版）
 *   - maxAgeMs: 0 = 禁读（仍写，后续调高可复活）；惰性清扫过期条目
 *
 * 存储为 <cwd>/.rivet/cache/web-fetch/<sha256(key)>.json——文件式、无 sqlite
 * 依赖；缓存永远 best-effort，任何 IO 失败都静默降级为 miss。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_CACHE_MAX_AGE_MS = 2 * 24 * 60 * 60_000 // 2 天

/** 每 N 次写入触发一次过期清扫。 */
const SWEEP_EVERY_N_WRITES = 20

export interface FetchCacheEntry {
  url: string
  markdown: string
  /** 抓取路径标记（直连/渲染/Jina），命中时透传给用户。 */
  via: string
  status: number
  fetchedAt: number
}

export interface FetchCacheOptions {
  /** 读取有效期 ms（默认 2 天）；0 = 禁读（仍写）。 */
  maxAgeMs?: number
  /** 测试注入时钟。 */
  now?: () => number
}

/** URL 规范化：小写 host、去默认端口、去非 SPA hash（保留 #/ 与 #!/ 路由）、保留 query。 */
export function normalizeCacheUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.hostname = u.hostname.toLowerCase()
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = ''
    }
    if (u.hash && !u.hash.startsWith('#/') && !u.hash.startsWith('#!/')) u.hash = ''
    return u.toString()
  } catch {
    return rawUrl
  }
}

export class FetchCache {
  private writesSinceSweep = 0
  private readonly maxAgeMs: number
  private readonly now: () => number

  constructor(
    private readonly dir: string,
    opts: FetchCacheOptions = {},
  ) {
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS
    this.now = opts.now ?? Date.now
  }

  private key(url: string, variant: string): string {
    return createHash('sha256').update(`${normalizeCacheUrl(url)}\n${variant}`).digest('hex')
  }

  async read(url: string, variant: string): Promise<FetchCacheEntry | undefined> {
    if (this.maxAgeMs === 0) return undefined // maxAge:0 禁读
    try {
      const raw = await readFile(join(this.dir, `${this.key(url, variant)}.json`), 'utf8')
      const entry = JSON.parse(raw) as FetchCacheEntry
      if (typeof entry.fetchedAt !== 'number' || typeof entry.markdown !== 'string') return undefined
      if (entry.fetchedAt + this.maxAgeMs < this.now()) return undefined // 过期
      return entry
    } catch {
      return undefined
    }
  }

  async write(url: string, variant: string, entry: Omit<FetchCacheEntry, 'fetchedAt'>): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      const full: FetchCacheEntry = { ...entry, fetchedAt: this.now() }
      await writeFile(join(this.dir, `${this.key(url, variant)}.json`), JSON.stringify(full))
      this.writesSinceSweep += 1
      if (this.writesSinceSweep >= SWEEP_EVERY_N_WRITES) {
        this.writesSinceSweep = 0
        void this.sweep().catch(() => {})
      }
    } catch {
      /* 缓存永远 best-effort——写失败降级为下次 miss */
    }
  }

  /** 清理过期条目（按 entry.fetchedAt 判定，与 read 的 TTL 语义严格一致；损坏条目一并清理）。 */
  async sweep(): Promise<void> {
    const now = this.now()
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      try {
        const raw = await readFile(path, 'utf8')
        const entry = JSON.parse(raw) as FetchCacheEntry
        if (typeof entry.fetchedAt !== 'number' || entry.fetchedAt + this.maxAgeMs < now) {
          await rm(path, { force: true })
        }
      } catch {
        // 解析失败的损坏条目一并清理
        await rm(path, { force: true }).catch(() => {})
      }
    }
  }
}

export function fetchCacheDir(cwd: string): string {
  return join(cwd, '.rivet', 'cache', 'web-fetch')
}

/** 进程级缓存实例（按目录单例——保证写入计数/清扫节流在调用间累积）。 */
const caches = new Map<string, FetchCache>()

export function getFetchCache(cwd: string, opts: FetchCacheOptions = {}): FetchCache {
  const dir = fetchCacheDir(cwd)
  let cache = caches.get(dir)
  if (!cache) {
    cache = new FetchCache(dir, opts)
    caches.set(dir, cache)
  }
  return cache
}

/** Test hook: drop singletons (避免跨用例串目录状态)。 */
export function __resetFetchCacheForTest(): void {
  caches.clear()
}

/** 人性化时长：N 分钟/小时/天前。 */
export function formatCacheAge(fetchedAt: number, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - fetchedAt) / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}
