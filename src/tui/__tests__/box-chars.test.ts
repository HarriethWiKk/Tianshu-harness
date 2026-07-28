import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boxInnerWidth, boxOuterWidth } from '../box-chars.js'

describe('boxInnerWidth / boxOuterWidth 自适应缩放', () => {
  it('正常终端（≥26 列）：columns - 6，留呼吸', () => {
    assert.equal(boxInnerWidth(80), 74)
    assert.equal(boxInnerWidth(60), 54)
    assert.equal(boxInnerWidth(26), 20)
  })

  it('窄终端（<26 列）：框体顶满，外宽 = columns，不超出边界', () => {
    // 关键约束：boxOuterWidth(columns) <= columns（右边线不折行）
    for (const cols of [25, 24, 20, 16, 12, 10, 8]) {
      assert.ok(
        boxOuterWidth(cols) <= cols,
        `${cols} 列终端：框体外宽 ${boxOuterWidth(cols)} 超出边界 ${cols}`,
      )
    }
  })

  it('极窄终端（<8 列）：框体收缩，外宽 ≤ columns 不超出', () => {
    // 7 列：inner=3, 外宽=7（贴边）
    assert.equal(boxInnerWidth(7), 3)
    assert.equal(boxOuterWidth(7), 7)
    // 4 列：inner=0, 外宽=4（框体无内容区，但边线不超出）
    assert.equal(boxInnerWidth(4), 0)
    assert.equal(boxOuterWidth(4), 4)
    // 0 列：inner=0（下限保护，不返回负数）
    assert.equal(boxInnerWidth(0), 0)
    assert.equal(boxOuterWidth(0), 4)
  })

  it('框体外宽恒 = innerWidth + 4（几何一致性）', () => {
    for (const cols of [80, 40, 26, 20, 12, 4, 0]) {
      assert.equal(boxOuterWidth(cols), boxInnerWidth(cols) + 4)
    }
  })

  it('此前 bug 复现：20 列终端框体不再超出（旧逻辑外宽 24 > 20）', () => {
    // 旧 boxInnerWidth = max(20, cols-6) → 20 列终端 inner=20, 外宽=24 超出
    // 新逻辑：20 列终端 inner=16, 外宽=20 = columns，贴边不超出
    assert.equal(boxInnerWidth(20), 16)
    assert.equal(boxOuterWidth(20), 20)
  })
})
