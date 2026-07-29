/**
 * 分阶段计时「打开大会话」的历史冷读，定位事件循环被谁堵住。
 *
 * 关键区分：worker 里的 parse 不占主线程，但把结果搬回主线程的
 * structured clone 占——这条脚本把两者分开计时。
 *
 * 用法：npm exec -- tsx scripts/probe-history-load.mts <events.jsonl 路径>
 */
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { parseEventsJsonlRaw } from '../src/workers/cpu-tasks.js'
import { cpuPool } from '../src/workers/cpu-pool.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: tsx scripts/probe-history-load.mts <events.jsonl>')
  process.exit(1)
}

const MAX_EVENTS = 5000

function ms(t: number): string {
  return `${t.toFixed(1)}ms`.padStart(9)
}

async function main(): Promise<void> {
  let t = performance.now()
  const text = await readFile(file, 'utf8')
  const tRead = performance.now() - t
  console.log(`  readFile            ${ms(tRead)}   ${(text.length / 1048576).toFixed(2)} MB`)

  // 1) 内联 parse 全量——这是主线程被占住的时长（无 worker 时的行为）
  t = performance.now()
  const inline = parseEventsJsonlRaw(text)
  const tInline = performance.now() - t
  console.log(`  内联 parse 全量      ${ms(tInline)}   ${inline.length} 条（全程占主线程）`)

  // 2) cpuPool：parse 在 worker，但结果要 structured clone 回主线程。
  // 首次调用含 worker 冷启动，必须与稳态分开计时，否则会把启动开销
  // 错记成传输开销、修错地方。
  t = performance.now()
  const viaPool = (await cpuPool.run('parseEventsJsonlRaw', [text])) as unknown[]
  const tPoolCold = performance.now() - t
  console.log(`  cpuPool 首次         ${ms(tPoolCold)}   ${viaPool.length} 条（含 worker 冷启动）`)

  t = performance.now()
  await cpuPool.run('parseEventsJsonlRaw', [text])
  const tPoolWarm = performance.now() - t
  console.log(`  cpuPool 稳态         ${ms(tPoolWarm)}   （纯传输 + parse，worker 已在）`)

  // 主线程实际被占住多久：worker 忙的时候主线程本应能干别的，用一个
  // 高频计时器探针量真实的事件循环滞后。
  t = performance.now()
  let maxLag = 0
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    maxLag = Math.max(maxLag, now - last - 5)
    last = now
  }, 5)
  await cpuPool.run('parseEventsJsonlRaw', [text])
  clearInterval(tick)
  console.log(`  ↳ 其间事件循环最大滞后 ${maxLag.toFixed(1)}ms（这才是别的请求要等的时间）`)

  // 3) adoptLoadedEvents 的主线程后处理
  const evs = inline as { seq: number; type: string; data: Record<string, unknown> }[]
  t = performance.now()
  evs.sort((a, b) => a.seq - b.seq)
  const tSort = performance.now() - t
  console.log(`  sort 全量            ${ms(tSort)}`)

  t = performance.now()
  const known = new Set(evs.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)))
  const tSet = performance.now() - t
  console.log(`  knownArtifacts 全量  ${ms(tSet)}   命中 ${known.size} 条 artifact`)

  t = performance.now()
  const tail = evs.length > MAX_EVENTS ? evs.slice(evs.length - MAX_EVENTS) : evs
  const tSlice = performance.now() - t
  console.log(`  slice 尾部 ${MAX_EVENTS}      ${ms(tSlice)}`)

  t = performance.now()
  const body = JSON.stringify({ events: tail, lastSeq: evs[evs.length - 1]?.seq ?? 0 })
  const tStringify = performance.now() - t
  console.log(`  stringify 响应体     ${ms(tStringify)}   ${(body.length / 1024).toFixed(0)} kB`)

  // 4) 对照：只 parse 尾部所需的字节，全量只做 artifact 子串扫描
  t = performance.now()
  let cut = text.length
  for (let i = 0, n = 0; i < MAX_EVENTS + 1; i++) {
    const nl = text.lastIndexOf('\n', cut - 1)
    if (nl < 0) { cut = 0; break }
    cut = nl
    n++
    if (n > MAX_EVENTS) break
  }
  const tailText = text.slice(cut)
  const tailEvents = parseEventsJsonlRaw(tailText)
  const tTailParse = performance.now() - t

  t = performance.now()
  let scanned = 0
  for (const line of text.split('\n')) {
    if (line.includes('"type":"artifact"')) { JSON.parse(line); scanned++ }
  }
  const tScan = performance.now() - t
  console.log()
  console.log(`  [对照] 只 parse 尾部  ${ms(tTailParse)}   ${tailEvents.length} 条 / ${(tailText.length / 1024).toFixed(0)} kB`)
  console.log(`  [对照] artifact 扫描  ${ms(tScan)}   命中 ${scanned} 条`)
  // 5) 跨 worker 边界的搬运成本是否与条数成比例——决定「让 worker 只回传
  // 尾部」值不值。structuredClone 同时含序列化与反序列化，是这段开销的代理。
  t = performance.now()
  structuredClone(evs)
  const tCloneAll = performance.now() - t
  t = performance.now()
  structuredClone(tail)
  const tCloneTail = performance.now() - t
  console.log()
  console.log(`  [clone] 全量 ${evs.length} 条   ${ms(tCloneAll)}`)
  console.log(`  [clone] 尾部 ${tail.length} 条    ${ms(tCloneTail)}`)

  console.log()
  console.log(`  现状主线程占用  ≈ ${(tInline + tSort + tSet + tSlice + tStringify).toFixed(0)}ms（内联路径）`)
  console.log(`  对照方案占用    ≈ ${(tTailParse + tScan + tStringify).toFixed(0)}ms`)

  await cpuPool.shutdown?.()
}

void main().then(() => process.exit(0))
