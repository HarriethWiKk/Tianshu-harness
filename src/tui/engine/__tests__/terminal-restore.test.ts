/**
 * 崩溃路径的终端状态还原。
 *
 * 契约：
 * - 未捕获同步异常会跳过 shutdown()/dispose()，此时 process.on('exit') 兜底钩子
 *   调 restoreTerminalSync() 仍必须关掉 bracketed paste 并恢复光标——否则用户被
 *   留在需要 `tput reset` 的终端里（症状：粘贴时出现字面 ^[[200~）。
 * - 幂等：dispose() 已还原过就不再重发。
 * - 备用屏只在 overlay 确实激活时才退出：无条件发 ?1049l 会让部分终端跳到陈旧的
 *   保存光标位置。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out }
}

const countOf = (out: MockOut, seq: string) =>
  out.chunks.filter(c => c.includes(seq)).length

test('崩溃路径：未走 dispose 时 restoreTerminalSync 仍关闭 paste 并恢复光标', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0

  // 模拟 uncaughtException 之后的 process.on('exit')：dispose 从未被调用。
  app.restoreTerminalSync()

  assert.ok(out.chunks.some(c => c.includes('\x1B[?2004l')), '必须关闭 bracketed paste')
  assert.ok(out.chunks.some(c => c.includes('\x1B[?25h')), '必须恢复硬件光标')
})

test('幂等：dispose 已还原后，兜底钩子再调不重发', () => {
  const { app, out } = makeApp()
  app.start()
  app.dispose()
  const afterDispose = countOf(out, '\x1B[?2004l')
  assert.equal(afterDispose, 1, 'dispose 还原一次')

  app.restoreTerminalSync()
  assert.equal(countOf(out, '\x1B[?2004l'), afterDispose, '兜底钩子不得重发')
})

test('多次调用只还原一次', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0

  app.restoreTerminalSync()
  app.restoreTerminalSync()
  app.restoreTerminalSync()

  assert.equal(countOf(out, '\x1B[?2004l'), 1)
  assert.equal(countOf(out, '\x1B[?25h'), 1)
})

test('overlay 未激活时不发 ?1049l（避免跳到陈旧的保存光标位）', () => {
  const { app, out } = makeApp()
  app.start()
  out.chunks.length = 0

  app.restoreTerminalSync()

  assert.equal(countOf(out, '\x1B[?1049l'), 0, '没有备用屏就不该退出备用屏')
})
