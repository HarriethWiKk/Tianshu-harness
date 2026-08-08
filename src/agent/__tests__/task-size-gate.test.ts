import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOrchestrationScale } from '../task-size-gate.js'

describe('task-size-gate', () => {
  it('blocks typo fix (small signal + short text)', () => {
    const r = classifyOrchestrationScale('fix a typo in config.ts')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
    assert.ok(r.reason.includes('typo'))
  })

  it('blocks rename (small signal)', () => {
    const r = classifyOrchestrationScale('rename variable x to y')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('does NOT block refactor (large signal)', () => {
    const r = classifyOrchestrationScale('refactor the entire authentication system')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('does NOT block medium-complexity task (no signal, moderate words)', () => {
    const r = classifyOrchestrationScale('implement a new state machine with persistence and web hooks for the notification system')
    assert.equal(r.scale, 'medium')
    assert.equal(r.blocked, false)
  })

  it('blocks very short text (word count threshold)', () => {
    const r = classifyOrchestrationScale('hi')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
    assert.ok(r.reason.includes('2 words') || r.reason.includes('1 words') || r.reason.includes('small'))
  })

  it('escape hatch bypasses gate', () => {
    const r = classifyOrchestrationScale('force: fix typo in config.ts')
    assert.equal(r.blocked, false)
    assert.ok(r.reason.includes('escape hatch'))
  })

  it('escape hatch: quick prefix also works', () => {
    const r = classifyOrchestrationScale('quick: rename x')
    assert.equal(r.blocked, false)
  })

  it('large signal takes priority over small signal when both present', () => {
    // "refactor" is large, "typo" is small — large wins per priority order
    const r = classifyOrchestrationScale('refactor the typo fix function')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('does NOT block long text with small signal (word count > threshold)', () => {
    // Small signal but text is long enough to suggest real context
    const longText = 'fix a typo in the configuration file that was introduced during the last deployment cycle when we migrated from the old config format to the new one with additional validation rules and schema checking across fifty different modules'
    const r = classifyOrchestrationScale(longText)
    // typo is a small signal, but wordCount > 50 → not blocked
    assert.equal(r.blocked, false)
  })

  it('handles Chinese text — short Chinese phrase blocked by word count', () => {
    const r = classifyOrchestrationScale('修一个错字')
    // 5 CJK chars → ceil(5/2) = 3 words → ≤ 15 → small
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('handles Chinese text — long Chinese task not blocked', () => {
    const r = classifyOrchestrationScale('重构整个认证系统的架构，需要跨模块修改认证流程、迁移旧的用户模型到新的类型系统、并添加全面的端到端测试覆盖')
    // Has no English large signals, but word count high enough → not small
    assert.equal(r.blocked, false)
  })

  it('blocks "minor fix" signal', () => {
    const r = classifyOrchestrationScale('minor fix in the parser')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('does NOT block "multiple modules" (large signal)', () => {
    const r = classifyOrchestrationScale('update API contracts across multiple modules with backward compatibility')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('complexity: small → simple', () => {
    const r = classifyOrchestrationScale('fix a typo in config.ts')
    assert.equal(r.complexity, 'simple')
  })

  it('complexity: medium → moderate', () => {
    const r = classifyOrchestrationScale('implement a new state machine with persistence and web hooks for the notification system')
    assert.equal(r.scale, 'medium')
    assert.equal(r.complexity, 'moderate')
  })

  it('complexity: large without complex signal → advanced', () => {
    const r = classifyOrchestrationScale('refactor the entire authentication system')
    assert.equal(r.scale, 'large')
    assert.equal(r.complexity, 'advanced')
  })

  it('complexity: large with complex signal → complex', () => {
    const r = classifyOrchestrationScale('comprehensive deep dive with cross-referencing and exhaustive verification across multiple modules')
    assert.equal(r.scale, 'large')
    assert.equal(r.complexity, 'complex')
  })

  it('complexity: Chinese complex signals on a large task → complex', () => {
    const r = classifyOrchestrationScale('refactor 跨实体交叉验证和多跳链的穷尽覆盖')
    assert.equal(r.scale, 'large')
    assert.equal(r.complexity, 'complex')
  })

  it('complexity: escape hatch → moderate', () => {
    const r = classifyOrchestrationScale('force: fix typo in config.ts')
    assert.equal(r.complexity, 'moderate')
  })

  it('chinese large signals: short Chinese big task not blocked (regression: 审查门中文信号缺失)', () => {
    // 10 CJK chars → 5 words → would fall to small via word count without a
    // Chinese large signal; 架构/整个系统 must upgrade it to large
    const r = classifyOrchestrationScale('对整个系统做架构调整并跨模块改造')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('chinese large signals: refactor+migrate task → large advanced', () => {
    const r = classifyOrchestrationScale('重构整个项目的模块划分并迁移现有代码到新的目录结构')
    assert.equal(r.scale, 'large')
    assert.equal(r.complexity, 'advanced')
  })

  it('chinese large signals: exhaustive research task → large complex', () => {
    const r = classifyOrchestrationScale('穷尽式调研这个主题的方方面面')
    assert.equal(r.scale, 'large')
    assert.equal(r.complexity, 'complex')
  })

  it('chinese large signals: small Chinese fix stays blocked (no false positive)', () => {
    const r = classifyOrchestrationScale('修复登录页的按钮样式')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('large signal wins over word count even for small Chinese tasks (lock current semantics)', () => {
    // 审查门 MEDIUM-2：中文大词无 \b 边界 + largeSignal 优先于词数阈值——
    // 含大词的小任务会被判 large 放行。与英文既有语义一致（'refactor the
    // typo fix function' 同断言），且 large 不 block 无行为危害；待 complexity
    // 消费方接入时再决策是否收紧。此处锁住现状防无意识改动。
    const r = classifyOrchestrationScale('修复架构文档里的错别字')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('countWords handles mixed Chinese/English input', () => {
    // 重构(2字→1词) the(1) auth(1) module(1) 并(1字→1词) 修复(2字→1词) typo(1) = 7
    const r = classifyOrchestrationScale('重构 the auth module 并修复 typo')
    assert.equal(r.wordCount, 7)
  })
})
