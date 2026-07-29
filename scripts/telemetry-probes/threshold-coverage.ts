/**
 * 六维阈值覆盖探针 —— 回答「这些判据在真实数据上到底分不分得开」。
 *
 * 背景：第一轮监测按聚合均值直接改传感器，结果 pressure 过冲、73.5% 样本钉死在
 * 0.50（docs/analysis/2026-07-28-阈值与分布脱钩.md）。根因是观测口径（均值）与
 * 消费口径（阈值比较）不匹配：均值正常的维度，其取值分布可能窄到让整条阈值阶梯
 * 退化成同一个判据。本探针把消费口径直接量出来。
 *
 * 三类结论：
 *   死分支    发火率 0%   —— 判据结构性不可达，含它的合取整条是死代码
 *   恒真分支  发火率 100% —— 判据不携带信息，等于没写
 *   阶梯塌缩  相邻阈值命中完全相同的样本集 —— 分级是假的
 *
 * 口径声明（读结论前必须知道）：
 *   1. 报告的是**单项**发火率。真实分支多为合取（`measured && dim > x`），故单项
 *      发火率是该分支发火率的**上界**：上界为 0 即可断定整条分支死；反之单项恒真
 *      不等于分支恒真。
 *   2. 判据从 src/ 自动发现，不硬编码，因此不随重构漂移；但只能评估字面量与可唯一
 *      解析的命名常量，其余列入「未评估」。
 *   3. 结论是**对该语料**成立，不是对代码成立。换语料（不同项目/不同使用强度）
 *      可能翻转。改阈值前先确认语料代表目标场景。
 *
 * 用法：
 *   npx tsx scripts/telemetry-probes/threshold-coverage.ts                # 当前项目会话目录
 *   npx tsx scripts/telemetry-probes/threshold-coverage.ts <sessions-dir>
 *   npx tsx scripts/telemetry-probes/threshold-coverage.ts --since-days=2
 *   npx tsx scripts/telemetry-probes/threshold-coverage.ts --json
 *   npx tsx scripts/telemetry-probes/threshold-coverage.ts --strict       # 有死/恒真分支时 exit 1
 *
 * 数据前提：sensorium.jsonl 需 RIVET_DEBUG_TELEMETRY=1 才落盘。
 */

import { join } from 'node:path'
import {
  SENSORIUM_DIMS, parseProbeArgs, readVitalsLite, valueHistogram,
  quantile, mean, pct,
} from './lib/session-telemetry.js'
import {
  discoverPredicates, evaluatePredicates, detectCollapsedLadders, type Evaluated,
} from './lib/thresholds.js'

function bar(rate: number, width = 20): string {
  return '█'.repeat(Math.round(rate * width)) + '·'.repeat(width - Math.round(rate * width))
}

