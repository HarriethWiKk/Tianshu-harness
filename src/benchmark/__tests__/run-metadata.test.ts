import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  benchmarkRunNonce,
  benchmarkStoreFileName,
  defaultSessionDataDir,
  countSuiteRunsInDir,
} from '../run-metadata.js'

const FIXED = new Date(2026, 7, 8, 12, 34, 56) // 2026-08-08 12:34:56

test('benchmarkRunNonce formats yyyymmdd-HHmmss deterministically', () => {
  assert.equal(benchmarkRunNonce(FIXED), '20260808-123456')
  assert.equal(benchmarkRunNonce(new Date(2026, 0, 3, 9, 5, 7)), '20260103-090507')
})

test('benchmarkStoreFileName embeds suiteId + nonce', () => {
  assert.equal(benchmarkStoreFileName('r1-smoke', FIXED), 'runs-r1-smoke-20260808-123456.jsonl')
  assert.equal(benchmarkStoreFileName('r1-spark-taiyi', FIXED), 'runs-r1-spark-taiyi-20260808-123456.jsonl')
})

test('defaultSessionDataDir lives under os.tmpdir with suiteId-nonce', () => {
  const dir = defaultSessionDataDir('r1-smoke', FIXED)
  assert.ok(dir.startsWith(tmpdir()), `expected tmpdir root, got ${dir}`)
  assert.ok(dir.includes('rivet-bench'))
  assert.ok(dir.endsWith('r1-smoke-20260808-123456'))
})

test('countSuiteRunsInDir sums matching suiteId across all jsonl files (incl legacy names)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-scan-'))
  try {
    // new-style store with 2 matching lines + 1 other suite
    writeFileSync(join(dir, 'runs-r1-smoke-20260808-100000.jsonl'), [
      JSON.stringify({ runId: 'a', suiteId: 'r1-smoke', taskId: 't1', provider: 'p', model: 'm', status: 'passed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), metrics: { turns: 1, toolCalls: 1, retries: 0 } }),
      JSON.stringify({ runId: 'b', suiteId: 'r1-smoke', taskId: 't2', provider: 'p', model: 'm', status: 'failed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), metrics: { turns: 2, toolCalls: 2, retries: 0 } }),
      JSON.stringify({ runId: 'c', suiteId: 'other-suite', taskId: 't1', provider: 'p', model: 'm', status: 'passed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), metrics: { turns: 1, toolCalls: 1, retries: 0 } }),
    ].join('\n'), 'utf-8')
    // legacy Phase 1 store name (no runs- prefix) with 1 matching line
    writeFileSync(join(dir, 'spark-taiyi-20260807.jsonl'), [
      JSON.stringify({ runId: 'd', suiteId: 'r1-smoke', taskId: 't3', provider: 'p', model: 'm', status: 'blocked', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), metrics: { turns: 0, toolCalls: 0, retries: 0 } }),
    ].join('\n'), 'utf-8')
    // garbage line must be skipped, not counted
    writeFileSync(join(dir, 'runs-garbage.jsonl'), 'not-json\n', 'utf-8')

    assert.equal(countSuiteRunsInDir(dir, 'r1-smoke'), 3)
    assert.equal(countSuiteRunsInDir(dir, 'other-suite'), 1)
    assert.equal(countSuiteRunsInDir(dir, 'never-run'), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('countSuiteRunsInDir returns 0 for missing directory', () => {
  assert.equal(countSuiteRunsInDir(join(tmpdir(), 'definitely-missing-' + Date.now()), 'r1-smoke'), 0)
})

test('countSuiteRunsInDir ignores non-jsonl files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-scan-'))
  try {
    writeFileSync(join(dir, 'notes.md'), 'not a store', 'utf-8')
    assert.equal(countSuiteRunsInDir(dir, 'r1-smoke'), 0)
    assert.ok(existsSync(join(dir, 'notes.md')), 'unrelated file untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
