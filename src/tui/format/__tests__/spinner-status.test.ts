/**
 * Spinner 状态行测试 — 审批等待可观测化。
 *
 * 背景（2d8b67ca 事故观感）：onApprovalRequired 挂起期间 spinner 轮换
 * 「思索中…」动词冒充模型活动，用户以为模型卡死。契约：审批挂起时
 * spinner 如实显示「等待审批 <tool> · Ns」，用审批等待时长而非 turn 时长。
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { formatSpinnerStatus, resetSpinnerConfig } from '../spinner-status.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatSpinnerStatus approvalWait', () => {
  afterEach(() => resetSpinnerConfig())

  it('审批挂起时显示「等待审批 <tool> · Ns」，用审批等待时长', () => {
    const line = formatSpinnerStatus({
      tick: 0,
      phase: 'waiting',
      elapsedMs: 300_000, // turn 已 5 分钟——不得混入显示
      approvalWait: { toolName: 'read_file', waitMs: 12_000 },
    }, theme)
    assert.ok(line, '审批挂起时应有状态行')
    const text = stripAnsi(line!)
    assert.ok(text.includes('等待审批 read_file'), `应含工具名: ${text}`)
    assert.ok(text.includes('12s'), `应显示审批等待时长 12s 而非 turn 时长: ${text}`)
    assert.ok(!text.includes('5m'), `不得显示 turn 时长: ${text}`)
  })

  it('审批挂起时不轮换思考动词', () => {
    const line = formatSpinnerStatus({
      tick: 42,
      phase: 'waiting',
      elapsedMs: 60_000,
      approvalWait: { toolName: 'bash', waitMs: 90_000 },
    }, theme)
    const text = stripAnsi(line!)
    for (const verb of ['thinking', '思索中', '推演中', '梳理中', '构筑中', '琢磨中', '沉淀中']) {
      assert.ok(!text.includes(verb), `不得冒充思考动词「${verb}」: ${text}`)
    }
    assert.ok(text.includes('1m 30s'), `等待超过 1 分钟应显示分钟粒度: ${text}`)
  })

  it('无 approvalWait 时保持原动词池行为', () => {
    const line = formatSpinnerStatus({
      tick: 0,
      phase: 'waiting',
      elapsedMs: 5_000,
    }, theme)
    const text = stripAnsi(line!)
    assert.ok(!text.includes('等待审批'), `无审批时不得出现审批文案: ${text}`)
    assert.ok(text.includes('5s'), `应显示 turn 时长: ${text}`)
  })
})
