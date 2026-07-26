#!/usr/bin/env tsx
/**
 * hexagram-divergence-probe.ts — 卦象设计（docs/design/2026-07-25-hexagram-cvm-stage-doctrine.md）
 * 的 Phase −1 离线证据探针。
 *
 * 设计文档的核心价值前提是「四套阶段代理各读各的，收敛成一个读出有价值」，
 * 其量化指标是 agentDivergence。该前提当前**零数据**。本脚本从已落盘的历史
 * 会话离线回算，用数据回答三个问题：
 *
 *   Q1 四代理之间到底有多少独立信息？（冗余 → 收敛无价值；独立 → 收敛有价值）
 *   Q2 文档 2.2 的六爻阶段规则打在真实轨迹上，各阶段占比与抖振率是多少？
 *   Q3 「飞」与 CognitiveSeason.wuwei 的判定域实际重叠多少？
 *
 * 保真度纪律：四代理判定**全部直接调用生产函数**（createStarEvent /
 * classifyActivityMode / classifySeason / getDoomLoopLevel / computeStrategy），
 * 不在本脚本内重写任何判定逻辑。唯一由本脚本实现的是文档 2.2 的六爻规则本身
 * （尚无生产实现），且刻意**不带滞后带**——目的正是测出「不做滞后会抖成什么样」，
 * 为附录 B 的滞后参数提供标定基线。
 *
 * 已知近似（结论解读时必须带上）：
 *   A1 工具结果的 success/failed 未落盘 → 指纹统一用 outputClass='running' 重建。
 *      这会把「同调用先失败后成功」的两枚指纹并成一枚 → doom 检出偏**高**，
 *      故 season=reversal 是上界。脚本同时输出 doom 强制 none 的对照列。
 *   A2 filesModified 由编辑类工具入参重建，视同全部成功 → ActivityMode 偏向 build。
 *   A3 vitals-lite 的六维是 2 位小数 → 阈值边界（0.65/0.7）附近有量化误差。
 *   A4 decisiveness 未入 vitals-lite；四代理判定链均不消费该维，置 0.5 占位。
 *
 * 数据布局（AGENTS.md「Runtime Data Layout」）：
 *   <root>/<sid>.jsonl           会话主体（行尾可能带 |<hash> 完整性后缀）
 *   <root>/<sid>/sensorium.jsonl 遥测（需 RIVET_DEBUG_TELEMETRY=1 才有）
 *   <root>/<sid>.meta.json       元数据（compactEvents 提供 return 季窗口）
 *
 * 语料纪律：只取主会话（排除 `worker-` 前缀）。跨 slug 扫描时注意 `tmp-*` /
 * `repo-*`（cwd=/tmp、/repo）是单元测试 fixture，`*_task<N>_<model>-*` 是
 * benchmark 跑分——都不是真实使用轨迹，不得混入。
 *
 * 用法：
 *   npx tsx scripts/hexagram-divergence-probe.ts                # 当前项目会话目录
 *   npx tsx scripts/hexagram-divergence-probe.ts <sessions-dir>
 *   npx tsx scripts/hexagram-divergence-probe.ts --since-days=4 # 只取最近 N 天
 *   npx tsx scripts/hexagram-divergence-probe.ts --json         # 机读输出
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../src/config/paths.js'
import { computeStrategy, type Sensorium } from '../src/agent/sensorium.js'
import { createStarEvent } from '../src/agent/star-event.js'
import { buildStarPhaseContext } from '../src/agent/perception.js'
import { classifyActivityMode } from '../src/agent/convergence-detector.js'
import { classifySeason } from '../src/agent/cognitive-season.js'
import { fingerprintToolCall, getDoomLoopLevel, type DoomLoopLevel } from '../src/agent/trace-store.js'
import { toolTargetFromInput } from '../src/agent/tool-target.js'
import { PHASE_CLASS_MAP } from '../src/agent/turn-step-producer.js'
import { isInProductionFlow } from '../src/agent/production-flow.js'

// ── 生产常量镜像（值来自源码，改动会被下方 assert 抓到） ──
/** tool-history-recorder.ts:40 — recentToolHistory 上限 */
const TOOL_HISTORY_CAP = 5
/** trace-store.ts:146 — toolFingerprints 上限 */
const FINGERPRINT_CAP = 20
/** 编辑类工具：命中即计入 filesModified（近似 A2） */
const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'hash_edit', 'ast_edit', 'multi_edit'])

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const root = args.filter(a => !a.startsWith('--'))[0] ?? sessionsDir(process.cwd())

