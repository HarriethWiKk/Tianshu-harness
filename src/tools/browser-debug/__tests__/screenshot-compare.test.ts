/**
 * screenshot compare / intent verdict —— 像素比对与意图裁决的确定性契约。
 *
 * 这些用例存在的理由：compare 报出的差异区域和 intent 三态裁决会被写进交付
 * 报告当确定性证据，所以它们错了必须是红的，不能只是"看起来像个结果"。
 * 首版实现用 alpha 通道扫 pixelmatch 的 diff 图判变化像素，而 pixelmatch 在
 * 默认 diffMask:false 下把未变化像素画成灰度背景（alpha 同为 255）——bbox 于是
 * 恒等于整屏，intent 永远判越界。差异百分比却是对的，输出形状也完整，肉眼
 * 分辨不出。下面第二、三条用真实 PNG 钉死这个行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { createBrowserDebugTool } from '../tool.js'
import { __resetSessionForTest } from '../session.js'
import type { BrowserDebugDriver, DriverEvents, DriverLaunchOptions } from '../driver.js'
import type { ToolCallParams } from '../../types.js'

/** Solid-white PNG with an optional filled rectangle, as a real encoded buffer
 *  — compare goes through PNG.sync.read, so a fake byte string won't do. */
function makePng(
  width: number,
  height: number,
  rect?: { x: number; y: number; w: number; h: number },
): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    png.data[o] = 255
    png.data[o + 1] = 255
    png.data[o + 2] = 255
    png.data[o + 3] = 255
  }
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const o = (y * width + x) * 4
        png.data[o] = 255
        png.data[o + 1] = 0
        png.data[o + 2] = 0
        png.data[o + 3] = 255
      }
    }
  }
  return PNG.sync.write(png)
}

class FakeDriver implements BrowserDebugDriver {
  static last?: FakeDriver
  url = 'about:blank'
  size: { width: number; height: number } | null = { width: 100, height: 100 }
  /** Buffer returned by the next screenshot() call. */
  nextPng: Buffer = makePng(100, 100)
  /** Rect returned for the intent selector lookup; null = element not found. */
  intentRect: { x: number; y: number; w: number; h: number } | null = null
  constructor(_events: DriverEvents) { FakeDriver.last = this }
  async goto(url: string) { this.url = url }
  async evaluate(expr: string) {
    // The intent lookup is the only evaluate() that reads a bounding box.
    if (expr.includes('getBoundingClientRect')) {
      return this.intentRect === null ? 'null' : JSON.stringify(this.intentRect)
    }
    return `eval:${expr}`
  }
  async screenshot() { return this.nextPng }
  async snapshot() { return 'body' }
  async click() {}
  async type() {}
  async press() {}
  async selectOption() { return [] as string[] }
  async hover() {}
  async scroll() {}
  async waitForSelector() {}
  async waitForLoadState() {}
  async reload() {}
  async goBack() { return true }
  async goForward() { return false }
  async cookies() { return [] }
  async storage() { return {} as Record<string, string> }
  async addCookie() {}
  async clearCookies() {}
  async setStorage() {}
  async clearStorage() {}
  async setViewport(width: number, height: number) { this.size = { width, height } }
  viewportSize() { return this.size }
  currentUrl() { return this.url }
  pageUrls() { return [this.url] }
  async bringToFront() {}
  async close() {}
}

/** Minimal artifact store that actually supports the baseline round-trip
 *  (save → listByTarget → readRaw); the shared fake in tool.test.ts only has
 *  save(), so compare silently falls into its catch there. */
class FakeArtifactStore {
  private items: { id: string; target: string; raw: string }[] = []
  async save(input: { target: string; rawContent?: string }): Promise<string> {
    const id = `art-${this.items.length + 1}`
    this.items.push({ id, target: input.target, raw: input.rawContent ?? '' })
    return id
  }
  listByTarget(target: string) {
    return this.items.filter((i) => i.target === target).map((i) => ({ id: i.id }))
  }
  async readRaw(id: string): Promise<string | null> {
    return this.items.find((i) => i.id === id)?.raw ?? null
  }
}

function makeTool() {
  return createBrowserDebugTool({
    enabled: true,
    allowlist: () => [],
    userDataDir: () => '/tmp/test-browser-profile',
    driverFactory: async (o: DriverLaunchOptions) => new FakeDriver(o.events),
  })
}

function params(input: Record<string, unknown>, store: FakeArtifactStore): ToolCallParams {
  return {
    input,
    toolUseId: 't1',
    cwd: '/work',
    artifactStore: store as never,
  }
}

