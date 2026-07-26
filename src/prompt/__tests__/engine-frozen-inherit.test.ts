import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * /cd frozen inheritance — the new engine (new cwd volatile snapshot) must
 * replay historical user messages BYTE-IDENTICALLY to the old engine (prefix
 * cache survives the switch), while the active boundary renders the new
 * project's volatile block (truthful new context, one tail-cut at the
 * boundary — the /domain-switch cost model, not a /resume byte-0 full miss).
 */

function mkEngine(cwd: string, marker: string, inheritFrozenFrom?: PromptEngine): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd, rivetMd: `# ${marker}` },
    habituationThreshold: 0,
    inheritFrozenFrom,
  })
}

/** Rendered content of the user message whose trailer text is `userText`. */
function renderedUser(messages: readonly OaiMessage[], userText: string): string {
  const msg = messages.find(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.includes(`\n---\n${userText}`),
  )
  assert.ok(msg && typeof msg.content === 'string', `expected rendered user message for "${userText}"`)
  return msg.content
}

const CONVERSATION: OaiMessage[] = [
  { role: 'user', content: 'm1' },
  { role: 'assistant', content: 'r1' },
  { role: 'user', content: 'm2' },
]

describe('/cd frozen inheritance (PromptEngine inheritFrozenFrom)', () => {
  it('historical user messages replay old bytes; the active boundary renders the new cwd volatile', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    // Turn 1 commits nothing yet; turn 2 commits m1's frozen snapshot at the
    // new boundary (m1 becomes historical).
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    const aReq2 = a.buildOaiRequest(CONVERSATION)
    const aHistoricalM1 = renderedUser(aReq2.messages, 'm1')
    assert.ok(aHistoricalM1.includes('OLD_PROJECT'), 'old engine renders its own marker')

    const b = mkEngine('/new/project', 'NEW_PROJECT', a)
    const bReq = b.buildOaiRequest(CONVERSATION)

    // 历史消息：继承的 frozen 快照 → 与旧引擎逐字节一致（前缀缓存命中）。
    assert.equal(renderedUser(bReq.messages, 'm1'), aHistoricalM1)

    // 活跃边界：按新 cwd 重采 volatile → 诚实的新项目上下文（边界断尾）。
    const bActiveM2 = renderedUser(bReq.messages, 'm2')
    assert.ok(bActiveM2.includes('NEW_PROJECT'), 'active boundary must render the new cwd context')
    assert.ok(!bActiveM2.includes('OLD_PROJECT'), 'active boundary must not leak the old project')
  })

  it('firstUserKey (byte-0 eviction anchor) survives inheritance', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    a.buildOaiRequest([{ role: 'user', content: 'anchor message' }])
    const b = mkEngine('/new/project', 'NEW_PROJECT', a)
    const anchor = (b as unknown as { firstUserKey: string | null }).firstUserKey
    assert.equal(anchor, 'anchor message')
  })

  it('control case: without inheritance the history rebuilds with the new volatile (the /resume cost)', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    const b = mkEngine('/new/project', 'NEW_PROJECT') // no inheritFrozenFrom
    const bReq = b.buildOaiRequest(CONVERSATION)
    assert.ok(
      renderedUser(bReq.messages, 'm1').includes('NEW_PROJECT'),
      'without inheritance, historical m1 is rebuilt with new bytes → byte-0 prefix miss',
    )
  })

  it('inheritance isolates state: committing in the new engine does not mutate the old one', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    const b = mkEngine('/new/project', 'NEW_PROJECT', a)
    // Drive b through a new boundary so it commits m2's snapshot.
    b.buildOaiRequest(CONVERSATION)
    b.buildOaiRequest([
      ...CONVERSATION,
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'm3' },
    ])
    const aMerged = (a as unknown as { frozenUserMerged: Map<string, string[]> }).frozenUserMerged
    assert.ok(!aMerged.has('m2'), 'old engine must not gain snapshots committed after the switch')
  })
})