// ── 解析 ──

function parseSessionLine(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) } catch { /* 带完整性后缀，剥了重试 */ }
  const sep = line.lastIndexOf('|')
  if (sep <= 0) return null
  try { return JSON.parse(line.slice(0, sep)) } catch { return null }
}

interface VitalsFrame {
  turn: number
  momentum: number; pressure: number; confidence: number; verificationCoverage: number
  complexity: number; freshness: number; stability: number
  confidenceMeasured: boolean
}

function readVitals(path: string): VitalsFrame[] {
  const out: VitalsFrame[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (o?.kind !== 'vitals-lite' || !o.sensorium) continue
    const s = o.sensorium
    out.push({
      turn: typeof o.turn === 'number' ? o.turn : 0,
      momentum: s.momentum ?? 0, pressure: s.pressure ?? 0, confidence: s.confidence ?? 0,
      verificationCoverage: s.verificationCoverage ?? s.confidence ?? 0,
      complexity: s.complexity ?? 0, freshness: s.freshness ?? 0, stability: s.stability ?? 0,
      confidenceMeasured: o.confidenceMeasured === true,
    })
  }
  return out
}

interface AssistantStep {
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
}

function readAssistantSteps(path: string): AssistantStep[] {
  const out: AssistantStep[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line) continue
    const o = parseSessionLine(line) as any
    if (o?.role !== 'assistant') continue
    const calls: AssistantStep['toolCalls'] = []
    for (const tc of o.tool_calls ?? []) {
      const name = tc?.function?.name
      if (typeof name !== 'string') continue
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(tc.function.arguments ?? '{}') } catch { /* 参数损坏按空入参 */ }
      calls.push({ name, input })
    }
    out.push({ toolCalls: calls })
  }
  return out
}

// ── 文档 2.2 六爻规则（探针实现，刻意无滞后带） ──

type Stage = 'indeterminate' | 'overreach' | 'vigil' | 'flow' | 'leap' | 'field' | 'hidden'
/** 有已存活代理为其命名的阶段（文档 2.2「与已有代理的关系」列） */
const AGENT_BACKED: ReadonlySet<Stage> = new Set<Stage>(['vigil', 'hidden'])

function classifyHexagramProbe(input: {
  s: Sensorium; vacuous: boolean; doom: DoomLoopLevel
  filesModified: number; hasRecentEdit: boolean; turn: number
}): Stage {
  const { s, vacuous, doom, filesModified, hasRecentEdit, turn } = input
  const yang = (v: number) => v >= 0.65
  const yin = (v: number) => v <= 0.35

  // 不明：关键爻 void（文档 2.2 缺项三态，fail-closed）
  if (vacuous) return 'indeterminate'
  // 亢：环境超载 + 动量回落 / 自我感觉良好但压力越阈
  if (yang(s.pressure) && (yin(s.momentum) || yang(s.confidence))) return 'overreach'
  // 惕：稳定性崩塌或 doom 报警
  if (yin(s.stability) || doom !== 'none') return 'vigil'
  // 飞：心流峰值（附录 C 的 edit 区分器为必要条件）
  if (yang(s.momentum) && yang(s.stability) && !yang(s.pressure) && hasRecentEdit) return 'flow'
  // 跃：交付决断点
  if (filesModified > 0 && yang(s.confidence) && !yin(s.momentum)) return 'leap'
  // 见：路数初成（已有产出痕迹）
  if (filesModified > 0 || turn > 5) return 'field'
  return 'hidden'
}

