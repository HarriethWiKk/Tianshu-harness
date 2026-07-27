import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkerIdentity } from '../profile-labels.js'

describe('formatWorkerIdentity', () => {
  it('joins star name and role with a middot when authority is present', () => {
    assert.equal(formatWorkerIdentity({ profile: 'code_scout', authority: 'tianxuan' }), '天璇·侦察代码')
  })

  it('falls back to role only when authority is absent', () => {
    assert.equal(formatWorkerIdentity({ profile: 'reviewer' }), '审查')
  })

  it('falls back to worker for unknown profile', () => {
    assert.equal(formatWorkerIdentity({ profile: 'nonexistent_xyz' }), 'worker')
  })
})
