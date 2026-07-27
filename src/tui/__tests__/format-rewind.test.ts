/**
 * Rewind 面板渲染 —— 重点是两个摘要动作的**缓存代价标注**。
 *
 * 设计意图：代价标注按当前 provider 是否吃精确前缀缓存**动态显示**。
 * 在 Anthropic / Codex 这类不按精确前缀计费的模型上，「摘要到此处」并不贵，
 * 此时还挂一条缓存警告就是在用 DeepSeek 的约束去劝退别的模型的用户。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderRewind, ACTIONS, type RewindData } from '../format/rewind.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function actionIndexOf(mode: string): number {
  const i = ACTIONS.findIndex(a => a.mode === mode)
  assert.notEqual(i, -1, `动作表里必须有 ${mode}`)
  return i
}

function render(over: Partial<RewindData> = {}): string {
  const data: RewindData = {
    entries: [
      { index: 1, messageIndex: 0, content: '第一条用户消息' },
      { index: 2, messageIndex: 4, content: '第二条用户消息' },
    ],
    selectedIndex: 1,
    phase: 'action',
    actionIndex: 0,
    ...over,
  }
  return renderRewind(data, 100, 30, theme).map(stripAnsi).join('\n')
}

describe('renderRewind — 摘要动作入场', () => {
  it('动作列表含两个摘要动作', () => {
    const text = render()
    assert.match(text, /从此处摘要/)
    assert.match(text, /摘要到此处/)
  })

  it('两个摘要动作的描述说清各自保留哪一侧', () => {
    const text = render()
    assert.match(text, /把此消息之后的内容压成摘要，之前的对话原样保留/)
    assert.match(text, /把此消息之前的内容压成摘要，之后的对话原样保留/)
  })
})

describe('renderRewind — 缓存代价标注按 provider 动态显示', () => {
  it('前缀缓存 provider + 摘要到此处 → 标出重建风险', () => {
    const text = render({ actionIndex: actionIndexOf('summarize-to'), cachePreserving: true })
    assert.match(text, /⚠ 缓存/, '必须标出风险')
    assert.match(text, /前缀需重建/)
  })

  it('前缀缓存 provider + 从此处摘要 → 说明前缀不受影响，不误报风险', () => {
    const text = render({ actionIndex: actionIndexOf('summarize-from'), cachePreserving: true })
    assert.match(text, /前缀原样保留/)
    assert.doesNotMatch(text, /⚠ 缓存/, '压尾部几乎免费，不该挂警告')
  })

  it('非前缀缓存 provider → 两个摘要动作都不显示缓存标注', () => {
    const to = render({ actionIndex: actionIndexOf('summarize-to'), cachePreserving: false })
    const from = render({ actionIndex: actionIndexOf('summarize-from'), cachePreserving: false })
    assert.doesNotMatch(to, /缓存/, '不吃前缀缓存的模型不该被这条警告劝退')
    assert.doesNotMatch(from, /缓存/)
  })

  it('cachePreserving 未提供时按不标处理（fail-quiet，不吓唬用户）', () => {
    const text = render({ actionIndex: actionIndexOf('summarize-to') })
    assert.doesNotMatch(text, /⚠ 缓存/)
  })

  it('非摘要动作不显示缓存标注', () => {
    const text = render({ actionIndex: actionIndexOf('convo'), cachePreserving: true })
    assert.doesNotMatch(text, /⚠ 缓存/)
  })
})

describe('renderRewind — 既有动作未被破坏', () => {
  it('文件预览仍只在代码类动作下出现', () => {
    const withPreview = render({
      actionIndex: actionIndexOf('code'),
      cachePreserving: true,
      previewFiles: [{ path: 'src/a.ts', action: 'restore' }],
    })
    assert.match(withPreview, /将影响 1 个文件/)

    const summarize = render({
      actionIndex: actionIndexOf('summarize-to'),
      cachePreserving: true,
      previewFiles: [{ path: 'src/a.ts', action: 'restore' }],
    })
    assert.doesNotMatch(summarize, /将影响 1 个文件/, '摘要不动文件，不该显示文件预览')
  })

  it('list 阶段照常渲染消息列表', () => {
    const text = render({ phase: 'list' })
    assert.match(text, /第二条用户消息/)
    assert.doesNotMatch(text, /从此处摘要/, 'list 阶段不显示动作')
  })
})