// ── 信息论度量 ──

function entropy(counts: Map<string, number>): number {
  const n = [...counts.values()].reduce((a, b) => a + b, 0)
  if (n === 0) return 0
  let h = 0
  for (const c of counts.values()) { if (c > 0) { const p = c / n; h -= p * Math.log2(p) } }
  return h
}

function jointEntropy(pairs: Array<[string, string]>): number {
  const m = new Map<string, number>()
  for (const [a, b] of pairs) { const k = `${a}\u0000${b}`; m.set(k, (m.get(k) ?? 0) + 1) }
  return entropy(m)
}

function tally(xs: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

/** 归一化互信息 NMI = I(X;Y)/sqrt(H(X)H(Y))。任一侧无信息（H=0）返回 null。 */
function nmi(xs: string[], ys: string[]): number | null {
  const hx = entropy(tally(xs)), hy = entropy(tally(ys))
  if (hx === 0 || hy === 0) return null
  const hxy = jointEntropy(xs.map((x, i) => [x, ys[i]!] as [string, string]))
  return (hx + hy - hxy) / Math.sqrt(hx * hy)
}

/** 条件熵 H(Y|X)：0 = Y 完全由 X 决定（结构性冗余） */
function conditionalEntropy(xs: string[], ys: string[]): number {
  const hx = entropy(tally(xs))
  const hxy = jointEntropy(xs.map((x, i) => [x, ys[i]!] as [string, string]))
  return hxy - hx
}

// ── 单会话回放 ──

interface Row {
  session: string; turn: number
  starPhase: string; phaseClass: string; activityMode: string
  season: string; seasonNoDoom: string
  stage: Stage; vacuous: boolean; doom: DoomLoopLevel
  /** 生产判据（isInProductionFlow）——上界：status 未落盘，无失败可排除 */
  prodFlow: boolean
}

function replaySession(sid: string, maxTurns: number): { rows: Row[]; skipped: string | null } {
  const convo = join(root, `${sid}.jsonl`)
  const vitalsPath = join(root, sid, 'sensorium.jsonl')
  if (!existsSync(convo) || !existsSync(vitalsPath)) return { rows: [], skipped: 'missing-file' }

  const vitals = readVitals(vitalsPath)
  const steps = readAssistantSteps(convo)
  if (vitals.length === 0) return { rows: [], skipped: 'no-vitals' }
  // 1:1 对齐是本探针的数据有效性前提——不齐就整会话弃用，不做猜测性对齐。
  if (vitals.length !== steps.length) return { rows: [], skipped: `misaligned(${steps.length}/${vitals.length})` }

  const metaPath = join(root, `${sid}.meta.json`)
  let compactTurns: number[] = []
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    compactTurns = (meta.compactEvents ?? []).map((e: any) => e?.turn).filter((t: any) => typeof t === 'number')
  } catch { /* meta 缺失不致命 */ }

  const rows: Row[] = []
  let toolHistory: Array<{ tool: string; target: string; status: 'success'; argsHash: string }> = []
  let fingerprints: string[] = []
  const filesModified = new Set<string>()
  let hasEnteredHighComplexity = false

  for (let i = 0; i < vitals.length; i++) {
    const v = vitals[i]!
    const s: Sensorium = {
      momentum: v.momentum, pressure: v.pressure, confidence: v.confidence,
      verificationCoverage: v.verificationCoverage, decisiveness: 0.5,
      complexity: v.complexity, freshness: v.freshness, stability: v.stability,
      quality: {
        confidence: v.confidenceMeasured ? 'measured' : 'vacuous',
        momentum: 'measured', stability: v.confidenceMeasured ? 'measured' : 'partial',
        decisiveness: 'no-data',
      },
    } as Sensorium

    // 生产顺序：complexity 粘滞标志先置，再构造 starCtx（turn-perception.ts:133-157）
    if (s.complexity > 0.5) hasEnteredHighComplexity = true
    const strategy = computeStrategy(s)
    const starCtx = buildStarPhaseContext({
      turn: v.turn, maxTurns,
      recentTools: toolHistory.map(h => h.tool),
      shouldEscalate: strategy.shouldEscalate,
      hasEnteredHighComplexity,
    })
    const starPhase = createStarEvent(s, starCtx).phase
    const phaseClass = PHASE_CLASS_MAP[starPhase] ?? 'explore'
    const activityMode = classifyActivityMode(toolHistory, filesModified.size)
    const doom = getDoomLoopLevel(fingerprints)
    const recentCompactTurn = compactTurns.filter(t => t <= v.turn).pop() ?? null
    const season = classifySeason({
      turn: v.turn, doomLevel: doom, recentCompactTurn, sensoriumStability: s.stability,
    }).season
    const seasonNoDoom = classifySeason({
      turn: v.turn, doomLevel: 'none', recentCompactTurn, sensoriumStability: s.stability,
    }).season

    rows.push({
      session: sid, turn: v.turn, starPhase, phaseClass, activityMode, season, seasonNoDoom,
      stage: classifyHexagramProbe({
        s, vacuous: !v.confidenceMeasured, doom, filesModified: filesModified.size,
        hasRecentEdit: toolHistory.some(h => EDIT_TOOLS.has(h.tool)), turn: v.turn,
      }),
      vacuous: !v.confidenceMeasured, doom,
      prodFlow: isInProductionFlow(toolHistory),
    })

    // 本轮工具执行后的状态推进（下一帧的 perceive 才看得到，与生产同序）
    for (const call of steps[i]!.toolCalls) {
      toolHistory.push({
        tool: call.name, target: toolTargetFromInput(call.name, call.input),
        status: 'success', argsHash: '',
      })
      if (toolHistory.length > TOOL_HISTORY_CAP) toolHistory = toolHistory.slice(-TOOL_HISTORY_CAP)
      fingerprints = [...fingerprints, fingerprintToolCall(call.name, call.input, 'running')].slice(-FINGERPRINT_CAP)
      if (EDIT_TOOLS.has(call.name)) {
        const p = call.input.file_path ?? call.input.path
        if (typeof p === 'string') filesModified.add(p)
      }
    }
  }
  return { rows, skipped: null }
}

