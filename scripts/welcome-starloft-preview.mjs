#!/usr/bin/env node
/**
 * 天枢首屏「星阁 × 星桥」版式预览 —— 设计稿生成器（自包含，不依赖构建产物）。
 *
 *   node scripts/welcome-starloft-preview.mjs            # 终端 ANSI 预览
 *   node scripts/welcome-starloft-preview.mjs --html     # 同时写出 HTML 供浏览器看
 *   COLS=100 node scripts/welcome-starloft-preview.mjs   # 换终端宽度
 *   AMBIG_WIDE=1 node scripts/welcome-starloft-preview.mjs   # CJK 宽终端口径
 *
 * 设计脉络：概念 D「星阁」的框体与引导层保留，两栏拆成单列；左栏那 5 行 Unicode
 * 点阵星图换成星桥稿的核心——真星等编码的北斗。点阵读不出北斗是因为终端字符格
 * 2:1 的高宽比把形状压扁、5×12 分辨率不够；但压成单行又太平，丢了「斗身四边形 +
 * 折出去的斗柄」这个最有辨识度的特征。最终取两行：刊头线走顶行兼作分隔，斗身
 * 作为一只勺子挂在它下面。
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── graphite 主题（src/tui/theme-palettes.ts 逐值抄录）───────────────
const G = {
  brand: '#7cc4e8',      // primary / brandColor — 冰青 accent
  secondary: '#8b98ab',  // 钢灰蓝
  muted: '#9aa4b0',      // 元信息灰
  dim: '#78828f',        // 结构灰
  quiet: '#2f3540',      // pulseQuiet — 最暗结构色
  text: '#c8cdd6',       // assistantColor
  bg: '#17181b',
}

// ── 显示宽度 ────────────────────────────────────────────────────────
const AMBIG_WIDE = process.env.AMBIG_WIDE === '1'
const WIDE_RANGES = [[0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6]]
// 与 src/tui/width.ts 逐字符核对过的 ambiguous 名单（get-east-asian-width 口径）：
// ★ · ◎ … 是 ambiguous，宽档 2 列；✦ ⚖ Ā Ū 是 neutral 恒 1 列；
// box-drawing / block（U+2500–259F）被 isBoxOrBlock 排除，也恒 1 列。
const AMBIG = new Set(['★', '·', '◎', '…', '↑', '↓', '—'])
const charW = (ch) => {
  const cp = ch.codePointAt(0)
  if (cp >= 0x2500 && cp <= 0x259f) return 1
  if (AMBIG.has(ch)) return AMBIG_WIDE ? 2 : 1
  return WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
}
const segW = (segs) => segs.reduce((w, x) => {
  for (const ch of x.t) w += charW(ch)
  return w
}, 0)

// ── 片段构造 ────────────────────────────────────────────────────────
const s = (t, c = G.text, o = {}) => ({ t, c, ...o })
const pad = (n) => s(' '.repeat(Math.max(0, n)), G.quiet)
const fit = (segs, width) => [...segs, pad(width - segW(segs))]

// ── 渲染后端 ────────────────────────────────────────────────────────
const RESET = '\x1B[0m'
const fgOf = (h) => {
  const m = h.replace('#', '')
  return `\x1B[38;2;${parseInt(m.slice(0, 2), 16)};${parseInt(m.slice(2, 4), 16)};${parseInt(m.slice(4, 6), 16)}m`
}
const toAnsi = (segs) => segs.map(x =>
  `${fgOf(x.c)}${x.b ? '\x1B[1m' : ''}${x.i ? '\x1B[3m' : ''}${x.t}${RESET}`).join('')
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const toHtml = (segs) => segs.map(x => {
  const style = [`color:${x.c}`, x.b && 'font-weight:700', x.i && 'font-style:italic']
    .filter(Boolean).join(';')
  return `<span style="${style}">${esc(x.t)}</span>`
}).join('')

// ── 几何：与输入框严格同宽 ──────────────────────────────────────────
// src/tui/engine/app.ts:4435 —— innerWidth = max(20, cols - 6)；
// 顶/底框 = tl + h×(innerWidth+2) + tr，故整框外宽 = innerWidth + 4，起于第 0 列。
const COLS = Number(process.env.COLS ?? 80)
const INNER_W = Math.max(20, COLS - 6)
const OUTER = INNER_W + 4
const TAIL_GAP = 6                  // 刊头线右侧留白，chrome 后退

// ── 北斗七星 ────────────────────────────────────────────────────────
// 星等取真实视星等。布局是两行：斗身四边形的上边（天枢–天权）与斗柄同在顶行，
// 兼作刊头分隔线；下边（天璇–天玑）挂在次行，用 ╰ ╯ 收口成一只勺子。
// 列距按真实天区的水平投影配比——斗身窄、斗柄依次 6:5:7 舒展
// （实际角距 Megrez–Alioth 6.1° · Alioth–Mizar 4.7° · Mizar–Alkaid 6.6°）。
// 顶行按「星 + 间距」序列描述；间距是 ─ 的根数（恒 1 列，与宽度档无关）。
const TOP_SEQ = [
  { name: '天枢', mag: 1.79, gap: 8 },   // Dubhe   斗身左上 —— 斗身上边
  { name: '天权', mag: 3.31, gap: 5 },   // Megrez  斗身右上 · 斗柄起点
  { name: '玉衡', mag: 1.77, gap: 4 },   // Alioth
  { name: '开阳', mag: 2.23, gap: 6 },   // Mizar
  { name: '瑶光', mag: 1.86, gap: 0 },   // Alkaid
]
const BOWL_SEQ = [
  { name: '天璇', mag: 2.37, at: 0.22 }, // Merak   斗身左下
  { name: '天玑', mag: 2.44, at: 0.78 }, // Phecda  斗身右下
]

// 星等 → 字形。三档：最亮双星实心 ✦、次亮四星空心 ✧、最暗的天权微点 ∙。
// 刻意避开 ★(U+2605) 与 ·(U+00B7)——它们是 East-Asian Ambiguous，CJK 终端按
// 2 列渲染，会让框的右边线随终端参差；✦ ✧ ∙ 三档下恒 1 列。
const glyphFor = (mag) => (mag < 1.8 ? '✦' : mag < 3.0 ? '✧' : '∙')
const colorFor = (mag) => (mag < 1.8 ? G.brand : mag < 3.0 ? G.muted : G.dim)
const starSeg = (d, i) => s(glyphFor(d.mag), colorFor(d.mag), { b: i === 0 })

/**
 * 顶行：斗身上边 + 斗柄，尾部续 ─ 到 width 兼作刊头分隔线。
 * 边拼边量出各星的显示起列——★ · 在 CJK 宽档占 2 列，写死列号会让次行的
 * 斗身收口跑偏，所以位置必须实测。
 */