function main(): void {
  const args = parseProbeArgs()
  const strict = process.argv.slice(2).includes('--strict')
  const repoRoot = join(import.meta.dirname, '..', '..')

  const frames = readVitalsLite(args.root, { sinceMs: args.sinceMs })
  if (frames.length === 0) {
    console.error(`no vitals-lite frames under ${args.root}`)
    console.error('遥测需 RIVET_DEBUG_TELEMETRY=1 才落盘；也可显式传入会话目录。')
    process.exit(2)
  }

  const { predicates, excluded, unresolved } = discoverPredicates(join(repoRoot, 'src'), repoRoot)
  const evaluated = evaluatePredicates(predicates, frames.map(f => f.sensorium))
  const collapsed = detectCollapsedLadders(evaluated)

  const dims = SENSORIUM_DIMS.map(dim => {
    const values = frames.map(f => f.sensorium[dim])
    const hist = valueHistogram(values)
    return {
      dim,
      distinct: hist.length,
      min: Math.min(...values),
      max: Math.max(...values),
      p50: quantile(values, 0.5)!,
      mean: mean(values)!,
      top: hist[0]!,
    }
  })

  const sessions = new Set(frames.map(f => f.sid)).size
  const dead = evaluated.filter(e => e.verdict === '死分支')
  const always = evaluated.filter(e => e.verdict === '恒真')

  if (args.json) {
    console.log(JSON.stringify({
      frames: frames.length, sessions, root: args.root, dims,
      predicates: evaluated.map(e => ({
        predicate: `${e.p.dim} ${e.p.op} ${e.p.value}`,
        via: e.p.via, rate: e.rate, count: e.count, verdict: e.verdict, sites: e.p.sites,
      })),
      collapsed, excluded, unresolved,
    }, null, 2))
    if (strict && (dead.length > 0 || always.length > 0)) process.exit(1)
    return
  }

  console.log(`\n六维阈值覆盖探针  ${frames.length} 帧 / ${sessions} 会话  root=${args.root}\n`)

  console.log('维度分布（消费口径看的是取值集合，不是均值）')
  console.log('  维度        取值数  范围         p50    均值   最高频值')
  for (const d of dims) {
    console.log(
      `  ${d.dim.padEnd(11)} ${String(d.distinct).padStart(5)}  ` +
      `${d.min.toFixed(2)}–${d.max.toFixed(2)}   ` +
      `${d.p50.toFixed(2)}   ${d.mean.toFixed(2)}   ` +
      `${d.top.value.toFixed(2)} (${pct(d.top.share)})`,
    )
  }

  console.log(`\n判据发火率（${predicates.length} 个，从 src/ 自动发现；单项发火率是所在分支的上界）`)
  let lastDim = ''
  for (const e of evaluated) {
    if (e.p.dim !== lastDim) { console.log(); lastDim = e.p.dim }
    const flag = e.verdict === '有分辨' ? '' : `  ← ${e.verdict}`
    const via = e.p.via === undefined ? '' : `  [${e.p.via}]`
    console.log(
      `  ${`${e.p.dim} ${e.p.op} ${e.p.value}`.padEnd(24)} ${bar(e.rate)} ` +
      `${pct(e.rate).padStart(6)} (${e.count})${via}${flag}`,
    )
    console.log(`  ${' '.repeat(24)} ${e.p.sites.slice(0, 2).map(s => `${s.file}:${s.line}`).join('  ')}` +
      `${e.p.sites.length > 2 ? `  +${e.p.sites.length - 2} 处` : ''}`)
  }

  if (unresolved.length > 0) {
    console.log(`\n未评估 ${unresolved.length} 处（探针盲点：阈值非字面量且解析不出常量）`)
    for (const u of unresolved) console.log(`  ${u.expr.padEnd(46)} ${u.site.file}:${u.site.line}  ${u.reason}`)
  }
  if (excluded.length > 0) {
    console.log(`\n已排除 ${excluded.length} 处（同名字段但接收者非六维，勿计入）`)
    for (const x of excluded) console.log(`  ${x.expr.padEnd(46)} ${x.site.file}:${x.site.line}`)
  }

  const siteCount = (es: Evaluated[]): number => es.reduce((n, e) => n + e.p.sites.length, 0)
  console.log('\n结论')
  if (dead.length > 0) {
    console.log(`  死分支 ${dead.length} 个判据 / ${siteCount(dead)} 处调用点 —— 含以下任一判据的合取整条不可达：`)
    for (const e of dead) console.log(`    ${e.p.dim} ${e.p.op} ${e.p.value}   ${e.p.sites.map(s => `${s.file}:${s.line}`).join('  ')}`)
  }
  if (always.length > 0) {
    console.log(`  恒真 ${always.length} 个判据 / ${siteCount(always)} 处调用点 —— 判据不携带信息：`)
    for (const e of always) console.log(`    ${e.p.dim} ${e.p.op} ${e.p.value}   ${e.p.sites.map(s => `${s.file}:${s.line}`).join('  ')}`)
  }
  if (collapsed.length > 0) {
    console.log(`  阶梯塌缩 ${collapsed.length} 处 —— 相邻阈值命中同一批样本，分级是假的：`)
    for (const c of collapsed) console.log(`    ${c.a}  ≡  ${c.b}   (同为 ${pct(c.rate)})`)
  }
  if (dead.length === 0 && always.length === 0 && collapsed.length === 0) {
    console.log('  未发现死分支 / 恒真分支 / 阶梯塌缩。')
  }
  console.log()

  if (strict && (dead.length > 0 || always.length > 0)) process.exit(1)
}

main()
