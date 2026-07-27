import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { formatEventForScreenReader } from '../screen-reader.js'
import type { SessionEvent, SessionEventType } from '../../server/protocol.js'

const ev = (type: SessionEventType, data: Record<string, unknown> = {}): SessionEvent =>
  ({ seq: 1, ts: 0, type, data })

describe('screen-reader — 播报活动的「开始」', () => {
  test('工具开始带上主要参数', () => {
    assert.equal(
      formatEventForScreenReader(ev('tool_use', { name: 'read', input: { path: 'src/a.ts' } })),
      '开始 read：src/a.ts',
    )
  })

  test('无可播报参数时只报工具名', () => {
    assert.equal(
      formatEventForScreenReader(ev('tool_use', { name: 'todo', input: {} })),
      '开始 todo',
    )
  })

  test('参数按优先级取，command 优先于无关键', () => {
    assert.equal(
      formatEventForScreenReader(ev('tool_use', { name: 'bash', input: { cwd: '/x', command: 'npm test' } })),
      '开始 bash：npm test',
    )
  })

  test('超长参数截断，不让读屏软件念一屏', () => {
    const line = formatEventForScreenReader(ev('tool_use', { name: 'bash', input: { command: 'x'.repeat(300) } }))
    assert.ok(line!.length < 120, `播报行过长：${line!.length}`)
    assert.ok(line!.endsWith('…'))
  })

  test('多行参数压成一行 —— 换行会打断朗读', () => {
    assert.equal(
      formatEventForScreenReader(ev('tool_use', { name: 'bash', input: { command: 'a\n  b\n c' } })),
      '开始 bash：a b c',
    )
  })

  test('等待批准要播报，且按键必须念出来（提示行在读屏档不可见）', () => {
    assert.equal(
      formatEventForScreenReader(ev('approval_required', { toolName: 'bash', input: { command: 'rm -rf build' } })),
      '等待批准 bash：rm -rf build。按 y 批准，n 拒绝，e 编辑，Ctrl+E 解释风险',
    )
  })
})

describe('screen-reader — 已在静态区的内容必须静默', () => {
  test('文本与思考 delta 不播报（blockWriter 已提交静态区）', () => {
    assert.equal(formatEventForScreenReader(ev('text_delta', { text: 'hello' })), null)
    assert.equal(formatEventForScreenReader(ev('thinking_delta', { text: 'hmm' })), null)
  })

  test('工具结果不播报（工具卡已提交静态区，播了就是念两遍）', () => {
    assert.equal(
      formatEventForScreenReader(ev('tool_result', { id: 't1', name: 'read', isError: false, result: 'body' })),
      null,
    )
  })

  test('中间轮完成不播报，只有最终轮播', () => {
    assert.equal(formatEventForScreenReader(ev('turn_complete', { isFinal: false })), null)
    assert.equal(formatEventForScreenReader(ev('turn_complete', { isFinal: true })), '回合完成')
  })

  test('纯视觉面板类事件一律静默', () => {
    for (const type of ['phase', 'checkpoint', 'delegation', 'intent_note', 'decision_shift'] as const) {
      assert.equal(formatEventForScreenReader(ev(type, {})), null, `${type} 不该被播报`)
    }
  })
})

describe('screen-reader — 异常路径', () => {
  test('出错与中断都要播报', () => {
    assert.equal(formatEventForScreenReader(ev('error', { error: 'boom' })), '出错：boom')
    assert.equal(formatEventForScreenReader(ev('status', { status: 'aborted' })), '已中断')
  })

  test('非 aborted 的 status 不播报', () => {
    assert.equal(formatEventForScreenReader(ev('status', { status: 'running' })), null)
  })

  test('字段缺失或类型不对时不崩，给出兜底措辞', () => {
    assert.equal(formatEventForScreenReader(ev('tool_use', {})), '开始 未知工具')
    assert.equal(formatEventForScreenReader(ev('error', {})), '出错：未知错误')
    assert.equal(formatEventForScreenReader(ev('tool_use', { name: 'x', input: null })), '开始 x')
    assert.equal(formatEventForScreenReader(ev('tool_use', { name: 'x', input: 'not-an-object' })), '开始 x')
  })

  test('播报文本不含装饰字形 —— 读屏软件会把它们念出来', () => {
    const lines = [
      formatEventForScreenReader(ev('tool_use', { name: 'read', input: { path: 'a.ts' } })),
      formatEventForScreenReader(ev('error', { error: 'boom' })),
      formatEventForScreenReader(ev('turn_complete', { isFinal: true })),
    ]
    for (const line of lines) {
      assert.ok(line)
      assert.doesNotMatch(line, /[✓✗⚠●◐❯│╭╰─🔧⏳]/, `播报含装饰字形：${line}`)
      assert.doesNotMatch(line, /\x1B\[/, `播报含 ANSI 转义：${line}`)
    }
  })
})
