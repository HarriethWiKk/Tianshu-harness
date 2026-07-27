import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewPayload, normalizeRollupCheck, parseActionsRunId, buildMergeArgs } from '../gh-cli.js'

describe('buildReviewPayload', () => {
  it('passes the verdict event through', () => {
    for (const event of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const) {
      const p = buildReviewPayload({ event, body: '', comments: [] })
      assert.equal(p.event, event)
    }
  })

  it('includes a trimmed summary body only when non-empty', () => {
    assert.equal(buildReviewPayload({ event: 'COMMENT', body: '   ', comments: [] }).body, undefined)
    assert.equal(buildReviewPayload({ event: 'COMMENT', body: '  hi  ', comments: [] }).body, 'hi')
  })

  it('maps a new-side (addition/context) comment to RIGHT + newLine', () => {
    const p = buildReviewPayload({
      event: 'COMMENT',
      body: '',
      comments: [{ path: 'src/foo.ts', newLine: 42, body: 'nit' }],
    })
    assert.deepEqual(p.comments, [{ path: 'src/foo.ts', line: 42, side: 'RIGHT', body: 'nit' }])
  })

  it('maps an old-side (deletion) comment to LEFT + oldLine', () => {
    const p = buildReviewPayload({
      event: 'REQUEST_CHANGES',
      body: '',
      comments: [{ path: 'src/foo.ts', oldLine: 7, body: 'why remove?' }],
    })
    assert.deepEqual(p.comments, [{ path: 'src/foo.ts', line: 7, side: 'LEFT', body: 'why remove?' }])
  })

  it('prefers newLine (RIGHT) when both old and new are present (context line)', () => {
    const p = buildReviewPayload({
      event: 'COMMENT',
      body: '',
      comments: [{ path: 'a.ts', oldLine: 3, newLine: 5, body: 'ctx' }],
    })
    assert.deepEqual(p.comments, [{ path: 'a.ts', line: 5, side: 'RIGHT', body: 'ctx' }])
  })

  it('drops comments missing a path, a line anchor, or a body', () => {
    const p = buildReviewPayload({
      event: 'COMMENT',
      body: 'summary',
      comments: [
        { path: '', newLine: 1, body: 'no path' },
        { path: 'a.ts', body: 'no line' },
        { path: 'a.ts', newLine: 2, body: '   ' },
        { path: 'a.ts', newLine: 9, body: 'keep me' },
      ],
    })
    assert.deepEqual(p.comments, [{ path: 'a.ts', line: 9, side: 'RIGHT', body: 'keep me' }])
  })

  it('omits the comments field entirely when none survive filtering', () => {
    const p = buildReviewPayload({ event: 'APPROVE', body: 'LGTM', comments: [] })
    assert.equal(p.comments, undefined)
    assert.equal(p.body, 'LGTM')
    assert.equal(p.event, 'APPROVE')
  })
})

describe('normalizeRollupCheck', () => {
  it('maps a completed CheckRun failure to FAILURE with the raw conclusion kept', () => {
    const c = normalizeRollupCheck({
      __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/123',
    })
    assert.deepEqual(c, {
      name: 'build', state: 'FAILURE', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/123',
    })
  })

  it('maps an in-progress CheckRun (no conclusion) to PENDING', () => {
    const c = normalizeRollupCheck({ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null })
    assert.equal(c.state, 'PENDING')
    assert.equal(c.conclusion, undefined)
  })

  it('treats NEUTRAL/SKIPPED CheckRuns as passing; CANCELLED as ERROR', () => {
    assert.equal(normalizeRollupCheck({ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'NEUTRAL' }).state, 'SUCCESS')
    assert.equal(normalizeRollupCheck({ __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' }).state, 'SUCCESS')
    assert.equal(normalizeRollupCheck({ __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'CANCELLED' }).state, 'ERROR')
    assert.equal(normalizeRollupCheck({ __typename: 'CheckRun', name: 'd', status: 'COMPLETED', conclusion: 'TIMED_OUT' }).state, 'FAILURE')
  })

  it('maps a StatusContext by its state, using context/targetUrl', () => {
    const c = normalizeRollupCheck({
      __typename: 'StatusContext', context: 'ci/circleci', state: 'SUCCESS',
      targetUrl: 'https://circleci.com/gh/o/r/42',
    })
    assert.deepEqual(c, { name: 'ci/circleci', state: 'SUCCESS', detailsUrl: 'https://circleci.com/gh/o/r/42' })
  })

  it('detects a StatusContext without __typename via the context field', () => {
    const c = normalizeRollupCheck({ context: 'expected-check', state: 'EXPECTED' })
    assert.equal(c.name, 'expected-check')
    assert.equal(c.state, 'EXPECTED')
  })

  it('falls back to PENDING for unknown state values', () => {
    assert.equal(normalizeRollupCheck({ context: 'x', state: 'WEIRD' }).state, 'PENDING')
    assert.equal(normalizeRollupCheck({ __typename: 'CheckRun', name: 'y', status: 'QUEUED' }).state, 'PENDING')
  })
})

describe('parseActionsRunId', () => {
  it('extracts the run id from an Actions detailsUrl', () => {
    assert.equal(parseActionsRunId('https://github.com/owner/repo/actions/runs/987654321'), 987654321)
    assert.equal(parseActionsRunId('https://github.com/owner/repo/actions/runs/123/job/456'), 123)
  })

  it('returns null for external CI or missing urls', () => {
    assert.equal(parseActionsRunId('https://circleci.com/gh/owner/repo/42'), null)
    assert.equal(parseActionsRunId('https://buildkite.com/owner/repo/builds/7'), null)
    assert.equal(parseActionsRunId(undefined), null)
    assert.equal(parseActionsRunId(''), null)
  })
})

describe('buildMergeArgs', () => {
  it('builds a plain squash merge', () => {
    assert.deepEqual(buildMergeArgs(12, 'squash'), ['pr', 'merge', '12', '--squash'])
  })

  it('appends --auto and --delete-branch only when requested', () => {
    assert.deepEqual(buildMergeArgs(3, 'merge', { auto: true, deleteBranch: true }),
      ['pr', 'merge', '3', '--merge', '--auto', '--delete-branch'])
    assert.deepEqual(buildMergeArgs(3, 'rebase', { auto: true }), ['pr', 'merge', '3', '--rebase', '--auto'])
    assert.deepEqual(buildMergeArgs(3, 'rebase', {}), ['pr', 'merge', '3', '--rebase'])
  })
})