/** open + take the baseline screenshot, leaving the session ready for a
 *  second (changed) capture. */
async function openWithBaseline(store: FakeArtifactStore, baseline: Buffer) {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/app' }, store))
  FakeDriver.last!.nextPng = baseline
  const first = await tool.execute(params({ action: 'screenshot', compare: true }, store))
  return { tool, first }
}

test('compare 首次截图存为基线，不做比对', async () => {
  const store = new FakeArtifactStore()
  const { first, tool } = await openWithBaseline(store, makePng(100, 100))
  assert.match(first.content, /\[compare\] 已保存为基线/)
  await tool.execute(params({ action: 'close' }, store))
})

test('compare 报出的变化区域收缩到真实改动处，而非整屏', async () => {
  // 20×20 的改动落在 (10,10)。若 bbox 扫描把未变化像素也算进去（pixelmatch
  // 默认 diffMask:false 时 diff 图全幅 alpha=255），这里会报成 (0,0)–(99,99)。
  const store = new FakeArtifactStore()
  const { tool } = await openWithBaseline(store, makePng(100, 100))
  FakeDriver.last!.nextPng = makePng(100, 100, { x: 10, y: 10, w: 20, h: 20 })
  const res = await tool.execute(params({ action: 'screenshot', compare: true }, store))

  assert.match(res.content, /\[compare\] 差异 4\.0%/, '400/10000 像素 = 4.0%')
  assert.match(
    res.content,
    /变化区域集中于 \(10,10\)–\(29,29\) 20×20/,
    `变化区域应收缩到真实改动处，实际输出：${res.content}`,
  )
  assert.doesNotMatch(res.content, /\(0,0\)–\(99,99\)/, 'bbox 不该是整屏')
  await tool.execute(params({ action: 'close' }, store))
})

test('compare 无变化时报 0%', async () => {
  const store = new FakeArtifactStore()
  const { tool } = await openWithBaseline(store, makePng(100, 100))
  FakeDriver.last!.nextPng = makePng(100, 100)
  const res = await tool.execute(params({ action: 'screenshot', compare: true }, store))
  assert.match(res.content, /与基线完全一致（0% 差异）/)
  await tool.execute(params({ action: 'close' }, store))
})

test('intent 裁决：变化落在声明区域内判通过', async () => {
  // 声明 (5,5) 30×30 完整包住 (10,10)–(29,29) 的改动 → overlapRatio = 1.0。
  // bbox 若退化成整屏，比值会掉到 ~0.09，这条会红。
  const store = new FakeArtifactStore()
  const { tool } = await openWithBaseline(store, makePng(100, 100))
  FakeDriver.last!.nextPng = makePng(100, 100, { x: 10, y: 10, w: 20, h: 20 })
  FakeDriver.last!.intentRect = { x: 5, y: 5, w: 30, h: 30 }
  const res = await tool.execute(
    params({ action: 'screenshot', compare: true, intent: '.card' }, store),
  )
  assert.match(res.content, /\[intent\] ✓ 变化在声明区域 "\.card" 内/, `实际输出：${res.content}`)
  await tool.execute(params({ action: 'close' }, store))
})

test('intent 裁决：变化与声明区域无交集时判越界', async () => {
  const store = new FakeArtifactStore()
  const { tool } = await openWithBaseline(store, makePng(100, 100))
  FakeDriver.last!.nextPng = makePng(100, 100, { x: 10, y: 10, w: 20, h: 20 })
  FakeDriver.last!.intentRect = { x: 60, y: 60, w: 20, h: 20 }
  const res = await tool.execute(
    params({ action: 'screenshot', compare: true, intent: '.footer' }, store),
  )
  assert.match(res.content, /\[intent\] ✗ 越界/, `实际输出：${res.content}`)
  await tool.execute(params({ action: 'close' }, store))
})

test('intent 裁决：声明的选择器不存在时如实说明', async () => {
  const store = new FakeArtifactStore()
  const { tool } = await openWithBaseline(store, makePng(100, 100))
  FakeDriver.last!.nextPng = makePng(100, 100, { x: 10, y: 10, w: 20, h: 20 })
  FakeDriver.last!.intentRect = null
  const res = await tool.execute(
    params({ action: 'screenshot', compare: true, intent: '.missing' }, store),
  )
  assert.match(res.content, /\[intent\] 声明区域 "\.missing" 未在页面中找到/)
  await tool.execute(params({ action: 'close' }, store))
})
