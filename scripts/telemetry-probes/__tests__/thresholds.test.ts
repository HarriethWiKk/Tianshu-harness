/**
 * 阈值发现/评估的回归测试。
 *
 * 用例基本都对应实跑中真出现过的坑：`route.confidence` 被当成六维、
 * `RoutineEffortSignals` 这类结构化子类型被误杀、JSDoc 里列举的阈值被当代码。
 * 探针一旦谎报，据它改阈值就会重演「按聚合抱怨改传感器」的事故。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConstMap, detectCollapsedLadders, discoverInFile, evaluatePredicates,
  holds, insideStringLiteral, isSensoriumReceiver, literalOf, scanFile, verdictOf,
} from '../lib/thresholds.js'
import { isFixtureSlug, parseTelemetryLine, quantile, valueHistogram } from '../lib/session-telemetry.js'

const NO_CONSTS = new Map<string, number | 'ambiguous'>()

test('scanFile 跳过注释与字符串字面量里的阈值', () => {
  const src = [
    '// s.momentum < 0.9 行注释不算',
    '/*',
    ' * Enabled only when Sensorium.complexity > 0.5.',
    ' */',
    'const label = "complexity > 0.7 说明文字"',
    'if (s.confidence < 0.4) return',
  ].join('\n')
  const found = scanFile(src)
  assert.equal(found.length, 1)
  assert.equal(found[0]!.dim, 'confidence')
  assert.equal(found[0]!.rhs, '0.4')
  assert.equal(found[0]!.line, 6)
})

test('scanFile 收下同一行的多个判据并记住接收者', () => {
  const found = scanFile('const routine = signals.complexity <= 0.3 && signals.momentum >= 0.7')
  assert.equal(found.length, 2)
  assert.deepEqual(found.map(f => f.receiver), ['signals', 'signals'])
  assert.deepEqual(found.map(f => f.op), ['<=', '>='])
})

test('insideStringLiteral 只在引号未闭合处为真', () => {
  const line = 'const a = "x", b = s.confidence < 0.4'
  assert.equal(insideStringLiteral(line, line.indexOf('s.confidence')), false)
  const inside = 'const a = "s.confidence < 0.4"'
  assert.equal(insideStringLiteral(inside, inside.indexOf('s.confidence')), true)
})

test('isSensoriumReceiver: 名字自证的接收者无条件认', () => {
  const noEvidence = { fileMentionsType: false, dimsOnReceiver: 1 }
  assert.equal(isSensoriumReceiver('sensorium', noEvidence), true)
  assert.equal(isSensoriumReceiver('ctx.snapshot.sensorium', noEvidence), true)
  assert.equal(isSensoriumReceiver('nextSensorium', noEvidence), true)
})

test('isSensoriumReceiver: 短别名要旁证，结构化子类型靠多维访问过关', () => {
  // RoutineEffortSignals 不提 Sensorium，但同一接收者上有 3 个六维
  assert.equal(isSensoriumReceiver('signals', { fileMentionsType: false, dimsOnReceiver: 3 }), true)
  assert.equal(isSensoriumReceiver('s', { fileMentionsType: true, dimsOnReceiver: 1 }), true)
  assert.equal(isSensoriumReceiver('s', { fileMentionsType: false, dimsOnReceiver: 1 }), false)
})

test('isSensoriumReceiver: 同名非六维字段一概不认', () => {
  const strong = { fileMentionsType: true, dimsOnReceiver: 3 }
  for (const r of ['route', 'claim', 'discovered', 'input', 'state', 'existing', 'e', 'failures[0]!']) {
    assert.equal(isSensoriumReceiver(r, strong), false, `${r} 不该被当成六维载体`)
  }
})

test('discoverInFile 排除非六维接收者但列出来供审计', () => {
  const src = [
    'import type { Sensorium } from "./sensorium.js"',
    'if (route.confidence >= 0.6) act()',
    'if (s.stability < 0.3) kick()',
  ].join('\n')
  const r = discoverInFile(src, 'a.ts', NO_CONSTS)
  assert.equal(r.found.length, 1)
  assert.equal(r.found[0]!.dim, 'stability')
  assert.equal(r.excluded.length, 1)
  assert.equal(r.excluded[0]!.expr, 'route.confidence >= 0.6')
  assert.equal(r.excluded[0]!.site.line, 2)
})

test('discoverInFile 解析唯一命名常量，歧义常量记为盲点', () => {
  const consts = new Map<string, number | 'ambiguous'>([
    ['LOW_STABILITY_THRESHOLD', 0.5],
    ['threshold', 'ambiguous'],
  ])
  const src = [
    'if (sensorium.stability < LOW_STABILITY_THRESHOLD) return true',
    'if (sensorium.complexity < threshold) return',
    'if (sensorium.momentum < UNKNOWN_CONST) return',
  ].join('\n')
  const r = discoverInFile(src, 'a.ts', consts)
  assert.equal(r.found.length, 1)
  assert.equal(r.found[0]!.value, 0.5)
  assert.equal(r.found[0]!.via, 'LOW_STABILITY_THRESHOLD')
  assert.deepEqual(r.unresolved.map(u => u.reason), ['常量多处定义且取值不一', '未找到常量定义'])
})

