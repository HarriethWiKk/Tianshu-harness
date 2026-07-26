/**
 * Mission Contract 预览（§13）集成测试。
 *
 * 契约：
 * - 结构化输入（@引用/#标签/长任务）→ inline 预览卡，agent 不收提交；
 * - Enter 确认 → 原文走完整提交流；e 返回编辑回填草稿；Esc 取消丢弃；
 * - 短自然语言直通；busy 中（steer 归并路径）不弹卡。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

const tick = (ms = 30) => delay(ms)

function makeApp(): { app: TuiApp; out: MockOut; stdin: MockIn; submitted: string[] } {
  const out = new MockOut(100, 24)
  const stdin = new MockIn()
  const submitted: string[] = []
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 24, modelName: 'test',
  })
  app.onSubmit((text) => { submitted.push(text) })
  return { app, out, stdin, submitted }
}

test('结构化输入触发预览卡（agent 未收提交），Enter 确认后原文提交', async () => {
  const { app, out, stdin, submitted } = makeApp()
  app.start()
  out.clear()

  for (const ch of '修复 @file:package.json 的状态') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(out.chunks.join('').includes('Mission Contract 预览'), '应出现预览卡')
  assert.equal(submitted.length, 0, '预览期 agent 不得收提交')

  out.clear()
  stdin.dataHandler!('\r') // Enter 确认
  await tick()
  assert.equal(submitted.length, 1, '确认后提交一次')
  assert.equal(submitted[0], '修复 @file:package.json 的状态', '原文提交（展开/语义不丢）')
  app.dispose()
})

test('e 返回编辑：草稿回填输入框，可修改后再次预览/提交', async () => {
  const { app, out, stdin, submitted } = makeApp()
  app.start()
  for (const ch of '修复 @file:package.json 的状态') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick()

  stdin.dataHandler!('e')
  await tick()
  assert.equal(app.getInputValue(), '修复 @file:package.json 的状态', '草稿回填输入框')
  assert.equal(submitted.length, 0)

  // 继续编辑后 Enter → 预览再次出现 → 再确认提交
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(out.chunks.join('').includes('Mission Contract 预览'))
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(submitted.length, 1)
  app.dispose()
})

test('Esc 取消：丢弃提交、卡片消失、输入框空', async () => {
  const { app, out, stdin, submitted } = makeApp()
  app.start()
  for (const ch of '修复 @file:package.json 的状态') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick()

  out.clear()
  stdin.dataHandler!('\x1B') // lone ESC → 80ms 后派发 escape
  await delay(120)
  assert.equal(submitted.length, 0, '取消不得提交')
  assert.ok(!out.chunks.join('').includes('Mission Contract 预览'), '卡片已消失')
  assert.equal(app.getInputValue(), '', '草稿被丢弃')
  app.dispose()
})

test('短自然语言直通（无卡片直接提交）', async () => {
  const { app, out, stdin, submitted } = makeApp()
  app.start()
  out.clear()
  for (const ch of '修一下滚动回弹') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(!out.chunks.join('').includes('Mission Contract 预览'), '短输入不弹卡')
  assert.equal(submitted.length, 1)
  app.dispose()
})

test('busy 中提交不弹卡（走 steer 归并原路径）', async () => {
  const { app, out, stdin, submitted } = makeApp()
  app.start()
  // 先提交一个长任务触发预览+确认，使 agent 进入 busy
  for (const ch of '修复 @file:package.json 的状态') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick()
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(submitted.length, 1)
  out.clear()

  // busy 中再输入结构化内容：应直接入 steer 队列，不弹预览卡
  for (const ch of '再看 @file:src/main.ts #回归') stdin.dataHandler!(ch)
  stdin.dataHandler!('\r')
  await tick()
  assert.ok(!out.chunks.join('').includes('Mission Contract 预览'), 'busy 中不弹卡')
  assert.equal(submitted.length, 1, '无新提交（已入 steer 队列）')
  app.dispose()
})
