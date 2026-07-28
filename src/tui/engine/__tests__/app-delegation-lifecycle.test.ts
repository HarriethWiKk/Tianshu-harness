/**
 * TuiApp 委派生命周期收口 — resetRunLocalState 清理 mirror / dispatchCardShown /
 * toolTailCache（此前只增不减，长会话内存无界滞留），以及工具卡 tail 切行缓存行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, out, stdin }
}

test('resetRunLocalState 清空 mirror / dispatchCardShown / toolTailCache', () => {
  const { app } = makeApp()
  const a = app as unknown as {
    mirror: { apply: (x: unknown) => void; has: (id: string) => boolean }
    dispatchCardShown: Set<string>
    toolTailCache: Map<string, unknown>
    resetRunLocalState: () => void
  }
  a.mirror.apply({
    workOrderId: 'wo_x', parentToolId: 't1', profile: 'worker',
    status: 'running', eventKind: 'text', eventDetail: 'hello',
  })
  a.dispatchCardShown.add('wo_x')
  a.toolTailCache.set('t1', { ref: 'a\nb', lines: ['a', 'b'] })
  assert.ok(a.mirror.has('wo_x'))
  assert.equal(a.dispatchCardShown.size, 1)
  assert.equal(a.toolTailCache.size, 1)

  a.resetRunLocalState()

  assert.equal(a.mirror.has('wo_x'), false, 'mirror 记录必须随 run 状态回收')
  assert.equal(a.dispatchCardShown.size, 0)
  assert.equal(a.toolTailCache.size, 0)
})

test('liveToolTailLines 按累加器字符串引用缓存切分结果', () => {
  const { app } = makeApp()
  const a = app as unknown as {
    liveToolTailLines: (id: string, tail: string | undefined) => string[] | undefined
  }
  const tail = 'l1\nl2\nl3\n'
  const first = a.liveToolTailLines('t', tail)
  assert.deepEqual(first, ['l1', 'l2', 'l3'], '尾部换行先压掉再切')
  assert.equal(a.liveToolTailLines('t', tail), first, '同引用命中缓存（同一数组实例）')

  const grown = 'l1\nl2\nl3\nl4'
  const second = a.liveToolTailLines('t', grown)
  assert.deepEqual(second, ['l1', 'l2', 'l3', 'l4'], '引用变化（新 chunk）重新切分')
  assert.notEqual(second, first)

  assert.equal(a.liveToolTailLines('t', ''), undefined, '空 tail 不产生行')
  assert.equal(a.liveToolTailLines('t', undefined), undefined)
})

test('fleetFrame 按 (version, 秒桶) 复用快照，fleet 变更即重建', () => {
  const { app } = makeApp()
  const a = app as unknown as {
    fleet: { apply: (x: unknown) => void }
    fleetFrame: (cols: number, wantLines: boolean) => { lines: string[] | null; running: number }
  }
  const activity = (kind: string) => ({
    workOrderId: 'wo_1', parentToolId: 't1', profile: 'worker',
    status: 'running', eventKind: kind, eventDetail: kind === 'text' ? 'delta' : 'bash',
  })
  a.fleet.apply(activity('text'))

  const f1 = a.fleetFrame(80, true)
  assert.ok(f1.lines && f1.lines.length > 0, '有 active worker 时构建面板行')
  assert.equal(f1.running, 1)
  assert.equal(a.fleetFrame(80, true), f1, 'version/秒桶未变必须整段复用（同一对象）')

  a.fleet.apply(activity('tool_use'))
  const f2 = a.fleetFrame(80, true)
  assert.notEqual(f2, f1, 'fleet version 递增后快照重建')
})
