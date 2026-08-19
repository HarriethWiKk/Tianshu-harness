#!/usr/bin/env tsx
/**
 * usage 双账本对账：meta.tokenUsage vs cache-log.jsonl（usage-ledger 对齐配套，2026-08-18）。
 *
 * 背景：worker 同一派发跨轮（续跑/重试/升档/扩写）复用同一 sessionId——cache-log
 * 追加全量，meta 却被每轮新 SessionContext 向下覆写。回种修复（priorUsage）落地前，
 * meta 系统性低估（playtest 战役实测 worker 36M vs cache-log 142M）。本脚本逐会话
 * 对账并分类偏差形态，回答两个问题：
 *   1. 修复后新会话是否对齐（aligned 应占绝大多数）；
 *   2. 旧会话/异常会话的偏差属于哪一类（继续跑重置 / 无分段欠账 / 超账）。
 *
 * 「无分段欠账」（undercount-anomaly）：单进程单段却 meta < cache-log——已知成因
 * 是 metaStore 批量刷盘语义下的两类丢失（孤儿实例写终态不落盘、被杀时尾部未刷），
 * 修复已随回种一并收口；新会话再出现该类即为回归信号。
 *
 * 用法：
 *   tsx scripts/audit-usage-ledgers.ts                 # 全部会话（默认 ~/.rivet/sessions）
 *   tsx scripts/audit-usage-ledgers.ts --slug playtest # 只看某项目 slug（子串匹配）
 *   tsx scripts/audit-usage-ledgers.ts --top 20        # 偏差榜前 N（默认 10）
 *   tsx scripts/audit-usage-ledgers.ts --json          # 机器可读输出
 *
 * 诊断用途，恒以 exit 0 退出。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../src/config/paths.js'

// ── 参数 ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const ROOT = flag('sessions') ?? sessionsDir()
const SLUG_FILTER = flag('slug')?.toLowerCase()
const TOP = Number(flag('top') ?? 10)
const JSON_MODE = argv.includes('--json')

// ── 数据结构 ──────────────────────────────────────────────────────
interface UsageRow { t: number; turn?: number; input: number; output: number }
type Verdict =
  | 'aligned'
  | 'continuation-reset'   // 多段（续跑重置）：meta ≈ 末段——回种修复前的历史形态
  | 'undercount-anomaly'   // meta < log 且非干净的末段重置——孤儿缓存/未刷尾/段交错
  | 'overcount'            // meta > log——理论上不可能，出现即硬 bug
  | 'no-log'               // 有 meta 无 cache-log（老会话/侧路零调用）
  | 'no-meta'              // 有 cache-log 无 meta

interface SessionAudit {
  slug: string
  sid: string
  logInput: number
  logOutput: number
  metaPrompt: number
  metaCompletion: number
  segments: number
  lastSegInput: number
  delta: number            // metaPrompt − logInput
  verdict: Verdict
  updatedAt: number
}

// ── cache-log 解析（与 usage-aggregator 同口径：主行 + side_path 计费行）──
function parseUsageRows(path: string): UsageRow[] {
  const rows: UsageRow[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r: Record<string, unknown>
    try { r = JSON.parse(line) } catch { continue }
    if (r.event !== undefined && r.event !== 'side_path') continue
    const input = r.input
    const t = r.t
    if (typeof input !== 'number' || typeof t !== 'number') continue
    rows.push({
      t,
      turn: typeof r.turn === 'number' ? r.turn : undefined,
      input,
      output: typeof r.output === 'number' ? r.output : 0,
    })
  }
  return rows
}

/** turn 序列回落（N→0）计一次分段——续跑/新用户轮都从 0 起。 */
function countSegments(rows: UsageRow[]): { segments: number; lastSegInput: number } {
  let segments = rows.length > 0 ? 1 : 0
  let lastStart = 0
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!.turn
    const cur = rows[i]!.turn
    if (typeof prev === 'number' && typeof cur === 'number' && cur < prev) {
      segments++
      lastStart = i
    }
  }
  let lastSegInput = 0
  for (let i = lastStart; i < rows.length; i++) lastSegInput += rows[i]!.input
  return { segments, lastSegInput }
}

function classify(metaPrompt: number, logInput: number, segments: number, lastSegInput: number): Verdict {
  // 容差：绝对 2000 或 1%，取大——覆盖 side_path 行计数差与四舍五入。
  const tol = Math.max(2_000, logInput * 0.01)
  if (Math.abs(metaPrompt - logInput) <= tol) return 'aligned'
  if (metaPrompt > logInput + tol) return 'overcount'
  if (segments > 1 && Math.abs(metaPrompt - lastSegInput) <= Math.max(5_000, lastSegInput * 0.02)) {
    return 'continuation-reset'
  }
  return 'undercount-anomaly'
}

// ── 遍历会话（兼容 root/<sid>/ 与 root/<slug>/<sid>/ 两种布局）────
function listDirs(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) }
  catch { return [] }
}

const audits: SessionAudit[] = []

