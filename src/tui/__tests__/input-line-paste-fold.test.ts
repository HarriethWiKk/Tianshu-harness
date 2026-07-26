import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../engine/input-line.js'

/** 逐键输入可打印字符（走 handleKey 真实路径）。 */
function type(input: InputLine, text: string): void {
  for (const ch of text) input.handleKey(ch, ch, false, false)
}

describe('InputLine · 长粘贴自动收纳 [paste #N]（P3-B）', () => {
  it('>10 行的粘贴折叠为原子标记，原文旁路存储', () => {
    const input = new InputLine()
    const payload = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    input.insertText(payload)
    assert.equal(input.value, '[paste #1 +12 lines]', 'buffer 只含标记')
    assert.equal(input.expandPastes(input.value), payload, '展开可还原原文')
  })

  it('>1000 字符的单行粘贴同样折叠', () => {
    const input = new InputLine()
    input.insertText('x'.repeat(1200))
    assert.equal(input.value, '[paste #1 +1 lines]')
    assert.equal(input.expandPastes(input.value).length, 1200)
  })

  it('短粘贴不受影响（原文进 buffer）', () => {
    const input = new InputLine()
    input.insertText('short paste')
    assert.equal(input.value, 'short paste')
  })

  it('标记是原子单位：左右移动一步整体越过', () => {
    const input = new InputLine()
    input.insertText(Array.from({ length: 11 }, () => 'l').join('\n'))
    type(input, 'z') // 标记后追加一个字符
    input.handleKey('left', '', false, false) // 越过 z
    input.handleKey('left', '', false, false) // 应整体越过标记
    assert.equal(input.cursor, 0, '标记内部不可停留——一步回到行首')
  })

  it('backspace 在标记末尾整删标记', () => {
    const input = new InputLine()
    input.insertText(Array.from({ length: 11 }, () => 'l').join('\n'))
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, '', '标记整体删除')
    assert.equal(input.expandPastes(input.value), '')
  })

  it('提交时展开为原文（onSubmit 拿到 payload 而非标记）', () => {
    let submitted: string | null = null
    const payload = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    const input = new InputLine({ onSubmit: (v) => { submitted = v } })
    input.insertText(payload)
    input.handleKey('return', '', false, false)
    assert.equal(submitted, payload)
    assert.equal(input.value, '', '提交后 buffer 清空')
  })

  it('undo 恢复标记（旁路原文按 id 存活）', () => {
    const input = new InputLine()
    const payload = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    input.insertText(payload)
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, '')
    input.handleKey('ctrl_y', '', true, false)
    assert.equal(input.value, '[paste #1 +12 lines]')
    assert.equal(input.expandPastes(input.value), payload)
  })

  it('多次折叠编号递增', () => {
    const input = new InputLine()
    input.insertText(Array.from({ length: 11 }, () => 'a').join('\n'))
    input.insertText(Array.from({ length: 12 }, () => 'b').join('\n'))
    assert.equal(input.value, '[paste #1 +11 lines][paste #2 +12 lines]')
  })

  it('用户手输的同名标记无原文不误展开（按普通文本处理）', () => {
    const input = new InputLine({ value: '[paste #99 +5 lines]' })
    assert.equal(input.expandPastes(input.value), '[paste #99 +5 lines]')
    // 旁路无原文的标记不原子化——就是普通文本，光标按字移动
    input.handleKey('left', '', false, false)
    assert.equal(input.cursor, input.value.length - 1)
  })
})
