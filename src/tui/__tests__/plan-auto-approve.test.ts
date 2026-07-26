import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PLAN_AUTO_APPROVE_MS,
  remainingSec,
  resolveAutoApproveMs,
  shouldArm,
  shouldFire,
} from '../plan-auto-approve.js'

test('resolveAutoApproveMs：未设默认 150s；0 关闭；显式值生效；非法值回落默认', () => {
  assert.equal(resolveAutoApproveMs({}), DEFAULT_PLAN_AUTO_APPROVE_MS)
  assert.equal(resolveAutoApproveMs({ RIVET_GOAL_PLAN_AUTO_APPROVE_MS: '0' }), 0)
  assert.equal(resolveAutoApproveMs({ RIVET_GOAL_PLAN_AUTO_APPROVE_MS: '30000' }), 30_000)
  assert.equal(resolveAutoApproveMs({ RIVET_GOAL_PLAN_AUTO_APPROVE_MS: 'abc' }), DEFAULT_PLAN_AUTO_APPROVE_MS)
  assert.equal(resolveAutoApproveMs({ RIVET_GOAL_PLAN_AUTO_APPROVE_MS: '-5' }), DEFAULT_PLAN_AUTO_APPROVE_MS)
})

test('shouldArm：goal off 或 delayMs=0 均不武装', () => {
  assert.equal(shouldArm(true, 150_000), true)
  assert.equal(shouldArm(false, 150_000), false)
  assert.equal(shouldArm(true, 0), false)
})

test('remainingSec：ceil 取整，过点归零', () => {
  const s = { slug: 'p', deadlineMs: 10_000 }
  assert.equal(remainingSec(s, 0), 10)
  assert.equal(remainingSec(s, 9_001), 1)
  assert.equal(remainingSec(s, 10_000), 0)
  assert.equal(remainingSec(s, 12_000), 0)
})

test('shouldFire：到点且守卫全过才触发；任一守卫失败不触发', () => {
  const s = { slug: 'p', deadlineMs: 10_000 }
  const ok = { idle: true, goalActive: true, planStillSubmitted: true }
  assert.equal(shouldFire(s, 9_999, ok), false, '未到点')
  assert.equal(shouldFire(s, 10_000, ok), true)
  assert.equal(shouldFire(s, 10_000, { ...ok, idle: false }), false)
  assert.equal(shouldFire(s, 10_000, { ...ok, goalActive: false }), false)
  assert.equal(shouldFire(s, 10_000, { ...ok, planStillSubmitted: false }), false)
})
