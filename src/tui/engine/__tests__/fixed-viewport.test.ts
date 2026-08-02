/**
 * 活动期定高视口测试（TUI 输入框钉底）。
 *
 * 契约：
 *  1. padDynamicRegion 把动态段垫高/截断到恰好 budget display rows：
 *     - 不足 → 在动态内容与 chrome 之间垫空行（内容贴上、输入框贴下）；
 *     - 超出 → 从顶部截最旧行（approval 等关键内容在动态段尾部，天然保留）；
 *     - budget<=0 → 原样返回（空闲塌回）。
 *  2. TuiApp 活动期（thinking/streaming）连续帧的 live region 总 display rows
 *     恒定 —— 输入框屏幕坐标不随字符增长浮动。
 *  3. 首轮完成后 idle 不塌回——保持 ceiling 把输入框压底（首帧欢迎屏仍走自然流）。
 *  4. 小终端（rows=10）预算收缩，live region 不超屏。
 *  5. liveMaxRowsFor 终端高度感知（min(28, rows-1)，下限 4）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padDynamicRegion, type LiveRegionLine } from '../live-engine.js'
import { liveMaxRowsFor } from '../app.js'
import { makeApp } from './_harness.js'

const L = (...texts: string[]): LiveRegionLine[] => texts.map(text => ({ text }))

// ── padDynamicRegion 纯函数 ─────────────────────────────────────

test('不足预算：动态内容与 chrome 之间垫空行到恰好 budget，chromeStart 相应后移', () => {
  const lines = [...L('spinner', 'thinking'), ...L('input-top', 'input', 'input-bot')]
  const r = padDynamicRegion(lines, 2, 6)
  assert.equal(r.chromeStart, 6, 'chromeStart = 2 dynamic + 4 padding')
  assert.equal(r.lines.length, 9, '6 dynamic rows + 3 chrome')
  assert.deepEqual(r.lines.slice(0, 2).map(l => l.text), ['spinner', 'thinking'], '动态内容贴上')
  assert.ok(r.lines.slice(2, 6).every(l => l.text === ''), '空行垫在内容与 chrome 之间')
  assert.deepEqual(r.lines.slice(6).map(l => l.text), ['input-top', 'input', 'input-bot'], 'chrome 不动')
})

test('超出预算：从顶部截最旧行，动态段尾部（approval）保留', () => {
  const dynamic = L('old-1', 'old-2', 'old-3', 'old-4', 'approval-prompt')
  const chrome = L('input')
  const r = padDynamicRegion([...dynamic, ...chrome], 5, 3)
  assert.equal(r.chromeStart, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['old-3', 'old-4', 'approval-prompt', 'input'])
})

test('恰好等于预算：原样保留，无垫行无截断', () => {
  const lines = [...L('a', 'b', 'c'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', 'c', 'input'])
  assert.equal(r.chromeStart, 3)
})

test('budget<=0：原样返回（空闲塌回自然流）', () => {
  const lines = [...L('a'), ...L('input')]
  const r = padDynamicRegion(lines, 1, 0)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'input'])
  assert.equal(r.chromeStart, 1)
})

test('动态段为空：全部垫空行到 budget', () => {
  const r = padDynamicRegion(L('input'), 0, 4)
  assert.equal(r.chromeStart, 4)
  assert.ok(r.lines.slice(0, 4).every(l => l.text === ''))
  assert.equal(r.lines[4]!.text, 'input')
})

test('多 display-row 行按 measure 计数；整行丢弃低于预算后垫空行补齐到恰好 budget', () => {
  // wide 行占 3 display rows。budget=4：丢弃 wide(3) 后剩 a+b=2 rows < 4 → 垫 2 空行。
  const measure = (text: string): number => (text === 'wide' ? 3 : 1)
  const lines = [...L('wide', 'a', 'b'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 4, measure)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', '', '', 'input'])
  assert.equal(r.chromeStart, 4)
  const total = r.lines.slice(0, r.chromeStart).reduce((s, l) => s + measure(l.text), 0)
  assert.equal(total, 4, '动态段恒等于 budget display rows')
})

// ── liveMaxRowsFor ──────────────────────────────────────────────

test('liveMaxRowsFor：高终端封顶 28，小终端 rows-1，下限 4，非法值回退', () => {
  assert.equal(liveMaxRowsFor(50), 28)
  assert.equal(liveMaxRowsFor(29), 28)
  assert.equal(liveMaxRowsFor(20), 19)
  assert.equal(liveMaxRowsFor(10), 9)
  assert.equal(liveMaxRowsFor(4), 4)
  assert.equal(liveMaxRowsFor(2), 4, '下限 4：宁可超行不裁输入框')
  assert.equal(liveMaxRowsFor(0), 23, 'rows 缺失回退 24-1')
})

// ── TuiApp 集成：帧高度稳定性 ───────────────────────────────────

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const liveRows = (app: unknown): number => (app as { live: { lastDisplayRows: number } }).live.lastDisplayRows

/**
 * 轮内不缩（非「逐帧恒定」）：动态段按本轮高水位定高，内容增长时抬高、
 * 永不回缩。回缩才是输入框上抖的成因；单向抬高在满屏后由终端滚动吸收。
 */