function auditSessionDir(parent: string, sid: string, slug: string): void {
  const logPath = join(parent, sid, 'cache-log.jsonl')
  const metaPath = join(parent, `${sid}.meta.json`)
  const hasLog = existsSync(logPath)
  const hasMeta = existsSync(metaPath)
  if (!hasLog && !hasMeta) return

  let metaPrompt = 0, metaCompletion = 0, updatedAt = 0
  if (hasMeta) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      metaPrompt = meta?.tokenUsage?.prompt ?? 0
      metaCompletion = meta?.tokenUsage?.completion ?? 0
      updatedAt = meta?.updatedAt ?? 0
    } catch { /* 坏 meta 当 0 处理，归类自然进欠账 */ }
  }

  if (!hasLog) {
    audits.push({ slug, sid, logInput: 0, logOutput: 0, metaPrompt, metaCompletion, segments: 0, lastSegInput: 0, delta: metaPrompt, verdict: 'no-log', updatedAt })
    return
  }
  const rows = parseUsageRows(logPath)
  if (rows.length === 0) return // 只有 event 行（无计费调用）的会话不入榜
  const logInput = rows.reduce((s, r) => s + r.input, 0)
  const logOutput = rows.reduce((s, r) => s + r.output, 0)
  const { segments, lastSegInput } = countSegments(rows)
  const verdict: Verdict = !hasMeta
    ? 'no-meta'
    : classify(metaPrompt, logInput, segments, lastSegInput)
  if (!updatedAt) { try { updatedAt = Math.floor(statSync(logPath).mtimeMs) } catch { /* 0 即可 */ } }
  audits.push({ slug, sid, logInput, logOutput, metaPrompt, metaCompletion, segments, lastSegInput, delta: metaPrompt - logInput, verdict, updatedAt })
}

for (const dir of listDirs(ROOT)) {
  const dirPath = join(ROOT, dir)
  if (SLUG_FILTER && !dir.toLowerCase().includes(SLUG_FILTER)) continue
  // 布局 A：root/<slug>/<sid>/cache-log.jsonl（默认全项目布局）
  for (const sid of listDirs(dirPath)) auditSessionDir(dirPath, sid, dir)
  // 布局 B：root/<sid>/cache-log.jsonl（RIVET_SESSION_DIR 单项目布局）
  if (existsSync(join(dirPath, 'cache-log.jsonl'))) auditSessionDir(ROOT, dir, '(root)')
}

// ── 汇总输出 ─────────────────────────────────────────────────────
const byVerdict = new Map<Verdict, number>()
for (const a of audits) byVerdict.set(a.verdict, (byVerdict.get(a.verdict) ?? 0) + 1)

const totalLogInput = audits.reduce((s, a) => s + a.logInput, 0)
const totalMetaPrompt = audits.reduce((s, a) => s + a.metaPrompt, 0)
const totalLogOutput = audits.reduce((s, a) => s + a.logOutput, 0)
const totalMetaCompletion = audits.reduce((s, a) => s + a.metaCompletion, 0)

const fmt = (n: number): string => n.toLocaleString('en-US')
const pct = (n: number, d: number): string => d > 0 ? `${(n / d * 100).toFixed(1)}%` : '—'

if (JSON_MODE) {
  console.log(JSON.stringify({
    root: ROOT,
    sessions: audits.length,
    totals: {
      logInput: totalLogInput, metaPrompt: totalMetaPrompt,
      logOutput: totalLogOutput, metaCompletion: totalMetaCompletion,
      metaUnderreport: totalLogInput > 0 ? 1 - totalMetaPrompt / totalLogInput : 0,
    },
    verdicts: Object.fromEntries(byVerdict),
    topDeltas: [...audits].sort((a, b) => a.delta - b.delta).slice(0, TOP),
  }, null, 2))
  process.exit(0)
}

console.log(`usage 双账本对账 · root=${ROOT}`)
console.log(`会话数：${audits.length}`)
console.log(`账本口径：cache-log input=${fmt(totalLogInput)}  meta prompt=${fmt(totalMetaPrompt)}  （meta 覆盖率 ${pct(totalMetaPrompt, totalLogInput)}）`)
console.log(`           cache-log output=${fmt(totalLogOutput)}  meta completion=${fmt(totalMetaCompletion)}  （覆盖率 ${pct(totalMetaCompletion, totalLogOutput)}）`)
console.log('\n分类：')
const verdictLabel: Record<Verdict, string> = {
  'aligned': '对齐（|Δ| ≤ max(2k, 1%)）',
  'continuation-reset': '续跑重置（多段，meta≈末段——回种修复前的历史形态）',
  'undercount-anomaly': '欠账未解释（含单段欠账与多段但不匹配末段——孤儿缓存/未刷尾，修复后应为零）',
  'overcount': '超账（meta>log，理论上不可能，出现即 bug）',
  'no-log': '有 meta 无 cache-log',
  'no-meta': '有 cache-log 无 meta',
}
for (const [v, n] of Object.entries(verdictLabel)) {
  const count = byVerdict.get(v as Verdict) ?? 0
  if (count > 0) console.log(`  ${v.padEnd(20)} ${String(count).padStart(5)}   ${n}`)
}

const offenders = [...audits].sort((a, b) => a.delta - b.delta).slice(0, TOP)
if (offenders.length > 0 && offenders[0]!.delta < -2_000) {
  console.log(`\n偏差榜（meta−log 最负的前 ${Math.min(TOP, offenders.length)} 个）：`)
  console.log('  session                              segs   logInput        metaPrompt       Δ')
  for (const a of offenders) {
    if (a.delta > -2_000) break
    console.log(`  ${a.sid.slice(0, 36).padEnd(37)} ${String(a.segments).padStart(4)}   ${fmt(a.logInput).padStart(13)}   ${fmt(a.metaPrompt).padStart(13)}   ${fmt(a.delta).padStart(13)}   [${a.verdict}]`)
  }
}
const over = audits.filter(a => a.verdict === 'overcount')
if (over.length > 0) {
  console.log(`\n⚠ 超账 ${over.length} 个（meta > log）——理论上不可能，逐一排查：`)
  for (const a of over.slice(0, TOP)) {
    console.log(`  ${a.sid}  log=${fmt(a.logInput)} meta=${fmt(a.metaPrompt)} Δ=+${fmt(a.delta)}`)
  }
}
