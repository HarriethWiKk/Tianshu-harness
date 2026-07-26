import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../engine/input-line.js'

/** 构造 vim 模式输入框并进入 normal 模式。 */
function vim(value: string, cursor?: number): InputLine {
  const input = new InputLine({ value, vimEnabled: true })
  input.handleKey('escape', '', false, false)
  if (cursor !== undefined) input.setValue(value, cursor)
  return input
}

describe('InputLine · vim visual mode（收束轮）', () => {
  it('v 进入 visual（charwise），motion 扩展选区，Esc 回 normal 折叠', () => {
    const input = vim('hello world', 0)
    input.handleKey('v', 'v', false, false)
    assert.equal(input.vimMode, 'visual')
    input.handleKey('l', 'l', false, false)
    input.handleKey('l', 'l', false, false)
    assert.deepEqual(input.selectionRange, { start: 0, end: 2 })
    input.handleKey('escape', '', false, false)
    assert.equal(input.vimMode, 'normal')
    assert.equal(input.selectionRange, null)
  })

  it('w/b/0/$/^/h/l 扩展选区', () => {
    const input = vim('foo bar baz', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('w', 'w', false, false) // → 'bar' 起点
    assert.deepEqual(input.selectionRange, { start: 0, end: 4 })
    input.handleKey('$', '$', false, false)
    assert.deepEqual(input.selectionRange, { start: 0, end: 11 })
  })

  it('d 剪切选区：值/剪贴板/OSC52 drain/回 normal/undo 恢复', () => {
    const input = vim('hello world', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('w', 'w', false, false) // 光标 → 'world' 起点（6），选区 'hello '
    input.handleKey('d', 'd', false, false)
    assert.equal(input.value, 'world')
    assert.equal(input.vimMode, 'normal')
    assert.equal(input.takeClipboardOut(), 'hello ')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, 'hello world')
  })

  it('c 剪切后进 insert', () => {
    const input = vim('hello', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('c', 'c', false, false)
    assert.equal(input.vimMode, 'insert')
    assert.equal(input.value, 'ello', '剪切单字符选区 h 后进 insert')
  })

  it('y 复制不删除，回 normal；o 交换锚点/光标', () => {
    const input = vim('hello', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('o', 'o', false, false)
    assert.equal(input.cursor, 0, 'o 后光标在锚点端')
    input.handleKey('y', 'y', false, false)
    assert.equal(input.value, 'hello')
    assert.equal(input.vimMode, 'normal')
    assert.equal(input.takeClipboardOut(), 'he')
  })

  it('p/P 在光标后/前插入内部剪贴板（normal 模式，不走粘贴折叠）', () => {
    const input = vim('ab', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('y', 'y', false, false) // 复制 'ab'
    input.handleKey('0', '0', false, false)
    input.handleKey('p', 'p', false, false)
    assert.equal(input.value, 'aabb')
    input.handleKey('0', '0', false, false)
    input.handleKey('P', 'P', false, false)
    assert.equal(input.value, 'abaabb')
  })

  it('V linewise：跨行选择对齐整行（含行尾换行，删除不留空行）', () => {
    const input = vim('a\nbb\nccc', 0)
    input.handleKey('V', 'V', false, false)
    assert.equal(input.visualLineWise, true)
    input.handleKey('j', 'j', false, false) // 扩到第二行
    assert.deepEqual(input.selectionRange, { start: 0, end: 5 }, 'a\\nbb\\n 前两行整行（含第二个换行）')
    input.handleKey('d', 'd', false, false)
    assert.equal(input.value, 'ccc', '行删除后剩余行上提')
  })

  it('visual 中 return 直接 submit', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'abc', vimEnabled: true, onSubmit: (v) => { submitted = v } })
    input.handleKey('escape', '', false, false)
    input.handleKey('v', 'v', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('return', '', false, false)
    assert.equal(submitted, 'abc')
  })

  it('x 与 Backspace 同 d（剪切回 normal）', () => {
    const input = vim('hello', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'ello', 'backspace 同 d 剪切单字符选区')
    assert.equal(input.vimMode, 'normal')
  })

  it('j/k 多行扩展（charwise 不按行对齐）', () => {
    const input = vim('ab\ncd\nef', 1)
    input.handleKey('v', 'v', false, false)
    input.handleKey('j', 'j', false, false)
    assert.deepEqual(input.selectionRange, { start: 1, end: 4 })
  })

  it('visual 内 undo/redo 可用', () => {
    const input = vim('hello', 0)
    input.handleKey('v', 'v', false, false)
    input.handleKey('l', 'l', false, false)
    input.handleKey('d', 'd', false, false) // 回 normal，值 'ello'
    assert.equal(input.value, 'ello')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, 'hello')
    input.handleKey('ctrl_y', '', true, false)
    assert.equal(input.value, 'ello')
  })
})
