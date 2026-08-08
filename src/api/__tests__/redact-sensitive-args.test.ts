import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactSensitiveArgs } from '../openai-client.js'

describe('redactSensitiveArgs', () => {
  it('masks string values of sensitive keys', () => {
    const input = '{"command":"curl x","password":"hunter2","user":"alice"}'
    const out = redactSensitiveArgs(input)
    assert.ok(out.includes('"password":"[REDACTED]"'))
    assert.ok(!out.includes('hunter2'))
    assert.ok(out.includes('"user":"alice"'))
  })

  it('handles common sensitive key shapes case-insensitively', () => {
    const input = '{"API_KEY":"abc","Authorization":"Bearer t","db_secret": "s3","access-key":"k"}'
    const out = redactSensitiveArgs(input)
    assert.ok(!out.includes('abc'))
    assert.ok(!out.includes('Bearer t'))
    assert.ok(!out.includes('s3"'))
    assert.ok(!out.includes('"k"'))
  })

  it('masks an unterminated trailing value in truncated fragments', () => {
    const out = redactSensitiveArgs('{"token":"very-long-secret-that-was-cu')
    assert.ok(!out.includes('very-long-secret'))
    assert.ok(out.includes('[REDACTED]'))
  })

  it('leaves non-sensitive content untouched', () => {
    const input = '{"file_path":"/tmp/a.txt","content":"hello"}'
    assert.equal(redactSensitiveArgs(input), input)
  })

  it('handles escaped quotes inside values', () => {
    const input = '{"password":"a\\"b","next":"keep"}'
    const out = redactSensitiveArgs(input)
    assert.ok(!out.includes('a\\"b'))
    assert.ok(out.includes('"next":"keep"'))
  })
})
