/**
 * contract-projection.test.ts — 白名单 + 泄露防线单测。
 *
 * 核心断言：
 * 1. 白名单字段出现在输出
 * 2. 禁止字段（内部 WorkOrder 字段 + 任何认知层泄漏）不出现在输出
 * 3. allowedToolsDigest 正确摘要
 * 4. 可选 authority/authorityReason/scope.files/scope.symbols/scope.maxFiles 缺省时不出现
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContractProjection,
  digestAllowedTools,
  type ContractProjection,
} from '../contract-projection.js'
import type { WorkOrder } from '../work-order.js'

/** 构造一个字段齐全的参考 WorkOrder（所有可选字段都填）。 */
function fullWorkOrder(): WorkOrder {
  return {
    id: 'wo_test',
    parentTurnId: 't1',
    kind: 'code_search',
    profile: 'code_scout',
    objective: 'Find all callers of function X',
    scope: {
      files: ['src/a.ts', 'src/b.ts'],
      symbols: ['handleSubmit'],
      commands: ['check'],
      externalUrls: ['https://example.com'],
      maxFiles: 10,
      maxTokens: 100_000,
    },
    constraints: ['no writes', 'read-only'],
    allowedTools: ['read_file', 'grep', 'glob', 'inspect_project', 'repo_map'],
    disallowedTools: ['bash', 'write_file'],
    dedupeKey: 'abc',
    dependencies: ['wo_dep'],
    aggregationPolicy: 'all_required',
    budget: {
      maxTurns: 5,
      maxTokens: 200_000,
      timeoutMs: 120_000,
      maxRetries: 2,
      retryBackoffMs: 1000,
      maxRetryBackoffMs: 10_000,
    },
    domain: 'backend',
    authority: 'tianquan',
    authorityReason: 'architecture review',
    reviewDepth: 1,
    delegationDepth: 0,
    riskTier: 'low',
    modelOverride: { provider: 'deepseek', model: 'v4' },
    tierFloor: 'balanced',
  }
}

// ── allowedToolsDigest ──

describe('digestAllowedTools', () => {
  it('≤3 tools: all listed, no +N', () => {
    assert.equal(digestAllowedTools(['grep', 'read_file']), 'grep,read_file')
  })

  it('>3 tools: first 3 + +N', () => {
    assert.equal(
      digestAllowedTools(['read_file', 'grep', 'glob', 'inspect_project', 'repo_map', 'semantic_search', 'related_tests']),
      'glob,grep,inspect_project +4',
    )
  })

  it('empty array', () => {
    assert.equal(digestAllowedTools([]), '')
  })
})

// ── buildContractProjection 白名单 ──

describe('buildContractProjection', () => {
  it('白名单字段全部出现在输出', () => {
    const p = buildContractProjection(fullWorkOrder())
    assert.equal(p.objective, 'Find all callers of function X')
    assert.equal(p.profile, 'code_scout')
    assert.equal(p.authority, 'tianquan')
    assert.equal(p.authorityReason, 'architecture review')
    assert.deepEqual(p.scope.files, ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(p.scope.symbols, ['handleSubmit'])
    assert.equal(p.scope.maxFiles, 10)
    assert.deepEqual(p.constraints, ['no writes', 'read-only'])
    assert.equal(p.budget.maxTurns, 5)
    assert.equal(p.budget.timeoutMs, 120_000)
    assert.equal(p.allowedToolsDigest, 'glob,grep,inspect_project +2')
  })

  it('可选字段缺省时不出现', () => {
    const order = fullWorkOrder()
    order.authority = undefined as any
    order.authorityReason = undefined as any
    order.scope = { ...order.scope, files: undefined, symbols: undefined, maxFiles: undefined }
    const p = buildContractProjection(order)
    assert.equal('authority' in p, false)
    assert.equal('authorityReason' in p, false)
    assert.equal('files' in p.scope, false)
    assert.equal('symbols' in p.scope, false)
    assert.equal('maxFiles' in p.scope, false)
  })

  // ── 泄露防线 ──

  const FORBIDDEN_KEYS = [
    'id',
    'parentTurnId',
    'kind',
    'disallowedTools',
    'dedupeKey',
    'dependencies',
    'aggregationPolicy',
    'domain',
    'workerCwd',
    'reviewDepth',
    'delegationDepth',
    'riskTier',
    'modelOverride',
    'tierFloor',
    // 认知层字段——从模型注入，虽然不在 WorkOrder 上，但单测断言它们绝不泄漏
    'volatileBlock',
    'ledger',
    'claims',
    'stigmergy',
    'starLessons',
  ]

  for (const key of FORBIDDEN_KEYS) {
    it(`禁止字段 "${key}" 不出现在投影中`, () => {
      const p = buildContractProjection(fullWorkOrder())
      const flat = JSON.stringify(p)
      assert.equal(
        flat.includes(`"${key}"`),
        false,
        `ContractProjection must NOT contain "${key}"`,
      )
    })
  }

  it('scope 中不泄漏 commands/externalUrls/maxTokens', () => {
    const p = buildContractProjection(fullWorkOrder())
    const s = p.scope as Record<string, unknown>
    assert.equal('commands' in s, false)
    assert.equal('externalUrls' in s, false)
    assert.equal('maxTokens' in s, false)
  })

  it('budget 中不泄漏 maxTokens/maxRetries/retryBackoffMs/maxRetryBackoffMs', () => {
    const p = buildContractProjection(fullWorkOrder())
    const b = p.budget as Record<string, unknown>
    assert.equal('maxTokens' in b, false)
    assert.equal('maxRetries' in b, false)
    assert.equal('retryBackoffMs' in b, false)
    assert.equal('maxRetryBackoffMs' in b, false)
  })

  it('model 字段缺省（由调用方填入）', () => {
    const p = buildContractProjection(fullWorkOrder())
    assert.equal(p.model, undefined)
  })
})
