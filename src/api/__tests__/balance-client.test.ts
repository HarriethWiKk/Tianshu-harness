import { test } from 'node:test'
import assert from 'node:assert/strict'
import { balanceEndpoint } from '../balance-client.js'

test('balanceEndpoint: 剥掉 OpenAI 兼容层后缀（preset baseUrl 带 /v1）', () => {
  assert.equal(balanceEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/beta'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/user/balance')
})

test('balanceEndpoint: 域根 baseUrl 原样拼接', () => {
  assert.equal(balanceEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/user/balance')
})

test('balanceEndpoint: 只剥末段，路径中间的 v1 不动', () => {
  assert.equal(balanceEndpoint('https://proxy.example.com/v1/deepseek'), 'https://proxy.example.com/v1/deepseek/user/balance')
})
