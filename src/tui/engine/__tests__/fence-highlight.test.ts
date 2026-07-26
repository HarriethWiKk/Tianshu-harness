/**
 * 代码块 fence 高亮（S2）集成测试。
 *
 * 契约：``` 开合之间（含 fence 行）的输入行着 dim 色；未闭合 fence 一直
 * 着色到末尾；纯渲染层拼接，不进 buffer。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

const tick = (ms = 30) => delay(ms)

test('fence 高亮：``` 内代码行着色，未闭合到末尾', async () => {
  const out = new MockOut(80, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  app.start()
  out.clear()
  // 输入：```js <ctrl+j> const a=1（未闭合 fence）
  for (const ch of '```js') stdin.dataHandler!(ch)
  stdin.dataHandler!('\x0a') // Ctrl+J 换行
  for (const ch of 'const a=1') stdin.dataHandler!(ch)
  await tick()

  const frame = out.chunks.join('')
  const codeLine = frame.split('\n').find(l => l.includes('const a=1'))
  assert.ok(codeLine, '代码行应在输入区')
  // 该行应被 dim 着色（fence 内）——行内含 SGR 颜色序列包裹（非纯文本裸行）
  assert.ok(/\x1B\[[0-9;]*m.*const a=1/.test(codeLine!), 'fence 内代码行应着色')
  app.dispose()
})