const assertNoShrink = (heights: readonly number[]): void => {
  for (let i = 1; i < heights.length; i++) {
    assert.ok(
      heights[i]! >= heights[i - 1]!,
      `第 ${i} 帧回缩（输入框上抖）: ${heights[i]} < ${heights[i - 1]}（heights=${heights.join(',')}）`,
    )
  }
}

test('thinking 逐字增长期间 live region 轮内只涨不缩（输入框不上抖）', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const heights: number[] = []
  for (let i = 0; i < 12; i++) {
    app.callbacks.onThinkingDelta(`推理片段 ${i}：分析代码结构与依赖关系。\n`)
    await flush()
    heights.push(liveRows(app))
  }
  assert.ok(heights[0]! > 5, `活动期视口应有可观高度: ${heights[0]}`)
  assertNoShrink(heights)
  // 高水位跟随真实内容，不再恒定撑到引擎上限 liveMaxRowsFor(40)=28——撑到上限
  // 会让轮末塌回落差达 20+ 行，短回复后全部露成输入框下方的空白。
  assert.ok(
    heights[heights.length - 1]! < 28,
    `动态段不应撑到引擎上限: ${heights[heights.length - 1]}（heights=${heights.join(',')}）`,
  )
})

test('streaming 文本增长期间同样只涨不缩', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const heights: number[] = []
  for (let i = 0; i < 10; i++) {
    app.callbacks.onTextDelta(`streaming output chunk ${i} with some longer content to fill the tail. `)
    await flush()
    heights.push(liveRows(app))
  }
  assert.ok(heights[0]! > 5)
  assertNoShrink(heights)
  assert.ok(heights[heights.length - 1]! < 28, `heights=${heights.join(',')}`)
})

test('turn 结束（isFinal）后保持压底——输入框不悬在半空占推理区域', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  app.callbacks.onThinkingDelta('思考中……\n')
  await flush()
  const active = liveRows(app)
  assert.ok(active > 5)

  await (app as unknown as { handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void> })
    .handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await flush()
  const idle = liveRows(app)
  // 首轮完成后 idle 不应塌回——ceiling 垫到满屏，输入框保持压底。
  // 落差无界要求（旧契约 idle < active 废除），允许 idle ≈ ceiling ≥ active。
  const terminalRows = 40
  const chromeRows = 6 // GlanceBar(1) + 输入框(3) + 提示行(~2)
  const ceiling = Math.min(terminalRows - chromeRows - 2, liveMaxRowsFor(terminalRows) - chromeRows)
  assert.ok(idle >= active || idle >= ceiling - 2,
    `空闲期应保持压底: idle=${idle} active=${active} ceiling≈${ceiling}`)
})

test('首帧走自然流，不补空行撑底（凭空造的空白只能堆在欢迎屏某一侧，比自然流更难看）', async () => {
  const { out } = makeApp({ cols: 80, rows: 40 })
  await flush()
  assert.equal(out.chunks.find(c => /^\n{2,}$/.test(c)), undefined,
    `首帧不应出现成片空行: ${JSON.stringify(out.chunks.slice(0, 4))}`)
})

test('小终端（rows=10）预算收缩，live region 不超屏', async () => {
  const { app } = makeApp({ cols: 80, rows: 10 })
  for (let i = 0; i < 8; i++) {
    app.callbacks.onThinkingDelta(`小屏思考片段 ${i}\n`)
    await flush()
    assert.ok(liveRows(app) <= 10, `live region 超屏: ${liveRows(app)} > 10`)
  }
})
