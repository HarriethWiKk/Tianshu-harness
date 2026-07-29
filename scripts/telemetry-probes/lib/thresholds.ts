/**
 * 六维阈值判据的发现与评估 —— 纯逻辑，无 IO 副作用之外的状态，可单测。
 *
 * 判据从源码自动发现而非硬编码：硬编码的判据表会随重构漂移，探针就变成谎报器。
 *
 * 最大的正确性风险是**假阳性**：六维之外同名字段极多（claim.confidence /
 * route.confidence / 测试失败分类置信度 / 记忆条目置信度…）。混进来就会拿六维
 * 分布去评判非六维判据——正是本探针要防的那类错误。故接收者走白名单，且所有
 * 排除项都要能列出来供审计，不静默丢弃。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SENSORIUM_DIMS, type SensoriumDim } from './session-telemetry.js'

export type Op = '<' | '<=' | '>' | '>='

export interface Site { file: string; line: number }

export interface Predicate {
  dim: SensoriumDim
  op: Op
  value: number
  /** 阈值来自命名常量而非字面量时记下常量名 */
  via?: string
  sites: Site[]
}

export interface RawMatch {
  receiver: string
  dim: SensoriumDim
  op: Op
  rhs: string
  line: number
}

const DIM_SET = new Set<string>(SENSORIUM_DIMS)
const DIMS_ALT = SENSORIUM_DIMS.join('|')
/** 接收者 + 六维 + 比较符 + 右值（字面量或标识符） */
const COMPARE_RE = new RegExp(
  String.raw`([\w$]+(?:\.[\w$]+)*)\.(${DIMS_ALT})\s*(<=|>=|<|>)\s*([\w$.]+)`, 'g')
const RECEIVER_ALIASES = new Set(['s', 'signals', 'vitals'])

/** 匹配位置是否落在字符串字面量内（提示词里常写 "complexity > 0.7" 这类说明文字）。 */
export function insideStringLiteral(line: string, index: number): boolean {
  let single = 0, double = 0, back = 0
  for (let i = 0; i < index; i++) {
    if (i > 0 && line[i - 1] === '\\') continue
    const c = line[i]
    if (c === "'") single++
    else if (c === '"') double++
    else if (c === '`') back++
  }
  return single % 2 === 1 || double % 2 === 1 || back % 2 === 1
}

/**
 * 接收者是否确为六维载体。
 *
 * 名字以 sensorium 结尾者自证，无条件认。短别名（s/signals/vitals）要旁证：
 * 文件引用了 Sensorium 类型，或同一接收者上访问了 ≥2 个六维——后者覆盖
 * `RoutineEffortSignals` 这类结构化子类型（不提 Sensorium 但确实是六维消费者）。
 */
export function isSensoriumReceiver(
  receiver: string,
  evidence: { fileMentionsType: boolean; dimsOnReceiver: number },
): boolean {
  const last = receiver.split('.').pop() ?? ''
  if (last.toLowerCase().endsWith('sensorium')) return true
  if (!RECEIVER_ALIASES.has(last)) return false
  return evidence.fileMentionsType || evidence.dimsOnReceiver >= 2
}

/** 0–1 区间的数值字面量，否则 null。 */
export function literalOf(token: string): number | null {
  if (!/^(?:\d*\.\d+|[01])$/.test(token)) return null
  const v = Number(token)
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
}

/** 扫一个文件里的六维比较式，跳过注释与字符串字面量。 */
export function scanFile(text: string): RawMatch[] {
  const out: RawMatch[] = []
  const lines = text.split('\n')
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    // 粗粒度块注释状态机：足够挡住 JSDoc 里列举阈值的说明行
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    COMPARE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = COMPARE_RE.exec(raw)) !== null) {
      const [, receiver, dim, op, rhs] = m
      if (!DIM_SET.has(dim!)) continue
      if (insideStringLiteral(raw, m.index)) continue
      out.push({ receiver: receiver!, dim: dim as SensoriumDim, op: op as Op, rhs: rhs!, line: i + 1 })
    }
  }
  return out
}

/**
 * 命名常量表：`X = 0.3` 或 `key: 0.3`，全仓唯一取值才认。
 * 同名多处且取值不一则标 ambiguous —— 宁可列为盲点，不可猜错值。
 */
export function buildConstMap(texts: Iterable<string>): Map<string, number | 'ambiguous'> {
  const map = new Map<string, number | 'ambiguous'>()
  const decl = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*[=:]\s*(\d*\.\d+|[01])\b/g
  for (const text of texts) {
    decl.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = decl.exec(text)) !== null) {
      const name = m[1]!
      const v = literalOf(m[2]!)
      if (v === null) continue
      const prev = map.get(name)
      if (prev === undefined) map.set(name, v)
      else if (prev !== v) map.set(name, 'ambiguous')
    }
  }
  return map
}

