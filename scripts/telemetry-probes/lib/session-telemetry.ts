/**
 * 会话遥测读取层 —— 所有离线探针共用的语料入口。
 *
 * 存在理由：这些探针反复需要同一批琐碎且容易搞错的东西——完整性后缀怎么剥、
 * 会话目录怎么定位、哪些目录是 fixture 不能混进语料、分位数怎么取。第二轮监测
 * 期间这套逻辑被重写了六遍，每次都有细节差异（见
 * docs/analysis/2026-07-28-阈值与分布脱钩.md）。集中一处，探针只写自己的判据。
 *
 * 数据前提：`sensorium.jsonl` 需 `RIVET_DEBUG_TELEMETRY=1` 才落盘。其中
 * `vitals-lite` 行与 assistant 消息严格 1:1（见卦象证据档案）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../../../src/config/paths.js'

/** vitals-lite 的六维。顺序即报告顺序。 */
export const SENSORIUM_DIMS = [
  'momentum', 'pressure', 'confidence', 'complexity', 'freshness', 'stability',
] as const

export type SensoriumDim = typeof SENSORIUM_DIMS[number]

export interface VitalsFrame {
  /** 会话 id 前 8 位，报告用 */
  sid: string
  turn: number | null
  sensorium: Record<SensoriumDim, number>
  ctxRatio: number | null
  cvmOverheadRatio: number | null
  throttled: boolean
  /** 该轮 confidence 是否为实测（而非回退值）——布尔，不是置信度数值 */
  confidenceMeasured: boolean
  advisories: number | null
}

/**
 * 剥掉会话日志行的完整性后缀（`…|<16 位 hex>`）后解析。
 *
 * 先直接 parse：绝大多数行没有后缀，省一次 lastIndexOf。
 */
export function parseTelemetryLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try { return JSON.parse(trimmed) } catch { /* 可能带后缀，剥了重试 */ }
  const sep = trimmed.lastIndexOf('|')
  if (sep <= 0) return null
  const tail = trimmed.slice(sep + 1)
  if (tail.length !== 16 || !/^[0-9a-f]+$/.test(tail)) return null
  try { return JSON.parse(trimmed.slice(0, sep)) } catch { return null }
}

/**
 * 非真实使用轨迹的 slug —— 跨 slug 扫描时必须排除，否则语料被污染。
 *
 * `tmp-*` / `repo-*` 是 cwd 为 /tmp、/repo 的单元测试 fixture；
 * `*_task<N>_<model>-*` 是 benchmark 跑分。
 */
export function isFixtureSlug(slug: string): boolean {
  return slug.startsWith('tmp-') || slug.startsWith('repo-') || /_task\d+_/.test(slug)
}

export interface ProbeArgs {
  /** 会话目录（单 slug 目录，或 sessions 根目录） */
  root: string
  /** 只取此时间点之后写过的会话；undefined 表示不限 */
  sinceMs?: number
  json: boolean
  rest: string[]
}

/**
 * 解析探针通用 CLI：`[<sessions-dir>] [--since-days=N] [--json]`。
 * 与 scripts/hexagram-divergence-probe.ts 的既有惯例保持一致。
 */
export function parseProbeArgs(argv: string[] = process.argv.slice(2)): ProbeArgs {
  const flags = argv.filter(a => a.startsWith('--'))
  const rest = argv.filter(a => !a.startsWith('--'))
  const sinceDays = flags
    .map(f => /^--since-days=(\d+(?:\.\d+)?)$/.exec(f))
    .find(m => m !== null)
  return {
    root: rest[0] ?? sessionsDir(process.cwd()),
    sinceMs: sinceDays ? Date.now() - Number(sinceDays[1]) * 86_400_000 : undefined,
    json: flags.includes('--json'),
    rest: rest.slice(1),
  }
}

/**
 * 列出语料内的会话遥测文件。
 *
 * 兼容两种 root：单 slug 目录（`<root>/<sid>/sensorium.jsonl`）与 sessions 根
 * 目录（`<root>/<slug>/<sid>/sensorium.jsonl`）。只取主会话——`worker-` 前缀的
 * 子会话有自己的认知轨迹，混入会污染主控口径。
 */
export function listTelemetryFiles(
  root: string,
  opts: { sinceMs?: number; file?: string } = {},
): Array<{ sid: string; path: string }> {
  const file = opts.file ?? 'sensorium.jsonl'
  const out: Array<{ sid: string; path: string }> = []

  const collect = (dir: string): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      if (entry.startsWith('worker-') || entry.startsWith('.')) continue
      const candidate = join(dir, entry, file)
      if (!existsSync(candidate)) continue
      if (opts.sinceMs !== undefined) {
        try {
          if (statSync(candidate).mtimeMs < opts.sinceMs) continue
        } catch { continue }
      }
      out.push({ sid: entry.slice(0, 8), path: candidate })
    }
  }

  collect(root)
  if (out.length > 0) return out

  // root 可能是 sessions 根目录——下探一层 slug
  let slugs: string[]
  try { slugs = readdirSync(root) } catch { return out }
  for (const slug of slugs) {
    if (isFixtureSlug(slug) || slug.startsWith('.')) continue
    try {
      if (!statSync(join(root, slug)).isDirectory()) continue
    } catch { continue }
    collect(join(root, slug))
  }
  return out
}

/** 读一个遥测文件里指定 kind 的行。kind 省略则返回全部可解析行。 */
export function readTelemetryRows(path: string, kind?: string): Record<string, unknown>[] {
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return [] }
  const rows: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const o = parseTelemetryLine(line)
    if (!o) continue
    if (kind !== undefined && o.kind !== kind) continue
    rows.push(o)
  }
  return rows
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 读取语料内全部 vitals-lite 帧，六维缺任一项的帧丢弃（不补默认值）。 */
export function readVitalsLite(
  root: string,
  opts: { sinceMs?: number } = {},
): VitalsFrame[] {
  const frames: VitalsFrame[] = []
  for (const { sid, path } of listTelemetryFiles(root, { sinceMs: opts.sinceMs })) {
    for (const o of readTelemetryRows(path, 'vitals-lite')) {
      const s = o.sensorium
      if (typeof s !== 'object' || s === null) continue
      const dims = {} as Record<SensoriumDim, number>
      let complete = true
      for (const d of SENSORIUM_DIMS) {
        const v = num((s as Record<string, unknown>)[d])
        if (v === null) { complete = false; break }
        dims[d] = v
      }
      if (!complete) continue
      frames.push({
        sid,
        turn: num(o.turn),
        sensorium: dims,
        ctxRatio: num(o.ctxRatio),
        cvmOverheadRatio: num(o.cvmOverheadRatio),
        throttled: o.throttled === true,
        confidenceMeasured: o.confidenceMeasured === true,
        advisories: num(o.advisories),
      })
    }
  }
  return frames
}

// ─── 统计 ────────────────────────────────────────────────────────────

/** 分位数（最近秩）。空数组返回 null，不返回 0——0 会被误读成实测值。 */
export function quantile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * 取值频次（按 2 位小数分桶）。
 *
 * 探针必须看这个而不只看分位数：近似离散的维度（confidence 只有 5 种取值）
 * 用分位数描述会读出虚假的「双峰异常」。
 */
export function valueHistogram(values: number[]): Array<{ value: number; count: number; share: number }> {
  const counts = new Map<number, number>()
  for (const v of values) {
    const key = Math.round(v * 100) / 100
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: count / values.length }))
    .sort((a, b) => b.count - a.count)
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}
