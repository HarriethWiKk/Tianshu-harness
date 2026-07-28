/**
 * renderChoicePanel 测试：多行 title（计划审批 excerpt / 倒计时行）在矮终端下
 * 钳制——不钳制时 titleExtra 过大，contentRows 被压到 1，总行数超 height 被
 * OverlayEngine 定长网格静默截掉选项与 footer。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderChoicePanel } from '../overlay.js'
import type { ChoicePanelData } from '../overlay.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function planApprovalData(): ChoicePanelData {
  return {
    title: [
      '计划审批 / Plan Approval',
      '「修 TUI 审批卡片」',
      '⏳ Goal 模式：25s 后自动批准（批准/驳回即取消；Esc 收起不取消）',
      '──',
      '需求提炼：一行',
      '两行',
      '三行',
      '四行',
      '五行',
      '六行',
    ].join('\n'),
    choices: [
      { id: 'approve', label: '批准并执行', description: '执行计划「修 TUI 审批卡片」', recommended: true },
      { id: 'reject', label: '驳回修订', description: '标记为 REJECTED，agent 可继续修改' },
      { id: 'reject-exit', label: '驳回并退出计划模式', description: '驳回计划并退出 plan mode' },
      { id: '__reject_comment__', label: '驳回并填写反馈…', description: '输入反馈后驳回，agent 可继续修订' },
    ],
    selectedIndex: 0,
  }
}

describe('renderChoicePanel — 多行 title 钳制', () => {
  it('常规高度：title 全部附加行照常展示，不截断', () => {
    const lines = renderChoicePanel(planApprovalData(), 80, 30, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('六行')), '30 行高度下 excerpt 全展示')
    assert.ok(lines.some(l => l.includes('驳回并填写反馈')), '全部选项在')
    assert.ok(lines.some(l => l.includes('Enter')), 'footer 在')
  })

  it('矮终端：excerpt 钳制，选项与 footer 不被挤出网格，总行数 ≤ height', () => {
    const height = 14
    const lines = renderChoicePanel(planApprovalData(), 80, height, theme).map(stripAnsi)
    assert.ok(lines.length <= height, `总行数 ${lines.length} 应 ≤ ${height}`)
    assert.ok(lines.some(l => l.includes('批准并执行')), '选项 1 在')
    assert.ok(lines.some(l => l.includes('驳回修订')), '选项 2 在')
    assert.ok(lines.some(l => l.includes('Enter')), 'footer 在')
    assert.ok(lines.some(l => l.includes('…')), '钳制处有省略标记')
    assert.ok(!lines.some(l => l.includes('六行')), '超出钳制量的 excerpt 行被截掉')
  })

  it('极矮终端：附加行归零也不崩，仍有选项行', () => {
    const lines = renderChoicePanel(planApprovalData(), 80, 9, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('批准并执行')), '极矮终端至少能看到首个选项')
    assert.ok(lines.some(l => l.includes('…')), '附加行归零时给省略占位')
  })
})
