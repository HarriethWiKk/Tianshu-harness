/**
 * redact.ts — 所有 SessionEvent 生产者的共享脱敏器。
 *
 * 这里锁的是「哪些形态必须遮、哪些形态绝不能误伤」的边界：
 * 泄漏面漏一条是安全事故，误伤面错一条是调试体验事故（日志里全是 [REDACTED]）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactValue, truncateUtf16Safe } from '../redact.js'

describe('redactText — 上下文形态（v1 起）', () => {
  it('Bearer token 遮蔽', () => {
    assert.equal(redactText('Authorization: Bearer sk-ant-abc123SECRET'), 'Authorization: Bearer [REDACTED]')
  })

  it('api_key/token/secret/password 赋值遮蔽', () => {
    assert.equal(redactText('token=sk-secret-xyz'), 'token=[REDACTED]')
    assert.equal(redactText('api_key: abc123'), 'api_key: [REDACTED]')
    assert.equal(redactText('password = hunter2'), 'password = [REDACTED]')
  })
})

describe('redactText — 裸密钥形态（无上下文也遮）', () => {
  it('sk- 族', () => {
    assert.equal(redactText('key is sk-live-abc123def456ghi789 done'), 'key is [REDACTED] done')
  })

  it('GitHub PAT 族（ghp_/gho_/ghu_/ghs_/ghr_）', () => {
    assert.equal(redactText('ghp_abcdef1234567890ABCDEF'), '[REDACTED]')
    assert.equal(redactText('gho_abcdef1234567890ABCDEF'), '[REDACTED]')
  })

  it('AWS AKIA', () => {
    assert.equal(redactText('AKIAIOSFODNN7EXAMPLE'), '[REDACTED]')
  })

  it('误伤面：prose 中的 sk- 片段不遮（前导字母数字时）', () => {
    assert.equal(redactText('desk-top1234567890abcdefgh'), 'desk-top1234567890abcdefgh')
  })

  it('误伤面：过短的 sk- 不遮', () => {
    assert.equal(redactText('sk-short'), 'sk-short')
  })
})

describe('redactValue — 对象递归', () => {
  it('敏感键名整值替换，其余递归', () => {
    const out = redactValue({ api_key: 'sk-abc', nested: { token: 'x' }, plain: 'y' }) as Record<string, unknown>
    assert.equal(out.api_key, '[REDACTED]')
    assert.equal((out.nested as Record<string, unknown>).token, '[REDACTED]')
    assert.equal(out.plain, 'y')
  })
})

describe('truncateUtf16Safe', () => {
  it('不劈开代理对', () => {
    const out = truncateUtf16Safe('ab😀cd', 3)
    assert.equal(out, 'ab')
    assert.equal([...out].every(c => c.codePointAt(0)! <= 0xFFFF || c.codePointAt(0)! > 0xFFFF), true)
  })

  it('预算内原样返回', () => {
    assert.equal(truncateUtf16Safe('abc', 10), 'abc')
  })
})
