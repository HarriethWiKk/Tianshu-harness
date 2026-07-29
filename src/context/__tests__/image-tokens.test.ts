import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeImageDimensions,
  estimateImageTokens,
  imageTokensForDimensions,
  FALLBACK_IMAGE_TOKENS,
} from '../image-tokens.js'

/** 造一个只有合法 PNG 头的 data URL——估算只读头 24 字节，无需真实像素数据。 */
function pngDataUrl(width: number, height: number): string {
  const buf = Buffer.alloc(24)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.writeUInt32BE(0x49484452, 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return `data:image/png;base64,${buf.toString('base64')}`
}

describe('imageTokensForDimensions', () => {
  test('1024 方图 = 765，与被替换掉的硬编码常数逐位相同', () => {
    // 这条是回归锚：765 的来源就是 1024 方图，新算法必须在这一点上与旧行为重合，
    // 否则"修正失真"就变成了"换了个不同的错"。
    assert.equal(imageTokensForDimensions({ width: 1024, height: 1024 }), 765)
  })

  test('1280×800 视口截图 = 1105，旧算法低估 44%', () => {
    assert.equal(imageTokensForDimensions({ width: 1280, height: 800 }), 1105)
  })

  test('整页长图按块数增长，不再与视口图同价', () => {
    const viewport = imageTokensForDimensions({ width: 1280, height: 800 })
    const fullPage = imageTokensForDimensions({ width: 1280, height: 4000 })
    assert.ok(fullPage > viewport, `整页图 ${fullPage} 应高于视口图 ${viewport}`)
    // 长边压进 2048 → 655×2048，短边 655 不足 768 不上采样 → 2×4 块。
    assert.equal(fullPage, 85 + 170 * 8)
  })

  test('短边不足 768 的窄图不被上采样成更多块', () => {
    // 400×600：两次缩放都不生效，直接切块 1×2。上采样会凭空多算一倍。
    assert.equal(imageTokensForDimensions({ width: 400, height: 600 }), 85 + 170 * 2)
  })

  test('超大图收敛：短边归一化后与 1024 方图同一量级', () => {
    // 12MP 手机照片 4032×3024 → 归一化到 1024×768 → 4 块 → 与 765 重合。
    assert.equal(imageTokensForDimensions({ width: 4032, height: 3024 }), 765)
  })

  test('浮点边界不多切一行块', () => {
    // 768 恰好是 1.5 个 tile；两次浮点缩放后若 ceil 前不减 epsilon，会切成 3 行。
    assert.equal(imageTokensForDimensions({ width: 768, height: 768 }), 85 + 170 * 4)
    assert.equal(imageTokensForDimensions({ width: 1536, height: 1536 }), 85 + 170 * 4)
  })

  test('非法尺寸退回常数而不是 NaN/0', () => {
    for (const dim of [
      { width: 0, height: 100 },
      { width: 100, height: 0 },
      { width: -5, height: 5 },
      { width: Number.NaN, height: 100 },
      { width: Number.POSITIVE_INFINITY, height: 100 },
    ]) {
      assert.equal(imageTokensForDimensions(dim), FALLBACK_IMAGE_TOKENS)
    }
  })
})

describe('decodeImageDimensions', () => {
  test('读出 PNG 头里的宽高', () => {
    assert.deepEqual(decodeImageDimensions(pngDataUrl(1280, 800)), { width: 1280, height: 800 })
  })

  test('只解头部——不受载荷大小影响', () => {
    // 真实截图后面跟着几 MB base64；解析必须只看前 32 个字符。
    const url = pngDataUrl(1512, 982) + 'A'.repeat(200_000)
    assert.deepEqual(decodeImageDimensions(url), { width: 1512, height: 982 })
  })

  test('非 PNG 格式返回 null（走退路，不猜尺寸）', () => {
    const jpeg = Buffer.alloc(24)
    jpeg.writeUInt16BE(0xffd8, 0)
    assert.equal(decodeImageDimensions(`data:image/jpeg;base64,${jpeg.toString('base64')}`), null)
  })

  test('http URL / 非 base64 / 头部残缺都返回 null', () => {
    assert.equal(decodeImageDimensions('https://example.com/a.png'), null)
    assert.equal(decodeImageDimensions('data:image/png,notbase64'), null)
    assert.equal(decodeImageDimensions('data:image/png;base64,iVBOR'), null)
    assert.equal(decodeImageDimensions(''), null)
  })

  test('签名对但 IHDR 块名不对时不硬读宽高', () => {
    const buf = Buffer.alloc(24)
    buf.writeUInt32BE(0x89504e47, 0)
    buf.writeUInt32BE(0x0d0a1a0a, 4)
    buf.writeUInt32BE(13, 8)
    buf.writeUInt32BE(0x74584d50, 12) // 不是 IHDR
    buf.writeUInt32BE(9999, 16)
    assert.equal(decodeImageDimensions(`data:image/png;base64,${buf.toString('base64')}`), null)
  })
})

describe('estimateImageTokens', () => {
  test('PNG data URL 按真实尺寸算', () => {
    assert.equal(estimateImageTokens(pngDataUrl(1280, 800)), 1105)
    assert.equal(estimateImageTokens(pngDataUrl(1024, 1024)), 765)
  })

  test('尺寸解不出时退回常数（与旧行为一致，不抛错）', () => {
    assert.equal(estimateImageTokens('https://example.com/shot.png'), FALLBACK_IMAGE_TOKENS)
    assert.equal(estimateImageTokens('data:image/webp;base64,UklGRg=='), FALLBACK_IMAGE_TOKENS)
  })
})
