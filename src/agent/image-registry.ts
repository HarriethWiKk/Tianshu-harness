/**
 * Session-scoped image registry — the vision co-pilot's short-term visual memory.
 *
 * When a user attaches images (or the primary model is multimodal and receives
 * them directly), we register the raw data URLs here under short ids (img_1, …).
 * The `ask_image` tool then lets the main model re-query a retained image any
 * number of times without the user re-sending it.
 *
 * Hard boundaries (prefix-cache + privacy discipline):
 *  - NEVER enters oaiMessages / SessionState / on-disk persistence. Base64 lives
 *    only in this in-memory map for the session's lifetime.
 *  - Capacity-bounded (count + total bytes) with LRU eviction so a long session
 *    full of screenshots can't grow unbounded.
 *  - Per-image description cache keyed by mode/question so repeated asks about the
 *    same image from the same angle cost zero extra vision calls.
 */

/** Parse a `data:image/<mime>;base64,<payload>` URL. Returns null if malformed. */
export function parseImageDataUrl(url: string): { mime: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  if (!m) return null
  return { mime: m[1]!.toLowerCase(), base64: m[2]! }
}

/** Approximate decoded byte size of a base64 data URL payload. */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',')
  if (comma === -1) return url.length
  const b64 = url.slice(comma + 1)
  // 4 base64 chars → 3 bytes, minus padding.
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

export interface RegisteredImage {
  id: string
  dataUrl: string
  mime: string
  bytes: number
  /** Description cache: key = mode/question, value = the vision model's answer. */
  descriptions: Map<string, string>
  /** Monotonic touch counter for LRU. */
  lastUsed: number
}

export interface ImageRegistryOptions {
  /** Max retained images. Oldest-touched evicted first. Default 8. */
  maxImages?: number
  /** Max total retained bytes. Evicts LRU until under budget. Default 24 MiB. */
  maxBytes?: number
}

const DEFAULT_MAX_IMAGES = 8
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024

export class ImageRegistry {
  private readonly images = new Map<string, RegisteredImage>()
  private readonly maxImages: number
  private readonly maxBytes: number
  private seq = 0
  private clock = 0

  constructor(opts: ImageRegistryOptions = {}) {
    this.maxImages = opts.maxImages ?? DEFAULT_MAX_IMAGES
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * Register one or more data URLs. Malformed entries are skipped (not fatal —
   * the caller already validated at the transport boundary; this is defense).
   * Returns the ids assigned to the accepted images, in input order.
   */
  register(dataUrls: string[]): string[] {
    const ids: string[] = []
    for (const url of dataUrls) {
      const parsed = parseImageDataUrl(url)
      if (!parsed) continue
      const id = `img_${++this.seq}`
      this.images.set(id, {
        id,
        dataUrl: url,
        mime: parsed.mime,
        bytes: dataUrlBytes(url),
        descriptions: new Map(),
        lastUsed: ++this.clock,
      })
      ids.push(id)
    }
    this.evictIfNeeded()
    return ids
  }

  /** Fetch a retained image by id, or the most-recently-registered when id is
   *  omitted. Touches LRU. Returns undefined when nothing matches. */
  get(id?: string): RegisteredImage | undefined {
    const img = id ? this.images.get(id) : this.mostRecent()
    if (img) img.lastUsed = ++this.clock
    return img
  }

  /** Cached description for (id, key), if present. Touches LRU on hit. */
  getCachedDescription(id: string, key: string): string | undefined {
    const img = this.images.get(id)
    if (!img) return undefined
    const hit = img.descriptions.get(key)
    if (hit !== undefined) img.lastUsed = ++this.clock
    return hit
  }

  /** Store a description for (id, key). No-op if the image was evicted. */
  cacheDescription(id: string, key: string, text: string): void {
    this.images.get(id)?.descriptions.set(key, text)
  }

  /** Registered images, newest first (for UI / tool hints). */
  list(): RegisteredImage[] {
    return [...this.images.values()].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  get size(): number {
    return this.images.size
  }

  clear(): void {
    this.images.clear()
  }

  private mostRecent(): RegisteredImage | undefined {
    let best: RegisteredImage | undefined
    for (const img of this.images.values()) {
      if (!best || img.lastUsed > best.lastUsed || (img.lastUsed === best.lastUsed && img.id > best.id)) best = img
    }
    return best
  }

  private evictIfNeeded(): void {
    // Evict oldest-touched until within both count and byte budgets.
    const byLru = (): RegisteredImage[] => [...this.images.values()].sort((a, b) => a.lastUsed - b.lastUsed)
    while (this.images.size > this.maxImages) {
      const victim = byLru()[0]
      if (!victim) break
      this.images.delete(victim.id)
    }
    let total = 0
    for (const img of this.images.values()) total += img.bytes
    while (total > this.maxBytes && this.images.size > 0) {
      const victim = byLru()[0]
      if (!victim) break
      total -= victim.bytes
      this.images.delete(victim.id)
    }
  }
}