function dipperTop(width) {
  const out = []
  const colOf = {}
  let cur = 0
  TOP_SEQ.forEach((d, i) => {
    colOf[d.name] = cur
    const seg = starSeg(d, i)
    out.push(seg)
    cur += segW([seg])
    if (d.gap) { out.push(s('─'.repeat(d.gap), G.quiet)); cur += d.gap }
  })
  if (width > cur) out.push(s('─'.repeat(width - cur), G.quiet))
  return { segs: out, colOf, width: Math.max(cur, width) }
}

/** 次行：斗身下边，╰ ╯ 收口成勺；右角对齐顶行天权的起列。 */
function dipperBowl(colOf) {
  const right = colOf['天权']
  const out = [s('╰', G.quiet)]
  let cur = 1
  for (const d of BOWL_SEQ) {
    const target = Math.round(right * d.at)
    if (target > cur) { out.push(s('─'.repeat(target - cur), G.quiet)); cur = target }
    const seg = s(glyphFor(d.mag), colorFor(d.mag))
    out.push(seg)
    cur += segW([seg])
  }
  if (right > cur) { out.push(s('─'.repeat(right - cur), G.quiet)); cur = right }
  out.push(s('╯', G.quiet))
  return out
}

/** 对照用：压成单行的北斗（就是「太平」的那版）。 */
function dipperFlat(width) {
  const gaps = [3, 2, 4, 6, 3, 4]
  const mags = [1.79, 2.37, 2.44, 3.31, 1.77, 2.23, 1.86]
  const out = []
  mags.forEach((mag, i) => {
    out.push(s(glyphFor(mag), colorFor(mag), { b: i === 0 }))
    if (gaps[i]) out.push(s('─'.repeat(gaps[i]), G.quiet))
  })
  const w = segW(out)
  if (width > w) out.push(s('─'.repeat(width - w), G.quiet))
  return out
}

