import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeTurnDepth, buildEffortContext } from '../p3-reward.js'

describe('computeTurnDepth', () => {
  it('有轮次上限时是已用比例', () => {
    assert.equal(computeTurnDepth(0, 200), 0)
    assert.equal(computeTurnDepth(50, 200), 0.25)
    assert.equal(computeTurnDepth(200, 200), 1)
  })

  // maxTurns=0 是 YOLO 的「无上限」哨兵。按比例算分母为 0（或被 Math.max(…,1)
  // 兜成 1）会让深度从第一轮起就饱和到 1，bandit 的该维度失去区分度。
  it('maxTurns=0（YOLO 无上限）退化为固定分母，仍随轮次单调爬升', () => {
    assert.equal(computeTurnDepth(0, 0), 0)
    assert.equal(computeTurnDepth(25, 0), 0.5)
    assert.ok(computeTurnDepth(10, 0) < computeTurnDepth(30, 0))
    assert.equal(computeTurnDepth(80, 0), 1, '超过固定分母后封顶')
  })

  it('缺省 maxTurns 与无上限同解（调用方拿不到预算时的退化路径）', () => {
    assert.equal(computeTurnDepth(25), computeTurnDepth(25, 0))
  })

  it('落进 buildEffortContext 的 turnDepth 维度仍在 0-1', () => {
    const ctx = buildEffortContext({
      taskComplexity: 0.5, errorRate: 0.1,
      turnDepth: computeTurnDepth(500, 0),
      fileCount: 3, isRepeat: false, timeOfDay: 0.5,
    })
    assert.equal(ctx[2], 1)
  })
})
