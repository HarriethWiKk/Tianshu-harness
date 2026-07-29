import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTeamPanel, buildTeamPanelLines } from '../format/team-panel.js'
import { encodeTeamPanelModel, decodeTeamPanelModel, type TeamPanelModel } from '../team-panel-model.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const model: TeamPanelModel = {
  mode: 'standard',
  currentWave: 0,
  totalWaves: 2,
  dispatched: 3,
  blocked: [],
  waves: [
    { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: 'parallel-safe' },
    { id: 'wave-2', taskIds: ['t3'], risk: 'high', reason: 'shared files' },
  ],
  tasks: [
    { id: 't1', title: 'explore api', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done', summary: 'found 3 endpoints' },
    { id: 't2', title: 'map imports', authority: 'tianxuan', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', status: 'running', files: [] },
    { id: 't3', title: 'patch retry', authority: 'tianliang', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'high', files: [], status: 'waiting' },
  ],
}

describe('formatTeamPanel', () => {
  it('renders waves, star identities, and task status glyphs', () => {
    const plain = buildTeamPanelLines(model, 80).join('\n')
    assert.ok(plain.includes('团队编队'), 'title')
    assert.ok(plain.includes('/team standard'), 'mode label')
    assert.ok(plain.includes('wave 1/2'), 'wave label')
    assert.ok(plain.includes('wave-1'), 'wave id')
    assert.ok(plain.includes('✓ t1'), 'done glyph on task row')
    assert.ok(plain.includes('◐ t2'), 'running glyph on task row')
    assert.ok(plain.includes('◌ t3'), 'waiting glyph on task row')
    assert.ok(plain.includes('依赖 t1'), 'dependency line')
    assert.ok(plain.includes('found 3 endpoints'), 'task summary')
    assert.ok(plain.includes('审查门'), 'review gate segment in footer')
  })

  it('applies ANSI color (error on high-risk line, muted title)', () => {
    const lines = formatTeamPanel(model, theme, 80)
    assert.ok(/\x1B\[/.test(lines[0]!), 'title line has color')
    const highLine = lines.find(l => l.includes('high ⚠'))
    assert.ok(highLine && /\x1B\[/.test(highLine), 'high-risk line has color')
  })

  it('round-trips through encode/decode', () => {
    const decoded = decodeTeamPanelModel(encodeTeamPanelModel(model))
    assert.ok(decoded)
    const plain = stripAnsi(formatTeamPanel(decoded!, theme, 80).join('\n'))
    assert.ok(plain.includes('explore api'))
  })

  it('W2b: round-trips gate and reviewDetail fields', () => {
    const withGate: TeamPanelModel = {
      ...model,
      gate: { wave: 0, passed: false, failures: ['tsc --noEmit: type error in src/foo.ts'] },
      reviewDetail: 'Review gate [L2]: rejected — typecheck failed with 3 errors',
    }
    const encoded = encodeTeamPanelModel(withGate)
    assert.ok(encoded.includes('rivet:team-panel:v1:'))
    const decoded = decodeTeamPanelModel(encoded)
    assert.ok(decoded)
    assert.ok(decoded!.gate)
    assert.equal(decoded!.gate!.wave, 0)
    assert.equal(decoded!.gate!.passed, false)
    assert.equal(decoded!.gate!.failures.length, 1)
    assert.ok(decoded!.gate!.failures[0]!.includes('tsc'))
    assert.ok(decoded!.reviewDetail!.includes('Review gate'))
    assert.ok(decoded!.reviewDetail!.includes('rejected'))
  })

  it('W2b: gate absent when not provided', () => {
    const encoded = encodeTeamPanelModel(model)
    const decoded = decodeTeamPanelModel(encoded)
    assert.ok(decoded)
    assert.equal(decoded!.gate, undefined)
    assert.equal(decoded!.reviewDetail, undefined)
  })

  it('W2b: renders gate failure card with failures and escape-hatch hint', () => {
    const withGate: TeamPanelModel = {
      ...model,
      gate: {
        wave: 1,
        passed: false,
        failures: ['tsc --noEmit: 3 errors', 'npm test: 2 failing', 'lint: unused import', 'docs check', 'fifth failure'],
      },
    }
    const plain = buildTeamPanelLines(withGate, 80).join('\n')
    assert.ok(plain.includes('波间门禁未通过 (Wave 1)'), 'gate failure header')
    assert.ok(plain.includes('tsc --noEmit: 3 errors'), 'first failure listed')
    assert.ok(plain.includes('docs check'), 'fourth failure listed (cap = 4)')
    assert.ok(!plain.includes('fifth failure'), 'fifth failure truncated')
    assert.ok(plain.includes('另 1 项失败'), 'overflow counter')
    assert.ok(plain.includes('RIVET_WAVE_GATE=0'), 'escape-hatch hint')
  })

  it('W2b: passed gate renders nothing (no noise)', () => {
    const withGate: TeamPanelModel = {
      ...model,
      gate: { wave: 0, passed: true, failures: [] },
    }
    const plain = buildTeamPanelLines(withGate, 80).join('\n')
    assert.ok(!plain.includes('波间门禁'), 'no gate card when passed')
  })

  it('W2b: renders reviewDetail when verdict is not passed', () => {
    const withDetail: TeamPanelModel = {
      ...model,
      reviewVerdict: 'rejected',
      reviewDetail: 'Review gate [L2]: rejected\ntypecheck failed with 3 errors\nsee src/foo.ts',
    }
    const plain = buildTeamPanelLines(withDetail, 80).join('\n')
    assert.ok(plain.includes('审查详情'), 'review detail header')
    assert.ok(plain.includes('Review gate [L2]: rejected'), 'first detail line')
    assert.ok(plain.includes('see src/foo.ts'), 'last detail line')
  })

  it('W2b: reviewDetail hidden when verdict passed', () => {
    const withDetail: TeamPanelModel = {
      ...model,
      reviewVerdict: 'approved',
      reviewDetail: 'all clear, nothing to report',
    }
    const plain = buildTeamPanelLines(withDetail, 80).join('\n')
    assert.ok(!plain.includes('审查详情'), 'no detail section on pass')
    assert.ok(!plain.includes('all clear'), 'detail body suppressed')
  })

  it('W2b: long reviewDetail truncated to 6 lines with total counter', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `finding ${i + 1}: something`)
    const withDetail: TeamPanelModel = {
      ...model,
      reviewVerdict: 'failed',
      reviewDetail: lines.join('\n'),
    }
    const plain = buildTeamPanelLines(withDetail, 80).join('\n')
    assert.ok(plain.includes('finding 6'), 'sixth line shown')
    assert.ok(!plain.includes('finding 7'), 'seventh line truncated')
    assert.ok(plain.includes('审查全文共 10 行'), 'total line counter')
  })
})