// ── 内容素材 ────────────────────────────────────────────────────────
const VERSION = 'v2.23.0'
const WORDMARK = [s('天枢', G.brand, { b: true }), s('  ', G.quiet), s('T I Ā N S H Ū', G.secondary),
  s('  ', G.quiet), s('Code', G.muted)]

const bodyRows = () => [
  [],
  [s('deepseek-v4', G.muted), s(' · ', G.dim), s('◎high', G.brand), s(' · ', G.dim),
    s('auto-safe', G.muted), s(' · ', G.dim), s('⚖ 天权', G.muted)],
  [s('~/app/deepseek-tui/opencode-tui', G.muted), s(' · ', G.dim), s('#7281', G.dim)],
  [],
  [s('/init', G.brand), s(' 生成项目说明   ', G.muted), s('/domain', G.brand),
    s(' 切换星域   ', G.muted), s('/help', G.brand), s(' 全部命令 · ctrl+p 命令面板', G.muted)],
]

/** 圆角框；title 嵌顶框左、version 贴右。总宽恒为 OUTER，与输入框一致。 */
function boxed(title, rows) {
  const dashes = OUTER - 8 - segW(title) - VERSION.length  // ╭─␣ …␣ ─…─ ␣v… ␣─╮
  return [
    [s('╭─ ', G.quiet), ...title, s(' ', G.quiet), s('─'.repeat(Math.max(0, dashes)), G.quiet),
      s(' ', G.quiet), s(VERSION, G.dim), s(' ─╮', G.quiet)],
    ...rows.map(r => [s('│ ', G.quiet), ...fit(r, INNER_W), s(' │', G.quiet)]),
    [s('╰', G.quiet), s('─'.repeat(OUTER - 2), G.quiet), s('╯', G.quiet)],
  ]
}

/** 输入框仿样，用来目视核对两个框等宽等位。 */
const inputBoxMock = () => {
  const label = [s('⚖ 天权', G.brand), s(' · ', G.dim), s('deepseek-v4', G.muted),
    s(' · ', G.dim), s('12% ctx', G.dim)]
  const dashes = OUTER - 5 - segW(label)
  return [
    [s('╭─ ', G.quiet), ...label, s(' ', G.quiet), s('─'.repeat(Math.max(0, dashes)), G.quiet), s('╮', G.quiet)],
    [s('│ ', G.quiet), ...fit([s('❯', '#3ba55c', { b: true }), s(' ', G.quiet), s('█', G.brand)], INNER_W), s(' │', G.quiet)],
    [s('╰', G.quiet), s('─'.repeat(OUTER - 2), G.quiet), s('╯', G.quiet)],
  ]
}

// ── 候选 ────────────────────────────────────────────────────────────
const top = dipperTop(INNER_W - TAIL_GAP)
const dipperRows = [top.segs, dipperBowl(top.colOf)]

