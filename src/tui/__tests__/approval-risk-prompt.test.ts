/**
 * 审批提示的风险解释渲染（Wave 1-2）。
 *
 * 关键行为：解释是**按需**的——没请求过时选项列表里有「解释风险 (^E)」行，
 * 请求过之后该行撤下换成结论。这样默认状态不多占屏，也不会重复给一个已经用过的入口。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatApprovalPrompt } from '../format/approval-renderers.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function render(over: Partial<Parameters<typeof formatApprovalPrompt>[0]> = {}): string {
  return formatApprovalPrompt(
    { toolName: 'bash', input: { command: 'rm -rf dist' }, columns: 100, selectedIndex: 0, ...over },
    theme,
  ).map(stripAnsi).join('\n')
}

describe('审批提示 — 默认态', () => {
  it('选项列表含「解释风险 (^E)」行', () => {
    const text = render()
    assert.match(text, /解释风险/)
    assert.match(text, /\^E/)
  })

  it('未请求前不占用任何解释行', () => {
    const text = render()
    assert.doesNotMatch(text, /正在分析/)
    assert.doesNotMatch(text, /\[高风险\]|\[中风险\]|\[低风险\]/)
  })

  it('既有的批准/拒绝/编辑选项不受影响', () => {
    const text = render()
    assert.match(text, /批准/)
    assert.match(text, /拒绝/)
    assert.match(text, /编辑 JSON/)
  })
})

describe('审批提示 — 解释在途', () => {
  it('显示进行中，且撤下「解释风险」行避免重复触发', () => {
    const text = render({ riskPending: true })
    assert.match(text, /正在分析/)
    assert.doesNotMatch(text, /解释风险/)
  })
})

describe('审批提示 — 解释已就绪', () => {
  it('高风险用醒目标签并列出正文', () => {
    const text = render({
      risk: { level: 'high', lines: ['删除整个 dist 目录，不可逆。', '影响范围：构建产物。'] },
    })
    assert.match(text, /\[高风险\]/)
    assert.match(text, /删除整个 dist 目录，不可逆。/)
    assert.match(text, /影响范围：构建产物。/)
  })

  it('低风险与中风险各有标签', () => {
    assert.match(render({ risk: { level: 'low', lines: ['只读。'] } }), /\[低风险\]/)
    assert.match(render({ risk: { level: 'medium', lines: ['可回滚。'] } }), /\[中风险\]/)
  })

  it('已有结论后撤下「解释风险」行', () => {
    const text = render({ risk: { level: 'low', lines: ['只读。'] } })
    assert.doesNotMatch(text, /解释风险/)
  })
})

describe('审批提示 — 解释失败', () => {
  it('降级为一行说明，审批选项列表照常在位', () => {
    const text = render({ riskError: '模型未返回可用结果' })
    assert.match(text, /风险分析不可用：模型未返回可用结果/)
    assert.match(text, /批准/, '解释失败不得影响审批本身')
  })
})