test('buildConstMap 收字面量声明，取值冲突标 ambiguous', () => {
  const map = buildConstMap([
    'const LOW = 0.5',
    'const THRESHOLDS = { escalateConfidence: 0.3, autoApproveConfidence: 0.8 }',
    'const DUP = 0.2',
    'const DUP = 0.9',
    'const NOT_RATIO = 42',
  ])
  assert.equal(map.get('LOW'), 0.5)
  assert.equal(map.get('escalateConfidence'), 0.3)
  assert.equal(map.get('autoApproveConfidence'), 0.8)
  assert.equal(map.get('DUP'), 'ambiguous')
  assert.equal(map.has('NOT_RATIO'), false, '0–1 之外的数不是比率阈值')
})

test('literalOf 只认 0–1 区间', () => {
  assert.equal(literalOf('0.35'), 0.35)
  assert.equal(literalOf('.7'), 0.7)
  assert.equal(literalOf('1'), 1)
  assert.equal(literalOf('42'), null)
  assert.equal(literalOf('threshold'), null)
})

test('holds 区分严格与非严格比较', () => {
  assert.equal(holds({ op: '<', value: 0.3 }, 0.3), false)
  assert.equal(holds({ op: '<=', value: 0.3 }, 0.3), true)
  assert.equal(holds({ op: '>', value: 0.3 }, 0.3), false)
  assert.equal(holds({ op: '>=', value: 0.3 }, 0.3), true)
})

test('verdictOf 只把 0% / 100% 判成死分支与恒真', () => {
  assert.equal(verdictOf(0), '死分支')
  assert.equal(verdictOf(1), '恒真')
  assert.equal(verdictOf(0.003), '近退化')
  assert.equal(verdictOf(0.983), '近退化')
  assert.equal(verdictOf(0.5), '有分辨')
})

test('evaluatePredicates 按样本算发火率', () => {
  const samples = [0.1, 0.2, 0.9].map(stability => ({
    momentum: 0.5, pressure: 0.5, confidence: 0.5, complexity: 0.5, freshness: 0.5, stability,
  }))
  const [dead, live] = evaluatePredicates([
    { dim: 'stability', op: '<', value: 0.05, sites: [] },
    { dim: 'stability', op: '<', value: 0.3, sites: [] },
  ], samples)
  assert.equal(dead!.verdict, '死分支')
  assert.equal(live!.count, 2)
  assert.equal(Number(live!.rate.toFixed(4)), 0.6667)
})

test('detectCollapsedLadders: 计数相同但样本不同不算塌缩', () => {
  const mk = (hits: boolean[], value: number, op: '<' | '>'): Parameters<typeof detectCollapsedLadders>[0][number] => ({
    p: { dim: 'complexity', op, value, sites: [] },
    hits,
    count: hits.filter(Boolean).length,
    rate: hits.filter(Boolean).length / hits.length,
    verdict: '有分辨',
  })
  // 同为 1 命中但落在不同样本上 —— 仍是真分级
  assert.deepEqual(detectCollapsedLadders([mk([true, false], 0.3, '<'), mk([false, true], 0.4, '<')]), [])
  // 命中集完全一致 —— 分级是假的
  const collapsed = detectCollapsedLadders([mk([true, false], 0.3, '<'), mk([true, false], 0.4, '<')])
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0]!.a, 'complexity < 0.3')
  assert.equal(collapsed[0]!.b, 'complexity < 0.4')
})

test('detectCollapsedLadders 不跨比较方向配对', () => {
  const base = { dim: 'confidence' as const, sites: [] }
  const hits = [true, false]
  const rows = [
    { p: { ...base, op: '<' as const, value: 0.3 }, hits, count: 1, rate: 0.5, verdict: '有分辨' as const },
    { p: { ...base, op: '>' as const, value: 0.6 }, hits, count: 1, rate: 0.5, verdict: '有分辨' as const },
  ]
  assert.deepEqual(detectCollapsedLadders(rows), [])
})

test('parseTelemetryLine 剥掉完整性后缀', () => {
  assert.deepEqual(parseTelemetryLine('{"kind":"vitals-lite"}'), { kind: 'vitals-lite' })
  assert.deepEqual(parseTelemetryLine('{"kind":"vitals-lite"}|0123456789abcdef'), { kind: 'vitals-lite' })
  assert.equal(parseTelemetryLine(''), null)
  assert.equal(parseTelemetryLine('not json'), null)
  // 后缀长度/字符集不对就不是完整性后缀，别乱剥
  assert.equal(parseTelemetryLine('{"a":1}|xyz'), null)
})

test('isFixtureSlug 挡掉单测与 benchmark 语料', () => {
  assert.equal(isFixtureSlug('tmp-abc123'), true)
  assert.equal(isFixtureSlug('repo-abc123'), true)
  assert.equal(isFixtureSlug('bench_task3_deepseek-abc'), true)
  assert.equal(isFixtureSlug('opencode-tui-522c83'), false)
})

test('quantile 空数组返回 null 而不是 0', () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([0.1, 0.5, 0.9], 0.5), 0.5)
})

test('valueHistogram 按 2 位小数分桶并按频次降序', () => {
  const hist = valueHistogram([1, 1, 1, 0.504, 0.496])
  assert.equal(hist[0]!.value, 1)
  assert.equal(hist[0]!.count, 3)
  assert.equal(Number(hist[0]!.share.toFixed(1)), 0.6)
  assert.equal(hist[1]!.value, 0.5, '0.504 与 0.496 应同桶')
  assert.equal(hist[1]!.count, 2)
})
