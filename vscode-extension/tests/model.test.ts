import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialChatState, reduceEvent, type ChatState } from '../webview-ui/src/model.ts'

function feed(events: Array<{ type: string; data: Record<string, unknown> }>): ChatState {
  let state = initialChatState
  let seq = 0
  for (const e of events) {
    state = reduceEvent(state, { seq: ++seq, ts: seq, type: e.type, data: e.data })
  }
  return state
}

test('连续 text_delta 并入同一 assistant 气泡', () => {
  const s = feed([
    { type: 'user', data: { text: '你好' } },
    { type: 'text_delta', data: { text: '天' } },
    { type: 'text_delta', data: { text: '枢' } },
  ])
  assert.equal(s.items.length, 2)
  assert.deepEqual(s.items[1], { kind: 'assistant', text: '天枢' })
})

test('tool_result 分块按 id 追加到对应 tool 卡', () => {
  const s = feed([
    { type: 'tool_use', data: { id: 't1', name: 'bash', input: { command: 'ls' } } },
    { type: 'text_delta', data: { text: 'x' } },
    { type: 'tool_result', data: { id: 't1', name: 'bash', isError: false, result: 'a\n' } },
    { type: 'tool_result', data: { id: 't1', name: 'bash', isError: false, result: 'b' } },
  ])
  const tool = s.items[0]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind === 'tool') {
    assert.equal(tool.result, 'a\nb')
    assert.equal(tool.isError, false)
  }
})

test('审批 required/resolved 按 requestId 配对并维护 pending 计数', () => {
  const s1 = feed([
    { type: 'approval_required', data: { requestId: 'r1', toolName: 'bash', input: { command: 'rm x' } } },
  ])
  assert.equal(s1.pendingApprovals, 1)
  const s2 = reduceEvent(s1, { seq: 9, ts: 9, type: 'approval_resolved', data: { requestId: 'r1', decision: 'deny' } })
  assert.equal(s2.pendingApprovals, 0)
  const card = s2.items[0]
  if (card?.kind === 'approval') assert.equal(card.decision, 'deny')
  else assert.fail('expected approval card')
})

test('未知事件类型透传忽略（向后兼容）', () => {
  const s = feed([
    { type: 'text_delta', data: { text: 'hi' } },
    { type: 'some_future_event', data: { anything: true } },
  ])
  assert.equal(s.items.length, 1)
})

test('plan_submitted 带 slug 出计划卡，同 slug 状态更新原位刷新', () => {
  const s1 = feed([
    { type: 'plan_submitted', data: { slug: 'p-1', title: '重构计划', status: 'submitted' } },
  ])
  assert.deepEqual(s1.items[0], { kind: 'plan', slug: 'p-1', title: '重构计划', status: 'submitted' })

  const s2 = reduceEvent(s1, {
    seq: 9, ts: 9, type: 'plan_submitted',
    data: { slug: 'p-1', title: '重构计划', status: 'rejected' },
  })
  assert.equal(s2.items.length, 1)
  assert.deepEqual(s2.items[0], { kind: 'plan', slug: 'p-1', title: '重构计划', status: 'rejected' })
})

test('plan_submitted 无 slug 时回退 info 提示（旧内核兼容）', () => {
  const s = feed([{ type: 'plan_submitted', data: {} }])
  assert.equal(s.items[0]?.kind, 'info')
})

test('plan_draft 置起草指示，submit / 退出 plan mode 时清除', () => {
  const s1 = feed([
    { type: 'plan_mode', data: { state: 'planning' } },
    { type: 'plan_draft', data: { slug: 'p-1' } },
  ])
  assert.equal(s1.planDrafting, true)

  const submitted = reduceEvent(s1, {
    seq: 9, ts: 9, type: 'plan_submitted', data: { slug: 'p-1', title: 'T', status: 'submitted' },
  })
  assert.equal(submitted.planDrafting, false)

  const exited = reduceEvent(s1, { seq: 9, ts: 9, type: 'plan_mode', data: { state: 'off' } })
  assert.equal(exited.planDrafting, false)
})

test('text_delta 中插入 tool 后新 delta 开新气泡', () => {
  const s = feed([
    { type: 'text_delta', data: { text: '前' } },
    { type: 'tool_use', data: { id: 't1', name: 'read_file', input: {} } },
    { type: 'text_delta', data: { text: '后' } },
  ])
  assert.equal(s.items.length, 3)
  assert.deepEqual(s.items[2], { kind: 'assistant', text: '后' })
})

test('done 事件落终态，status 不再滞留 running（下条消息走 prompt 而非 steer）', () => {
  const running = feed([
    { type: 'user', data: { text: 'hi' } },
    { type: 'status', data: { status: 'running' } },
  ])
  assert.equal(running.status, 'running')

  const settled = reduceEvent(running, { seq: 9, ts: 9, type: 'done', data: { status: 'completed' } })
  assert.equal(settled.status, 'completed')
  assert.notEqual(settled.status, 'running')

  // 旧内核极端情况：done 缺 status 字段也不能卡 running
  const fallback = reduceEvent(running, { seq: 9, ts: 9, type: 'done', data: {} })
  assert.equal(fallback.status, 'idle')
})
