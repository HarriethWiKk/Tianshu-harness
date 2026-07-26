import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { WriteBatcher, MIN_FRAME_INTERVAL_MS } from '../write-batcher.js'

const nextMacrotask = () => new Promise(r => setTimeout(r, 0))
/** 轮询等待条件成立（事件循环拥塞下比定长 sleep 稳健——定时器竞态与机器负载无关）。 */
async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await delay(5)
  }
}

describe('WriteBatcher (microtask 合并 + 16ms 帧节流)', () => {
  it('coalesces many schedule() calls in one tick into a single flush', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    b.schedule()
    b.schedule()
    assert.equal(flushes, 0, 'flush is deferred to a microtask, not synchronous')

    await nextMacrotask()
    assert.equal(flushes, 1, 'three synchronous schedules collapse to one flush')
  })

  it('schedules again after a flush completes（窗口内走尾沿，最终仍 flush）', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    await waitFor(() => flushes === 1)

    b.schedule() // 16ms 窗口内 → 尾沿
    await waitFor(() => flushes === 2)
    // 尾沿不早于 leading 路径：第二次 flush 距第一次 ≥ MIN_FRAME_INTERVAL_MS 量级
    // （不断言竞态的「尚未 flush」中间态——定时器先后在高负载下不可依赖）
  })

  it('a schedule() issued from within onFlush coalesces into the trailing edge', async () => {
    let flushes = 0
    let reentered = false
    const b = new WriteBatcher(() => {
      flushes++
      if (!reentered) {
        reentered = true
        b.schedule() // re-arm during flush; pending was already reset to false
      }
    })

    b.schedule()
    await waitFor(() => flushes === 1)
    await waitFor(() => flushes === 2)
  })

  it('距上次 flush ≥16ms 的 schedule 走 microtask leading edge（无节流延迟）', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    await waitFor(() => flushes === 1)

    await delay(MIN_FRAME_INTERVAL_MS + 10) // 越过窗口
    b.schedule()
    await waitFor(() => flushes === 2, 100, /* 允许 microtask 立即 */)
  })

  it('flushNow invalidates an already queued microtask', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    b.flushNow()
    assert.equal(flushes, 1, 'critical flush runs synchronously')

    await delay(MIN_FRAME_INTERVAL_MS + 20)
    assert.equal(flushes, 1, 'stale queued microtask must not flush again')
  })

  it('flushNow 穿透节流窗口并作废尾沿定时器', async () => {
    let flushes = 0
    const b = new WriteBatcher(() => { flushes++ })

    b.schedule()
    await waitFor(() => flushes === 1)

    b.schedule() // 窗口内 → 尾沿定时器排队
    b.flushNow()
    assert.equal(flushes, 2, 'critical flush 同步穿透节流')

    await delay(MIN_FRAME_INTERVAL_MS + 20)
    assert.equal(flushes, 2, '被作废的尾沿定时器不得二次 flush')
  })

  it('flushNow reports errors and remains reusable', async () => {
    const errors: unknown[] = []
    let shouldThrow = true
    let flushes = 0
    const b = new WriteBatcher(() => {
      flushes++
      if (shouldThrow) throw new Error('render failed')
    }, err => errors.push(err))

    assert.doesNotThrow(() => b.flushNow())
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /render failed/)

    shouldThrow = false
    b.schedule()
    await waitFor(() => flushes === 2)
  })
})
