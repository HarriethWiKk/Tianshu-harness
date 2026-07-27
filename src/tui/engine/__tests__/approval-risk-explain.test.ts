/**
 * Ctrl+E 风险解释的交互契约（Wave 1-2）。
 *
 * 这里测的是「按需」这件事本身，以及一个只在真实时序下才暴露的正确性问题：
 * 解释是异步的，用户完全可能在结果回来前就批完并进入下一条待批项——迟到的结论
 * 绝不能盖到新的命令上。把 A 命令的「低风险」挂在 B 命令上，比不给解释危险得多。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'
import type { RiskExplanation } from '../../../agent/risk-explain.js'

interface AppInternals {
  approvalIntentController: {
    approvalPending: { id: string } | null
    riskExplanation: RiskExplanation | null
    riskExplainPending: boolean
    riskExplainError: string
  }
  handleApprovalRequired(id: string, name: string, input: Record<string, unknown>): Promise<unknown>
}

function makeApp() {
  const out = new MockOut(100, 30)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 30, modelName: 'test',
  })
  app.start()
  return { app, out, stdin, internals: app as unknown as AppInternals }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
const LOW: RiskExplanation = { level: 'low', lines: ['只读操作。'] }

test('未按 Ctrl+E 时不发请求——按需，不预生成', async () => {
  const { app, internals } = makeApp()
  let calls = 0
  app.setRiskExplainer(async () => { calls++; return LOW })

  void internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()

  assert.equal(calls, 0, '弹出审批本身不该烧一次请求')
  assert.equal(internals.approvalIntentController.riskExplanation, null)
})

test('按 Ctrl+E 才拉取，结果落到当前待批项', async () => {
  const { app, stdin, internals } = makeApp()
  app.setRiskExplainer(async () => LOW)

  void internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()
  stdin.dataHandler!('\x05') // Ctrl+E
  await tick(30)

  assert.equal(internals.approvalIntentController.riskExplanation?.level, 'low')
  assert.equal(internals.approvalIntentController.riskExplainPending, false)
})

test('请求在途时重复按键不重复发起', async () => {
  const { app, stdin, internals } = makeApp()
  let calls = 0
  app.setRiskExplainer(async () => {
    calls++
    await new Promise(r => setTimeout(r, 40))
    return LOW
  })

  void internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()
  stdin.dataHandler!('\x05')
  stdin.dataHandler!('\x05')
  stdin.dataHandler!('\x05')
  await tick(80)

  assert.equal(calls, 1, '在途去重，别让用户连按就连发')
})

test('迟到的解释不得落到下一条待批项上', async () => {
  const { app, stdin, internals } = makeApp()
  let release: (v: RiskExplanation) => void = () => {}
  app.setRiskExplainer(() => new Promise<RiskExplanation>(r => { release = r }))

  void internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()
  stdin.dataHandler!('\x05')
  await tick()

  // 用户不等解释就批了，紧接着来了第二条待批项。
  stdin.dataHandler!('y')
  await tick()
  void internals.handleApprovalRequired('a2', 'bash', { command: 'rm -rf /' })
  await tick()

  // 第一条的解释此刻才回来。
  release(LOW)
  await tick(30)

  assert.equal(
    internals.approvalIntentController.riskExplanation,
    null,
    '把上一条命令的「低风险」挂到 rm -rf / 上是最危险的误导',
  )
})

test('切换待批项时清空上一条的解释', async () => {
  const { app, stdin, internals } = makeApp()
  app.setRiskExplainer(async () => LOW)

  void internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()
  stdin.dataHandler!('\x05')
  await tick(30)
  assert.ok(internals.approvalIntentController.riskExplanation, '前置条件：第一条已有解释')

  stdin.dataHandler!('y')
  await tick()
  void internals.handleApprovalRequired('a2', 'bash', { command: 'rm -rf /' })
  await tick()

  assert.equal(internals.approvalIntentController.riskExplanation, null, '新待批项必须从空白开始')
})

test('未注入解释器时 Ctrl+E 静默无效，不影响审批', async () => {
  const { stdin, internals } = makeApp()

  const pending = internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()
  stdin.dataHandler!('\x05')
  await tick()

  assert.equal(internals.approvalIntentController.riskExplainPending, false)
  stdin.dataHandler!('y')
  assert.ok(await pending, '审批本身照常可用')
})

test('解释器抛错 → 记错误但审批仍可完成', async () => {
  const { app, stdin, internals } = makeApp()
  app.setRiskExplainer(async () => { throw new Error('network down') })

  const pending = internals.handleApprovalRequired('a1', 'bash', { command: 'ls' })
  await tick()
  stdin.dataHandler!('\x05')
  await tick(30)

  assert.match(internals.approvalIntentController.riskExplainError, /network down/)
  assert.equal(internals.approvalIntentController.riskExplainPending, false)
  stdin.dataHandler!('y')
  assert.ok(await pending)
})
