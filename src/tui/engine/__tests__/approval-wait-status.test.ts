/**
 * 审批等待可观测化测试（app 级接线）。
 *
 * 背景：read_file 审批挂死事故（2d8b67ca）中，onApprovalRequired 返回无超时
 * Promise + 工具批看门狗 disarm，而 spinner 显示「思索中…」、分档提示升级到
 * 「No response — Ctrl+C to interrupt」——明明在等用户按 y/n，却引导用户杀会话。
 *
 * 契约：
 * 1. 审批挂起时 live 帧显示「等待审批 <tool>」；
 * 2. 审批挂起时绝不出现「No response — Ctrl+C」类误导性升级提示；
 * 3. 等待 ≥60s 时出现审批专属提示（不超时 + 按键指引）；
 * 4. 审批 resolve 后状态行恢复常规口径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'

const tick = () => new Promise(r => setTimeout(r, 10))

test('审批挂起 → live 帧显示「等待审批 <tool>」', async () => {
  const { app, out } = makeApp()
  void app.callbacks.onApprovalRequired!('1', 'read_file', { file_path: '/tmp/x' })
  await tick()
  const frame = stripAnsi(out.chunks.join(''))
  assert.ok(frame.includes('等待审批 read_file'), '应显示等待审批与工具名')
})

test('审批挂起 → 不出现「No response — Ctrl+C」误导提示', async () => {
  const { app, out, stdin } = makeApp()
  void app.callbacks.onApprovalRequired!('1', 'bash', { command: 'ls' })
  await tick()

  // 模拟长时间无 token 活动（原分档提示的触发条件）
  const ctrl = (app as unknown as { streamRenderController: { lastActivityMs: number } }).streamRenderController
  ctrl.lastActivityMs = Date.now() - 200_000
  out.clear()
  stdin.dataHandler!('\x1B[B') // ↓ 触发重绘
  await tick()

  const frame = stripAnsi(out.chunks.join(''))
  assert.ok(!frame.includes('No response'), '审批挂起时不得出现 No response 升级提示')
  assert.ok(!frame.includes('Ctrl+C to interrupt'), '审批挂起时不得引导用户中断会话')
})

test('审批等待 ≥60s → 出现「不会超时」审批专属提示', async () => {
  const { app, out, stdin } = makeApp()
  void app.callbacks.onApprovalRequired!('1', 'bash', { command: 'ls' })
  await tick()

  const ctrl = (app as unknown as {
    approvalIntentController: { approvalPending: { startMs: number } | null }
  }).approvalIntentController
  assert.ok(ctrl.approvalPending, '审批应挂起')
  ctrl.approvalPending!.startMs = Date.now() - 61_000
  out.clear()
  stdin.dataHandler!('\x1B[B') // ↓ 触发重绘
  await tick()

  const frame = stripAnsi(out.chunks.join(''))
  assert.ok(frame.includes('审批等待不会超时'), '长等待应显示审批专属提示')
  assert.ok(frame.includes('1m'), '应显示分钟粒度等待时长')
})

test('审批 resolve 后 → 状态行恢复常规口径', async () => {
  const { app, out, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'bash', { command: 'ls' }).then(r => { resolved = r })
  await tick()

  stdin.dataHandler!('y')
  await tick()
  assert.deepEqual(resolved, { approved: true }, 'y 应 approve')

  out.clear()
  ;(app as unknown as { renderLive: () => void }).renderLive()
  const frame = stripAnsi(out.chunks.join(''))
  assert.ok(!frame.includes('等待审批'), 'resolve 后不得残留等待审批文案')
})