const variants = [
  {
    key: 'D′',
    title: '定稿 · 两行北斗 + 边框对齐输入框',
    note: '斗身作为勺子挂在刊头线下：顶行是斗身上边（天枢–天权）接斗柄并续成分隔线，次行 ╰─✦────✦─╯ 收口成斗。整块 9 行，外宽 = innerWidth + 4，与输入框逐列对齐。',
    lines: boxed(WORDMARK, [...dipperRows, ...bodyRows()]),
  },
  {
    key: 'D',
    title: '对照 · 单行北斗（「太平」的那版）',
    note: '同样内容，北斗压成一行。少一行，但斗身四边形与斗柄折点全丢了，读起来是刻度尺不是星座。',
    lines: boxed(WORDMARK, [
      dipperFlat(INNER_W - TAIL_GAP),
      ...bodyRows(),
    ]),
  },
  {
    key: '±',
    title: '边框等宽核对 · 欢迎块直接叠在输入框上',
    note: '两个框的左右边线必须逐列咬合。任何一列错位在这里都看得见。',
    lines: [
      ...boxed(WORDMARK, [...dipperRows, ...bodyRows()]),
      [],
      ...inputBoxMock(),
    ],
  },
]

// ── 输出 ────────────────────────────────────────────────────────────
for (const v of variants) {
  console.log('\n' + toAnsi([s(`── ${v.key} ${v.title}  (${v.lines.length} 行 · cols=${COLS} · 外宽 ${OUTER}) `, G.dim)]) + '\n')
  for (const line of v.lines) console.log(toAnsi(line))
  console.log('\n' + toAnsi([s('   ' + v.note, G.quiet)]))
}
console.log('')

// 对齐自检：任何一行超出 OUTER 都会在真实终端折行/撞框。
let bad = 0
for (const v of variants) {
  v.lines.forEach((line, i) => {
    const w = segW(line)
    if (w > OUTER) { console.error(`  ⚠ ${v.key} 第 ${i + 1} 行宽 ${w} > ${OUTER}`); bad++ }
  })
}
if (!bad) console.log(`  ✓ 全部行宽 ≤ ${OUTER}（cols=${COLS}${AMBIG_WIDE ? ' · CJK 宽档' : ''}）\n`)

if (process.argv.includes('--html')) {
  const body = variants.map(v => `
<h2>${esc(v.key)} · ${esc(v.title)} <em>(${v.lines.length} 行)</em></h2>
<div class="term">${v.lines.map(l => toHtml(l) || '&nbsp;').join('\n')}</div>
<p class="note">${esc(v.note)}</p>`).join('\n')
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>天枢首屏 · 星阁 × 星桥</title><style>
body{background:${G.bg};color:${G.text};margin:0;padding:40px 44px;
  font-family:"SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace;font-size:14px;line-height:1.55}
h1{font-size:15px;font-weight:600;letter-spacing:1px;color:${G.brand};margin:0 0 6px}
h2{color:${G.secondary};font-weight:500;font-size:12px;letter-spacing:1.5px;
  border-bottom:1px solid ${G.quiet};padding-bottom:7px;margin:40px 0 16px}
h2 em{color:${G.dim};font-style:normal;font-weight:400}
.term{white-space:pre;background:#111214;border:1px solid ${G.quiet};
  border-radius:8px;padding:22px 24px;overflow-x:auto}
.note{color:${G.dim};font-size:12px;margin:9px 0 0}
.lead{color:${G.muted};font-size:12.5px;max-width:80ch;line-height:1.75;margin:0 0 8px}
</style></head><body>
<h1>天枢首屏 · 星阁 × 星桥</h1>
<p class="lead">星阁的框体与引导层保留，两栏拆成单列；点阵星图换成真视星等编码的北斗
（★ 天枢 1.79 / 玉衡 1.77 · ✦ 天璇 2.37 / 天玑 2.44 / 开阳 2.23 / 瑶光 1.86 · · 天权 3.31）。
两行布局：斗身上边与斗柄走顶行兼作刊头分隔线，斗身下边挂在次行收口成勺。
边框外宽 = innerWidth + 4，与 app.ts 的输入框逐列对齐。配色全部取自 graphite token。</p>
${body}
</body></html>`
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'brand', 'welcome-starloft-preview.html')
  writeFileSync(out, html)
  console.log(`HTML → ${out}\n`)
}
