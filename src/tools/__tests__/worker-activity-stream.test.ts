/**
 * T9 P3 实时上行: activity streamer 把 worker 原始活动事件折叠为
 * 有界的进度行 —— tool_use / tool_result 全量上行（有意义的进度拍点），
 * text/thinking 首次一行后静默（不再刷 deltas 计数）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createActivityStreamer, createDelegationActivityMapper, progressSnippet, shortOrderLabel } from '../worker-activity-stream.js'
import type { WorkerActivityEvent } from '../../agent/coordinator.js'
import type { DelegationActivity } from '../types.js'

function ev(over: Partial<WorkerActivityEvent>): WorkerActivityEvent {
  return { workOrderId: 'wo_abc', profile: 'code_scout', kind: 'text', ...over }
}

describe('shortOrderLabel', () => {
  it('strips wo_ prefix and takes the last colon segment', () => {
    assert.equal(shortOrderLabel('wo_abc123'), 'abc123')
    assert.equal(shortOrderLabel('team:T1'), 'T1')
    assert.equal(shortOrderLabel('wo_team:T2'), 'T2')
  })
})

describe('progressSnippet', () => {
  it('压平嵌入换行/制表符后截断（live region 单行契约）', () => {
    // 真实泄漏链：review 门 evidence 用 \n 拼接 → progressLine → 舰队面板活动行
    const multi = '⚠️ 审查未决 (auto)\nreview DID NOT run (infra failure)\n\tretry also failed'
    const snippet = progressSnippet(multi)
    assert.ok(!snippet.includes('\n'), '片段不得携带换行')
    assert.ok(!snippet.includes('\t'), '片段不得携带制表符')
    assert.match(snippet, /审查未决 \(auto\) review DID NOT run/)
  })

  it('按 max 截断并 trim 首尾空白', () => {
    assert.equal(progressSnippet('  abc  '), 'abc')
    assert.equal(progressSnippet('abcdef', 3), 'abc')
  })
})

describe('createActivityStreamer', () => {
  it('emits a line for every tool_use with the tool name', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_use', detail: 'read_file' }))
    stream(ev({ kind: 'tool_use', detail: 'grep' }))
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /abc·code_scout.*read_file/)
    assert.match(lines[1]!, /grep/)
  })

  it('text: 首个 delta 输出一行「写作中」，之后静默', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'text', detail: 'x' }))
    stream(ev({ kind: 'text', detail: 'y' }))
    stream(ev({ kind: 'text', detail: 'z' }))
    // 只有首次输出一行，后续不再刷屏
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /写作中/)
  })

  it('tool_result 输出完成行', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_result', detail: 'read_file' }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /完成/)
  })

  it('per work order 独立追踪 text 首次标志', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ workOrderId: 'wo_a', kind: 'text' }))
    stream(ev({ workOrderId: 'wo_b', kind: 'text' }))
    // 两个 worker 各自首次 text → 两行
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /\ba·/)
    assert.match(lines[1]!, /\bb·/)
  })

  it('thinking: 首次输出「思考中」', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'thinking', workOrderId: 'wo_x' }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /思考中/)
  })

  it('turn 计数心跳不产生文本行', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'turn', detail: '1200' }))
    assert.equal(lines.length, 0)
  })

  it('lifecycle: 每一轮补偿都出行，不像 retry 那样只报一次', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'lifecycle', detail: '续跑 1/2 · 轮次预算耗尽' }))
    stream(ev({ kind: 'lifecycle', detail: '续跑 2/2 · 轮次预算耗尽' }))
    assert.equal(lines.length, 2, '第二次续跑必须也可见——用户最想知道的就是它跑到第几次了')
    assert.match(lines[0]!, /续跑 1\/2/)
    assert.match(lines[1]!, /续跑 2\/2/)
  })
})

describe('createDelegationActivityMapper', () => {
  it('tool_use 累计计数，turn 事件更新 tokenCount', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('parent_1', a => acts.push(a))
    map(ev({ kind: 'tool_use', detail: 'read_file' }))
    map(ev({ kind: 'tool_use', detail: 'grep' }))
    map(ev({ kind: 'turn', detail: '1500' }))
    assert.equal(acts.length, 3)
    assert.equal(acts[0]!.toolUseCount, 1)
    assert.equal(acts[1]!.toolUseCount, 2)
    // turn 事件：无 progressLine、计数保留、tokenCount 到位
    assert.equal(acts[2]!.progressLine, undefined)
    assert.equal(acts[2]!.toolUseCount, 2)
    assert.equal(acts[2]!.tokenCount, 1500)
    assert.equal(acts[2]!.parentToolId, 'parent_1')
    assert.equal(acts[2]!.status, 'running')
  })

  it('per work order 独立计数；tokenCount 只增不减', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use' }))
    map(ev({ workOrderId: 'wo_b', kind: 'tool_use' }))
    map(ev({ workOrderId: 'wo_a', kind: 'turn', detail: '2000' }))
    map(ev({ workOrderId: 'wo_a', kind: 'turn', detail: '900' }))
    const a = acts.filter(x => x.workOrderId === 'wo_a')
    const b = acts.filter(x => x.workOrderId === 'wo_b')
    assert.equal(a[0]!.toolUseCount, 1)
    assert.equal(b[0]!.toolUseCount, 1)
    // 迟到的较小 token 快照不回退
    assert.equal(a[2]!.tokenCount, 2000)
  })

  it('objective 仅在首条 running 事件携带（查表或 event.objective）', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a), {
      objectiveOf: (id) => id === 'wo_a' ? 'find auth bugs' : undefined,
    })
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'grep' }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'read_file' }))
    map(ev({ workOrderId: 'wo_b', kind: 'tool_use', objective: 'from coordinator' }))
    map(ev({ workOrderId: 'wo_b', kind: 'text', detail: 'x' }))
    assert.equal(acts[0]!.objective, 'find auth bugs')
    assert.equal(acts[1]!.objective, undefined)
    assert.equal(acts[2]!.objective, 'from coordinator')
    assert.equal(acts[3]!.objective, undefined)
  })

  it('contract 仅在首条事件携带（event.contract 首选，contractOf 兜底）——死接线回归防线', () => {
    const contract = {
      objective: 'audit auth flow',
      profile: 'code_scout',
      scope: {},
      constraints: [],
      budget: { maxTurns: 8, timeoutMs: 120_000 },
      allowedToolsDigest: 'grep,read_file +2',
    }
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a), {
      contractOf: (id) => id === 'wo_fallback' ? contract : undefined,
    })
    // coordinator 随事件携带（生产主路径：objective 恒存在）
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'audit auth flow', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'audit auth flow', contract }))
    assert.deepEqual(acts[0]!.contract, contract)
    assert.equal(acts[1]!.contract, undefined, 'contract 只随首条事件转发')
    // 工具侧兜底查表（event.contract 缺席时）
    map(ev({ workOrderId: 'wo_fallback', kind: 'tool_use', objective: 'x' }))
    assert.deepEqual(acts[2]!.contract, contract)
  })

  it('objective 为空时 contract 仍只发一次——两者分开记账', () => {
    // objective 的「查不到就下条再试」是有意的（objectiveOf 首条可能还没就绪），
    // 但那道守卫曾连 contract 一起管：objective 恰好为空时 contract 跟着每条重发，
    // 下游按「首条才带」去重就会为同一 worker 反复打派发卡。
    const contract = {
      objective: 'audit auth flow',
      profile: 'code_scout',
      scope: {},
      constraints: [],
      budget: { maxTurns: 8, timeoutMs: 120_000 },
      allowedToolsDigest: 'grep,read_file +2',
    }
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    // objective 全程缺席（coordinator 未附带、无 objectiveOf 兜底）
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'text', contract }))
    assert.deepEqual(acts[0]!.contract, contract, '首条仍带 contract')
    assert.equal(acts[1]!.contract, undefined)
    assert.equal(acts[2]!.contract, undefined)
    assert.ok(acts.every(a => a.objective === undefined), 'objective 始终缺席（不影响 contract 记账）')
  })

  it('contract 晚到时补发一次（首条无、次条有）', () => {
    const contract = {
      objective: 'x',
      profile: 'code_scout',
      scope: {},
      constraints: [],
      budget: { maxTurns: 4, timeoutMs: 60_000 },
      allowedToolsDigest: 'grep +1',
    }
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'x' }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'x', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'x', contract }))
    assert.equal(acts[0]!.contract, undefined)
    assert.deepEqual(acts[1]!.contract, contract, '晚到的 contract 补发，不因 objective 已记账而被吞')
    assert.equal(acts[2]!.contract, undefined)
  })

  it('lifecycle 事件带阶段文案上行，且不污染工具/token 计数', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    map(ev({ kind: 'tool_use', detail: 'grep' }))
    map(ev({ kind: 'lifecycle', detail: '续跑 1/2 · 轮次预算耗尽' }))
    assert.equal(acts[1]!.eventKind, 'lifecycle')
    assert.match(acts[1]!.progressLine!, /续跑 1\/2/)
    assert.equal(acts[1]!.toolUseCount, 1, '补偿轮播报不是一次工具调用')
    assert.equal(acts[1]!.tokenCount, undefined)
  })
})