// ── 主流程 ──

if (!existsSync(root)) {
  console.error(`会话目录不存在：${root}`)
  process.exit(1)
}

// maxTurns 只影响 StarPhase 的 isFinalTurn（→ yaoguang-delivering）。
// 实测会话 turn 会超过配置值，该判据语义存疑——用 --max-turns 做敏感性对照。
let maxTurns = 200
try {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), '.rivet', 'config.json'), 'utf-8'))
  if (typeof cfg?.agent?.maxTurns === 'number') maxTurns = cfg.agent.maxTurns
} catch { /* 用默认 200（src/config/default.ts:100） */ }
const maxTurnsFlag = args.find(a => a.startsWith('--max-turns='))
if (maxTurnsFlag) maxTurns = Number(maxTurnsFlag.split('=')[1])

// 时间窗口：以遥测文件 mtime 为准（会话最后一次落帧的时刻）
const sinceFlag = args.find(a => a.startsWith('--since-days='))
const sinceDays = sinceFlag ? Number(sinceFlag.split('=')[1]) : null
const sinceMs = sinceDays === null ? null : Date.now() - sinceDays * 86_400_000

const telemetryMtime = (sid: string) => statSync(join(root, sid, 'sensorium.jsonl')).mtimeMs
const sids = readdirSync(root)
  .filter(name => existsSync(join(root, name, 'sensorium.jsonl')))
  .filter(name => !name.startsWith('worker-'))
  .filter(name => sinceMs === null || telemetryMtime(name) >= sinceMs)
  .sort((a, b) => telemetryMtime(b) - telemetryMtime(a))

