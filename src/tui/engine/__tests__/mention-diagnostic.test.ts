/**
 * @file 节点 exists 诊断（P3-C3）集成测试。
 *
 * 契约：输入含不存在的 @file:/@folder: 引用 → 输入框下方出现一行提示；
 * 引用存在 → 无提示；编辑改变引用 → 提示按新值重算（缓存同值不重复 stat）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

const tick = (ms = 30) => delay(ms)

function makeApp(): { app: TuiApp; out: MockOut; stdin: MockIn } {
  const out = new MockOut(100, 24)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

test('@file 诊断：不存在的引用提示，清空后消失，存在的引用不提示', async () => {
  const { app, out, stdin } = makeApp()
  app.start()
  out.clear()

  for (const ch of 'check @file:no/such/file.ts ') stdin.dataHandler!(ch)
  await tick()
  assert.ok(out.chunks.join('').includes('不存在'), '不存在的引用应提示')

  // Ctrl+U 清空后输入存在的引用（package.json 在仓库 cwd 下存在）
  stdin.dataHandler!('\x15')
  for (const ch of 'check @file:package.json ') stdin.dataHandler!(ch)
  await tick()
  out.clear()
  stdin.dataHandler!('x') // 触发一次重绘验证当前帧无提示
  await tick()
  assert.ok(!out.chunks.join('').includes('不存在'), '存在的引用不得提示')
  app.dispose()
})
