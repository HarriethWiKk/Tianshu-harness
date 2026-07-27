/**
 * ask-question-panel 渲染测试：Tab 条 / 题页 / 提交页（Review）三支。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderAskQuestionPanel,
  ASK_OTHER_ROW_LABEL,
  ASK_CHAT_ROW_LABEL,
  ASK_SUBMIT_ROW_LABEL,
  ASK_CANCEL_ROW_LABEL,
  type AskQuestionPanelData,
} from '../ask-question-panel.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function baseData(over: Partial<AskQuestionPanelData> = {}): AskQuestionPanelData {
  return {
    tabs: [
      { label: '先出哪个设计', answered: true },
      { label: '第二题', answered: false },
    ],
    activeTab: 0,
    prompt: '我标了两个独立项，先给你出哪个的设计+实施文档？',
    allowMultiple: false,
    options: ['CC 对标 hook 接线', 'headless stream-json 增强'],
    selected: [],
    cursor: 1,
    review: [
      { prompt: '先给你出哪个的设计+实施文档？', answer: 'headless stream-json 增强' },
      { prompt: '第二题', answer: null },
    ],
    ...over,
  }
}

describe('ask-question-panel — Tab 条', () => {
  it('渲染每题 Tab + 提交 Tab，已答题带 ✓', () => {
    const lines = renderAskQuestionPanel(baseData(), 80, 24, theme).map(stripAnsi)
    const bar = lines[1] ?? ''
    assert.ok(bar.includes('先出哪个设计'), 'Tab 含第 1 题标签')
    assert.ok(bar.includes('第二题'), 'Tab 含第 2 题标签')
    assert.ok(bar.includes('提交'), '含提交 Tab')
    assert.ok(bar.includes('✓ 先出哪个设计') || bar.includes('✓先出哪个设计'), '已答题带 ✓')
    assert.ok(bar.includes('←') && bar.includes('→'), 'Tab 条带切换箭头')
  })
})

describe('ask-question-panel — 题页', () => {
  it('编号选项行 + 光标行 + 固定功能行', () => {
    const lines = renderAskQuestionPanel(baseData(), 80, 24, theme).map(stripAnsi)
    const joined = lines.join('\n')
    assert.ok(joined.includes('1. CC 对标 hook 接线'), '选项 1 带编号')
    assert.ok(joined.includes('2. headless stream-json 增强'), '选项 2 带编号')
    assert.ok(joined.includes(`> 2.`), '光标在第 2 行')
    assert.ok(joined.includes(`3. ${ASK_OTHER_ROW_LABEL}`), 'Other 行')
    assert.ok(joined.includes(`4. ${ASK_CHAT_ROW_LABEL}`), '讨论行')
    assert.ok(joined.includes('先给你出哪个的设计+实施文档？'), '题面完整渲染')
  })

  it('多选题渲染 checkbox 勾选态', () => {
    const lines = renderAskQuestionPanel(baseData({
      allowMultiple: true,
      selected: [0],
      cursor: 0,
    }), 80, 24, theme).map(stripAnsi)
    const joined = lines.join('\n')
    assert.ok(joined.includes('[x] CC 对标 hook 接线'), '已选项 [x]')
    assert.ok(joined.includes('[ ] headless stream-json 增强'), '未选项 [ ]')
    assert.ok(joined.includes('空格:多选'), 'footer 提示多选键')
  })

  it('单选题不渲染 checkbox', () => {
    const lines = renderAskQuestionPanel(baseData(), 80, 24, theme).map(stripAnsi)
    const joined = lines.join('\n')
    assert.ok(!joined.includes('[ ]') && !joined.includes('[x]'), '单选无 checkbox')
  })

  it('输入子模式渲染输入区与返回提示', () => {
    const lines = renderAskQuestionPanel(baseData({
      inputSubMode: { active: true, label: '自定义回答', placeholder: '输入你的回答后回车', value: 'abc' },
    }), 80, 24, theme).map(stripAnsi)
    const joined = lines.join('\n')
    assert.ok(joined.includes('自定义回答'), '输入区标签')
    assert.ok(joined.includes('abc'), '输入缓冲回显')
    assert.ok(joined.includes('Esc:返回选项'), '返回提示')
  })

  it('窄宽度下行不溢出（按显示宽度计）', () => {
    for (const width of [60, 40, 30]) {
      const lines = renderAskQuestionPanel(baseData(), width, 24, theme).map(stripAnsi)
      const over = lines.filter(l => displayWidth(l) > width)
      assert.deepEqual(over, [], `width=${width} 有行溢出`)
    }
  })
})

describe('ask-question-panel — 提交页（Review）', () => {
  it('逐题列出答案，未答标「将跳过」，含提交/取消行', () => {
    const lines = renderAskQuestionPanel(baseData({ activeTab: 2, cursor: 0 }), 80, 24, theme).map(stripAnsi)
    const joined = lines.join('\n')
    assert.ok(joined.includes('确认你的回答'), 'Review 标题')
    assert.ok(joined.includes('→ headless stream-json 增强'), '已答答案')
    assert.ok(joined.includes('→ （未答，将跳过）'), '未答标记')
    assert.ok(joined.includes(`> 1. ${ASK_SUBMIT_ROW_LABEL}`), '提交行带光标')
    assert.ok(joined.includes(`2. ${ASK_CANCEL_ROW_LABEL}`), '取消行')
  })

  it('提交 Tab 在 Tab 条上为活动态', () => {
    const lines = renderAskQuestionPanel(baseData({ activeTab: 2, cursor: 0 }), 80, 24, theme)
    // 活动 Tab 用 primary bold 着色——strip 前的第 2 行应含 ANSI 粗体码
    assert.ok(lines[1]!.includes('\x1B['), 'Tab 条有着色')
  })
})
