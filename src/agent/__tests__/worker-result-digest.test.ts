import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkerResultDigest } from '../worker-result-digest.js'

describe('formatWorkerResultDigest', () => {
  it('summarizes a passed result with finding count', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: '定位到 3 处渲染函数', findingsCount: 3, changedFilesCount: 0 })
    assert.match(d, /✓/)
    assert.match(d, /定位到 3 处渲染函数/)
    assert.match(d, /3 条发现/)
  })

  it('summarizes a patch result with changed files', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: '修复类型错误', findingsCount: 0, changedFilesCount: 2 })
    assert.match(d, /2 个文件/)
  })

  it('surfaces an honesty warning for a truncated/failed result', () => {
    const d = formatWorkerResultDigest({ status: 'blocked', summary: '部分完成', findingsCount: 0, changedFilesCount: 0, failureReason: 'max_turns' })
    assert.match(d, /⊗/)
    assert.match(d, /预算耗尽/)
  })

  it('evidenceStatus=failed 触发「验收证据验证失败」诚实警告', () => {
    const d = formatWorkerResultDigest({ status: 'failed', summary: '交付物未完成', findingsCount: 0, changedFilesCount: 1, evidenceStatus: 'failed' })
    assert.match(d, /✗/)
    assert.match(d, /⚠ 验收证据验证失败/)
  })

  it('failureReason 优先于 evidenceStatus（根因比信号更具体）', () => {
    const d = formatWorkerResultDigest({ status: 'failed', summary: 'x', findingsCount: 0, changedFilesCount: 0, failureReason: 'timeout', evidenceStatus: 'failed' })
    assert.match(d, /Worker 超时/)
    assert.doesNotMatch(d, /验收证据验证失败/)
  })

  it('evidenceStatus 非 failed 不产生警告', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: 'x', findingsCount: 0, changedFilesCount: 0, evidenceStatus: 'verified' })
    assert.doesNotMatch(d, /⚠/)
  })
})
