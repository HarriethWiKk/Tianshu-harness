/**
 * Token estimation for image parts in multimodal messages.
 *
 * 两处上下文估算（context/rounds.ts、compact/micro.ts）原先都写死 765 token/张。
 * 那个常数不是随手取的：它正好是 1024×1024 方图在分块规则下的结果，所以"每张
 * 765"实际等于"假设每张图都是 1024 方图"。截图不是方的——1280×800 视口是 1105，
 * 整页长图能到 1785，按张数算最多低估 2.3×。低估上下文用量的代价这个仓库已经
 * 付过一次（micro.ts 里 reasoning_content 被漏算 → 压缩系统性偏晚），图是同一个
 * 失效模式：估少了，压缩就晚，晚到撞窗口才补救。
 *
 * 分块规则（OpenAI 视觉计价，其他兼容端点大同小异）：长边先压进 2048，短边再压到
 * 768（只降不升），然后按 512 方格切块，tokens = 85 + 170 × 块数。
 */

/** 尺寸取不到时的退路——等价于旧行为（1024 方图）。 */
export const FALLBACK_IMAGE_TOKENS = 765

const BASE_TOKENS = 85
const TILE_TOKENS = 170
const TILE_SIDE = 512
const MAX_LONG_SIDE = 2048
const NORMALIZED_SHORT_SIDE = 768

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * 按图像尺寸算视觉 token。
 *
 * 校验点：1024×1024 → 765（与旧常数逐位相同，这是它的来源）；1280×800 → 1105。
 */
export function imageTokensForDimensions(dim: ImageDimensions): number {
  const { width, height } = dim
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return FALLBACK_IMAGE_TOKENS
  }

  // 只降不升：短边本就不足 768 的图（窄长条整页截图）不该被上采样成更多块——
  // 上采样不增加信息，供应商实现也只降采样。
  const fit = Math.min(1, MAX_LONG_SIDE / Math.max(width, height))
  const fitW = width * fit
  const fitH = height * fit
  const norm = Math.min(1, NORMALIZED_SHORT_SIDE / Math.min(fitW, fitH))
  const w = fitW * norm
  const h = fitH * norm

  // 减 epsilon 再 ceil：768/512 这类比值经两次浮点缩放后可能落在 1.5000000000000002，
  // 直接 ceil 会凭空多切一整行块。
  const tiles = ceilTiles(w) * ceilTiles(h)
  return BASE_TOKENS + TILE_TOKENS * tiles
}

function ceilTiles(side: number): number {
  return Math.max(1, Math.ceil(side / TILE_SIDE - 1e-9))
}

/**
 * 估一个 `image_url` part 的 token。取不到尺寸就退回 {@link FALLBACK_IMAGE_TOKENS}。
 *
 * 只解析 PNG 头：截图路径（browser_debug / computer_use）全是 PNG，而其他格式各有
 * 一套头部扫描（JPEG 要跨 EXIF 找 SOF、WebP 有三种 chunk 变体），换来的精度提升很小
 * ——短边归一化会把大尺寸照片压到 765~1105 区间，本来就贴着退路值。
 *
 * 必须是 O(1)：这个函数在每次压缩检查里被逐消息调用，而 data URL 可达数 MB。
 * 只 base64-decode 头部 32 个字符，不碰载荷。
 */
export function estimateImageTokens(url: string): number {
  const dim = decodeImageDimensions(url)
  return dim ? imageTokensForDimensions(dim) : FALLBACK_IMAGE_TOKENS
}

/** PNG data URL 的像素尺寸；非 PNG / 非 data URL / 头部残缺 → null。 */
export function decodeImageDimensions(url: string): ImageDimensions | null {
  const comma = url.indexOf(',')
  if (comma < 0 || !url.startsWith('data:')) return null
  if (!url.slice(0, comma).includes('base64')) return null

  // IHDR 宽高落在第 16–24 字节，24 字节 = 32 个 base64 字符（4:3 编码比，无 padding）。
  const head = url.slice(comma + 1, comma + 1 + 32)
  if (head.length < 32) return null

  let buf: Buffer
  try {
    buf = Buffer.from(head, 'base64')
  } catch {
    return null
  }
  if (buf.length < 24) return null
  // 签名 + IHDR 块名——两者都对才敢把后 8 字节当宽高读。
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(12) !== 0x49484452) return null

  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}
