import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nextHistoryAfterSubmit, scoreHistoryEntries } from '../history.js'

describe('prompt history helpers', () => {
  it('adds newest entry to the front', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['old'], 'new'), ['new', 'old'])
  })

  it('does not duplicate the current newest entry', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['same', 'old'], 'same'), ['same', 'old'])
  })

  it('ignores blank input', () => {
    assert.deepEqual(nextHistoryAfterSubmit(['old'], '   '), ['old'])
  })
})

describe('scoreHistoryEntries（Ctrl+R 评分排序）', () => {
  it('前缀匹配优先于词命中（+10 vs +5）', () => {
    const entries = ['fix the scroll bug', 'scroll restoration fix']
    const out = scoreHistoryEntries(entries, 'scroll')
    assert.deepEqual(out, ['scroll restoration fix', 'fix the scroll bug'])
  })

  it('词命中累计加分（非前缀条目按命中词数排序；同分保原序）', () => {
    // 两条都不前缀命中但含全部 query 词：词数相同 → 同分保原序
    const entries = ['x alpha beta', 'y alpha beta']
    const out = scoreHistoryEntries(entries, 'alpha beta')
    assert.deepEqual(out, ['x alpha beta', 'y alpha beta'])
    // 少命中一个词的条目过不了全词子串过滤（searchHistory 的既有语义）
    assert.deepEqual(scoreHistoryEntries(['x alpha'], 'alpha beta'), [])
  })

  it('空 query 按原顺序截断', () => {
    const entries = ['a', 'b', 'c']
    assert.deepEqual(scoreHistoryEntries(entries, '', 2), ['a', 'b'])
  })

  it('无命中返回空', () => {
    assert.deepEqual(scoreHistoryEntries(['alpha'], 'zzz'), [])
  })
})
