import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scaledThreshold } from '../window-thresholds.js'

describe('scaledThreshold — 上下文窗口感知的提醒阈值', () => {
  it('200K 及以下返回 200K 基准值（旧行为）', () => {
    assert.equal(scaledThreshold(200_000, 12, 28), 12)
    assert.equal(scaledThreshold(128_000, 12, 28), 12)
    assert.equal(scaledThreshold(0, 12, 28), 12)
  })

  it('1M 及以上返回 1M 目标值', () => {
    assert.equal(scaledThreshold(1_000_000, 12, 28), 28)
    assert.equal(scaledThreshold(2_000_000, 12, 28), 28)
  })

  it('中间窗口线性插值并取整', () => {
    // 600K = 200K 与 1M 的中点 → (12+28)/2 = 20
    assert.equal(scaledThreshold(600_000, 12, 28), 20)
    // 400K = 1/4 处 → 12 + 16*0.25 = 16
    assert.equal(scaledThreshold(400_000, 12, 28), 16)
    // 800K = 3/4 处 → 12 + 16*0.75 = 24
    assert.equal(scaledThreshold(800_000, 12, 28), 24)
  })

  it('B1/回归空转使用各自基准对（4→9、5→12）', () => {
    assert.equal(scaledThreshold(200_000, 4, 9), 4)
    assert.equal(scaledThreshold(1_000_000, 4, 9), 9)
    assert.equal(scaledThreshold(1_000_000, 5, 12), 12)
    // 600K 中点
    assert.equal(scaledThreshold(600_000, 4, 9), 7) // round(6.5)
    assert.equal(scaledThreshold(600_000, 5, 12), 9) // round(8.5)
  })
})
