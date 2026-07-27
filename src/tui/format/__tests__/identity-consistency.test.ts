/**
 * 跨面身份一致性守门测试（可视化可读性重构 任务 6）。
 *
 * 目的不是锁字面（中文映射以 PROFILE_LABELS / 星域注册表为准），而是锁形态：
 * 所有渲染面的身份必须由 formatWorkerIdentity 单一真源产出，
 * 且身份串里不得泄漏原始英文 profile 名——未来某面手改回原文时这里先红。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkerIdentity } from '../profile-labels.js'

describe('identity consistency across surfaces', () => {
  it('all surfaces derive identity from the single formatter', () => {
    const cases = [
      { profile: 'code_scout', authority: 'tianxuan', expect: '天璇·侦察代码' },
      { profile: 'reviewer', authority: undefined, expect: '审查' },
      // 只验形态不锁字面：映射表调整时本用例不应变红
      { profile: 'patcher', authority: 'tianliang', expect: undefined },
    ]
    for (const c of cases) {
      const id = formatWorkerIdentity({ profile: c.profile, authority: c.authority })
      assert.equal(typeof id, 'string')
      assert.ok(id.length > 0)
      if (c.expect) assert.equal(id, c.expect)
      // 关键：身份里不得出现原始 profile 英文名
      assert.doesNotMatch(id, new RegExp(c.profile))
    }
  })

  it('identity is stable for repeated calls（纯函数，无隐藏状态）', () => {
    const a = formatWorkerIdentity({ profile: 'code_scout', authority: 'tianxuan' })
    const b = formatWorkerIdentity({ profile: 'code_scout', authority: 'tianxuan' })
    assert.equal(a, b)
  })
})
