/**
 * RED: AgentConfig lacks defaultDomain field, so bindSessionDomain cannot
 * pin to user-configured domain. Falls to keyword routing / DEFAULT_DOMAIN.
 *
 * Expected: defaultDomain='yaoguang' -> sessionDomain pinned to yaoguang
 * Actual: sessionDomain falls to keyword routing result (kaiyang or tianquan)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'

describe('RED: defaultDomain pinning', () => {
  it('bindSessionDomain without defaultDomain falls to keyword routing', async () => {
    const session = new SessionContext()
    const engine = new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: process.cwd() },
    })

    const client = {
      stream: async (_req: any, cb: any, _sig?: AbortSignal) => {
        cb.onTextDelta?.('test')
        cb.onContentBlock?.({ type: 'text', text: 'test' })
        cb.onStopReason?.('end_turn', { input_tokens: 10, output_tokens: 5 })
      },
    } as any

    // AgentConfig has no defaultDomain field -> must use 'as any' to bypass TS
    const agent = new AgentLoop({
      client,
      promptEngine: engine as any,
      toolRegistry: { getDefinitions: () => [] } as any,
      contextWindow: 1_000_000,
      maxTurns: 1,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' as const },
      domainKeywordRouting: true,
      defaultDomain: 'yaoguang',  // configure yaoguang
    } as any, session, process.cwd())

    ;(agent as any).bindSessionDomain?.('testing generic message')

    const domain = agent.getSessionDomain()
    console.log('Domain after bindSessionDomain:', domain?.id, domain?.name)
    // GREEN: defaultDomain='yaoguang' now pinned by bindSessionDomain
    assert.equal(domain?.id, 'yaoguang',
      'GREEN: defaultDomain=yaoguang should pin sessionDomain to yaoguang via bindSessionDomain')
  })
})