const all: Row[] = []
const skips: Array<{ sid: string; why: string }> = []
for (const sid of sids) {
  const { rows, skipped } = replaySession(sid, maxTurns)
  if (skipped) { skips.push({ sid, why: skipped }); continue }
  all.push(...rows)
}

if (all.length === 0) {
  console.error(`没有可回放的会话（扫描 ${sids.length} 个候选，全部跳过）。遥测需 RIVET_DEBUG_TELEMETRY=1 才落盘。`)
  process.exit(1)
}

const col = (k: keyof Row) => all.map(r => String(r[k]))
const pct = (n: number, d = all.length) => `${(n / d * 100).toFixed(1)}%`

function dist(k: keyof Row): string {
  return [...tally(col(k)).entries()].sort((a, b) => b[1] - a[1])
    .map(([v, c]) => `${v} ${pct(c)}`).join(' · ')
}

const agents = ['starPhase', 'phaseClass', 'activityMode', 'season'] as const
const pairs: Array<[string, string, number | null]> = []
for (let i = 0; i < agents.length; i++) {
  for (let j = i + 1; j < agents.length; j++) {
    pairs.push([agents[i]!, agents[j]!, nmi(col(agents[i]!), col(agents[j]!))])
  }
}

// 信息损失：三个独立代理的联合熵 vs 合成后单一 stage 标签的熵
// （phaseClass 已证实为 starPhase 的函数，排除以免重复计数）
const jointThree = entropy(tally(all.map(r => `${r.starPhase}\u0000${r.activityMode}\u0000${r.season}`)))
const stageEntropy = entropy(tally(col('stage')))

// 阶段抖振：相邻帧（同会话内）阶段翻转比例
let adjacent = 0, flips = 0
for (let i = 1; i < all.length; i++) {
  if (all[i]!.session !== all[i - 1]!.session) continue
  adjacent++
  if (all[i]!.stage !== all[i - 1]!.stage) flips++
}

const flowRows = all.filter(r => r.stage === 'flow')
const flowInWuwei = flowRows.filter(r => r.season === 'wuwei').length
const agentBacked = all.filter(r => AGENT_BACKED.has(r.stage)).length

// 生产口径重叠：探针自定义的「飞」只是文档规则的复现，修复决策要看生产
// 已有的产出流判据（advisory-bus 阶段抑制用的那个）与 wuwei 的交集。
const prodFlowRows = all.filter(r => r.prodFlow)
const prodFlowInWuwei = prodFlowRows.filter(r => r.season === 'wuwei').length

if (asJson) {
  console.log(JSON.stringify({
    frames: all.length, sessions: sids.length - skips.length, skipped: skips,
    distributions: Object.fromEntries(([...agents, 'stage'] as const).map(k =>
      [k, Object.fromEntries(tally(col(k as keyof Row)))])),
    entropyBits: Object.fromEntries(agents.map(k => [k, entropy(tally(col(k)))])),
    nmi: pairs.map(([a, b, v]) => ({ a, b, nmi: v })),
    phaseClassGivenStarPhaseBits: conditionalEntropy(col('starPhase'), col('phaseClass')),
    stageFlipRate: adjacent ? flips / adjacent : null,
    flowInWuweiRate: flowRows.length ? flowInWuwei / flowRows.length : null,
    prodFlowRate: prodFlowRows.length / all.length,
    prodFlowInWuweiRate: prodFlowRows.length ? prodFlowInWuwei / prodFlowRows.length : null,
    agentBackedStageRate: agentBacked / all.length,
    vacuousRate: all.filter(r => r.vacuous).length / all.length,
  }, null, 2))
  process.exit(0)
}

const stamp = (t: number) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const usedSids = [...new Set(all.map(r => r.session))]
const times = usedSids.map(telemetryMtime).sort((a, b) => a - b)

console.log(`\n卦象 Phase −1 离线探针 — ${all.length} 帧 / ${usedSids.length} 会话`)
console.log(`语料目录：${root}`)
console.log(`时间窗口：${sinceDays === null ? '不限' : `最近 ${sinceDays} 天`}`
  + `　实际跨度：${stamp(times[0]!)} → ${stamp(times[times.length - 1]!)}`)