/** 递归列出 .ts 源文件，排除测试与声明文件。 */
export function walkTs(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    if (entry === '__tests__' || entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    let isDir = false
    try { isDir = statSync(full).isDirectory() } catch { continue }
    if (isDir) walkTs(full, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

export interface Discovery {
  predicates: Predicate[]
  /** 接收者非六维而被排除——列出以便审计，不静默丢弃 */
  excluded: Array<{ expr: string; site: Site }>
  /** 阈值无法解析成字面量的六维判据——本探针的盲点 */
  unresolved: Array<{ expr: string; site: Site; reason: string }>
}

/** 单个文件的判据发现。文件内容与路径都由调用方给，便于单测。 */
export function discoverInFile(
  text: string,
  displayPath: string,
  consts: Map<string, number | 'ambiguous'>,
): { found: Array<Predicate & { sites: [Site] }> } & Omit<Discovery, 'predicates'> {
  const matches = scanFile(text)
  const fileMentionsType = text.includes('Sensorium')
  // 旁证：同一接收者在本文件被访问到的六维种数
  const dimsPerReceiver = new Map<string, Set<string>>()
  for (const mt of matches) {
    const last = mt.receiver.split('.').pop() ?? ''
    const set = dimsPerReceiver.get(last) ?? new Set<string>()
    set.add(mt.dim)
    dimsPerReceiver.set(last, set)
  }

  const found: Array<Predicate & { sites: [Site] }> = []
  const excluded: Discovery['excluded'] = []
  const unresolved: Discovery['unresolved'] = []

  for (const { receiver, dim, op, rhs, line } of matches) {
    const site: Site = { file: displayPath, line }
    const expr = `${receiver}.${dim} ${op} ${rhs}`
    const dimsOnReceiver = dimsPerReceiver.get(receiver.split('.').pop() ?? '')?.size ?? 0
    if (!isSensoriumReceiver(receiver, { fileMentionsType, dimsOnReceiver })) {
      excluded.push({ expr, site }); continue
    }

    let value = literalOf(rhs)
    let via: string | undefined
    if (value === null) {
      const resolved = consts.get(rhs.split('.').pop() ?? rhs)
      if (resolved === undefined) { unresolved.push({ expr, site, reason: '未找到常量定义' }); continue }
      if (resolved === 'ambiguous') { unresolved.push({ expr, site, reason: '常量多处定义且取值不一' }); continue }
      value = resolved
      via = rhs
    }
    found.push({ dim, op, value, via, sites: [site] })
  }
  return { found, excluded, unresolved }
}

/** 扫整个源码树，合并同判据的多个调用点。 */
export function discoverPredicates(srcRoot: string, repoRoot: string): Discovery {
  const files = walkTs(srcRoot)
  const texts = new Map<string, string>()
  for (const file of files) {
    try { texts.set(file, readFileSync(file, 'utf-8')) } catch { /* 读不到就跳过 */ }
  }
  const consts = buildConstMap(texts.values())

  const byKey = new Map<string, Predicate>()
  const excluded: Discovery['excluded'] = []
  const unresolved: Discovery['unresolved'] = []
  for (const [file, text] of texts) {
    const r = discoverInFile(text, relative(repoRoot, file), consts)
    excluded.push(...r.excluded)
    unresolved.push(...r.unresolved)
    for (const p of r.found) {
      const key = `${p.dim}${p.op}${p.value}`
      const existing = byKey.get(key)
      if (existing) {
        existing.sites.push(p.sites[0])
        if (p.via !== undefined && existing.via === undefined) existing.via = p.via
      } else byKey.set(key, { ...p, sites: [...p.sites] })
    }
  }
  const predicates = [...byKey.values()].sort((a, b) =>
    a.dim === b.dim ? a.value - b.value : SENSORIUM_DIMS.indexOf(a.dim) - SENSORIUM_DIMS.indexOf(b.dim))
  return { predicates, excluded, unresolved }
}

// ─── 评估 ────────────────────────────────────────────────────────────

export function holds(p: Pick<Predicate, 'op' | 'value'>, v: number): boolean {
  switch (p.op) {
    case '<': return v < p.value
    case '<=': return v <= p.value
    case '>': return v > p.value
    case '>=': return v >= p.value
  }
}

export type Verdict = '死分支' | '恒真' | '近退化' | '有分辨'

export function verdictOf(rate: number): Verdict {
  if (rate === 0) return '死分支'
  if (rate === 1) return '恒真'
  if (rate < 0.02 || rate > 0.98) return '近退化'
  return '有分辨'
}

export interface Evaluated {
  p: Predicate
  /** 逐样本命中位图，用于阶梯塌缩比对 */
  hits: boolean[]
  count: number
  rate: number
  verdict: Verdict
}

export function evaluatePredicates(
  predicates: Predicate[],
  samples: Array<Record<SensoriumDim, number>>,
): Evaluated[] {
  return predicates.map(p => {
    const hits = samples.map(s => holds(p, s[p.dim]))
    const count = hits.filter(Boolean).length
    const rate = samples.length === 0 ? 0 : count / samples.length
    return { p, hits, count, rate, verdict: verdictOf(rate) }
  })
}

export interface Collapse { dim: SensoriumDim; a: string; b: string; rate: number }

/**
 * 阶梯塌缩：同维、同方向、相邻阈值命中**完全相同**的样本集。
 * 只比计数不够——计数相同而样本不同仍是真分级，故逐位比对。
 */
export function detectCollapsedLadders(evaluated: Evaluated[]): Collapse[] {
  const out: Collapse[] = []
  for (const dim of SENSORIUM_DIMS) {
    for (const dir of [['<', '<='], ['>', '>=']] as Op[][]) {
      const group = evaluated
        .filter(e => e.p.dim === dim && dir.includes(e.p.op))
        .sort((a, b) => a.p.value - b.p.value)
      for (let i = 1; i < group.length; i++) {
        const lo = group[i - 1]!, hi = group[i]!
        if (lo.count !== hi.count) continue
        if (lo.hits.some((h, idx) => h !== hi.hits[idx])) continue
        out.push({
          dim,
          a: `${dim} ${lo.p.op} ${lo.p.value}`,
          b: `${dim} ${hi.p.op} ${hi.p.value}`,
          rate: lo.rate,
        })
      }
    }
  }
  return out
}