console.log(`纳入会话（遥测最后落帧时刻）：`)
for (const sid of usedSids) {
  const n = all.filter(r => r.session === sid).length
  console.log(`  ${stamp(telemetryMtime(sid))}  ${sid.slice(0, 8)}  ${String(n).padStart(4)} 帧`)
}
if (skips.length) console.log(`跳过 ${skips.length} 个：${skips.map(s => `${s.sid.slice(0, 8)}(${s.why})`).join(', ')}`)

console.log('\n── Q1 四代理各自说了什么（边际分布 + 熵） ──')
for (const k of agents) {
  console.log(`  ${k.padEnd(13)} H=${entropy(tally(col(k))).toFixed(2)}bit  ${dist(k)}`)
}
console.log(`  ${'seasonNoDoom'.padEnd(13)} （doom 强制 none 的对照）${dist('seasonNoDoom')}`)

console.log('\n── Q1 代理之间有多少独立信息（NMI：1=完全冗余，0=互相独立） ──')
for (const [a, b, v] of pairs) {
  console.log(`  ${a} ↔ ${b}`.padEnd(34) + (v === null ? 'n/a（一侧无信息）' : v.toFixed(3)))
}
console.log(`  H(phaseClass | starPhase) = ${conditionalEntropy(col('starPhase'), col('phaseClass')).toFixed(4)} bit  ← 0 表示结构性冗余`)
console.log(`  三独立代理联合熵 ${jointThree.toFixed(2)}bit → 合成单一卦象标签 ${stageEntropy.toFixed(2)}bit`
  + `（信息损失 ${((1 - stageEntropy / jointThree) * 100).toFixed(0)}%）`)
console.log(`  doom 分布：${dist('doom')}`)

console.log('\n── Q2 文档 2.2 六爻规则打在真实轨迹上（无滞后带） ──')
console.log(`  阶段分布：${dist('stage')}`)
console.log(`  相邻帧翻转率：${adjacent ? pct(flips, adjacent) : 'n/a'}（文档判据：>30% 说明滞后带不够）`)
const perSessionVacuous = [...new Set(all.map(r => r.session))].map(sid => {
  const rs = all.filter(r => r.session === sid)
  return rs.filter(r => r.vacuous).length / rs.length
}).sort((a, b) => a - b)
const median = perSessionVacuous[Math.floor(perSessionVacuous.length / 2)] ?? 0
console.log(`  空虚（vacuous→不明）占比：${pct(all.filter(r => r.vacuous).length)}`
  + `（按会话分：最低 ${(perSessionVacuous[0]! * 100).toFixed(0)}% / 中位 ${(median * 100).toFixed(0)}%`
  + ` / 最高 ${(perSessionVacuous[perSessionVacuous.length - 1]! * 100).toFixed(0)}%）`)
console.log(`  有已存活代理命名的阶段占比：${pct(agentBacked)}  ← 其余全部是新判定，无代理可收敛`)

console.log('\n── Q3 飞 / wuwei 判定域重叠 ──')
console.log(`  飞 ${flowRows.length} 帧，其中 season=wuwei 的 ${flowInWuwei} 帧（${flowRows.length ? pct(flowInWuwei, flowRows.length) : 'n/a'}）`)
console.log(`  wuwei 占全部帧：${pct(all.filter(r => r.season === 'wuwei').length)}`)
console.log(`  【生产口径】isInProductionFlow 命中 ${prodFlowRows.length} 帧（${pct(prodFlowRows.length)}），`
  + `其中 season=wuwei 的 ${prodFlowInWuwei} 帧（${prodFlowRows.length ? pct(prodFlowInWuwei, prodFlowRows.length) : 'n/a'}）`)
console.log(`  注：工具 status 未落遥测，回放一律记 success ⇒ 无失败可排除 ⇒ 命中数为上界\n`)
