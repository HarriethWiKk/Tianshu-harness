import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentConfig, createMainAgentConfigInput, type AgentConfigInput } from '../agent/create-agent-config.js'
import { normalizeIntentRetrievalRouterConfig } from '../agent/intent-retrieval-router.js'
import type { Config, ProviderConfig } from '../config/schema.js'

const testProvider: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  protocol: 'openai',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: true,
    prefixCache: 'deepseek-native',
    prefixCompletion: true,
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const testConfig = {
  agent: {
    approval: 'manual',
    maxTurns: 50,
    mode: 'code',
    autoReasoning: false,
    defaultDomain: 'auto',
    domainKeywordRouting: true,
    verificationSnapshot: 'auto',
    songlineEnabled: true,
    desktopTools: false,
    hearthObserveEnabled: false,
    crossSessionEnabled: true,
    antiAnchoring: { enabled: true, blindExploration: true, mctsPlanning: true, branches: 2, planningTurn: 1, projectionThreshold: 0.4, seedMaxTokens: 256, anchorBreakScout: { enabled: false, complexityThreshold: 0.5, minTurn: 3, scoutBudgetMs: 60_000, scoutMaxTokens: 2048 } },
    toolGating: { enabled: true, extraCore: [] },
    autoDelegateEnabled: false,
    maxDelegationDepth: 2,
    maxTeamParallel: 3,
    council: { seats: [] },
    checkpointEveryTurns: 25,
    intentRetrievalRouter: { enabled: true, classifier: 'heuristic', timeoutMs: 100, maxTokens: 128, temperature: 0 },
    llmSpeculation: { enabled: false, maxPerTurn: 3, maxTokens: 320, timeoutMs: 8_000, minProbability: 0.5, slowToolsOnly: true },
    teamSchedulerBanditEnabled: false,
    modelTierBanditEnabled: false,
    modelRoutingGatedEnabled: false,
    banditPromotion: { modelTier: 'shadow', teamScheduler: 'shadow', modelRouting: 'shadow', effort: 'shadow', killSwitch: false },
    permissions: { allow: [], deny: [], bash: { allowlist: [], denylist: [] }, additionalReadDirs: [], additionalWriteDirs: [] },
    review: { profiles: {}, skipAuto: false, mechanicalFastPath: true },
    goal: { judge: { enabled: true, maxRuns: 3, browser: false } },
    delivery: { autoCommit: true },
  },
  compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash', qualityCompact: { perTokenThreshold: 0.55, subscriptionThreshold: 0.45, subscriptionCeiling: 0.6 } },
} satisfies Pick<Config, 'agent' | 'compact'>

describe('createAgentConfig', () => {
  const baseInput: AgentConfigInput = {
    apiKey: 'test-key',
    model: { id: 'deepseek-r1', maxTokens: 8192, contextWindow: 128000, reasoningEffort: undefined },
    cwd: '/tmp/test',
    compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash', qualityCompact: { perTokenThreshold: 0.55, subscriptionThreshold: 0.45, subscriptionCeiling: 0.6 } },
    sessionId: 'session-1',
    toolDefinitions: [],
    provider: testProvider,
  }

  it('creates client with correct model params', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.client)
    assert.ok(cfg.promptEngine)
    assert.equal(cfg.contextWindow, 128000)
    assert.equal(cfg.sessionId, 'session-1')
    assert.equal(cfg.providerProfile?.cacheType, 'exact-prefix')
    assert.equal(cfg.providerProfile?.contextWindow, 128000)
  })

  it('resolves a model-aware compactionProfile (task 5 assembly wiring)', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.compactionProfile)
    assert.equal(cfg.compactionProfile.billing, 'per-token')
    assert.equal(cfg.compactionProfile.cache, 'exact-prefix')
    assert.equal(cfg.compactionProfile.contextWindow, 128000)

    const withPricing = createAgentConfig({
      ...baseInput,
      provider: {
        ...testProvider,
        models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192, pricing: { cacheRead: 0.028, cacheWrite: 0.28 } }],
      },
    })
    assert.equal(withPricing.compactionProfile?.cacheReadPricePerMillion, 0.028)
    assert.equal(withPricing.compactionProfile?.cacheWritePricePerMillion, 0.28)
  })

  it('returns primaryClient as the main model client', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.primaryClient)
    // primaryClient is the same StreamClient used for main model calls
  })

  it('applies thinkingBudget based on reasoningEffort', () => {
    const maxCfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'max' },
    })
    assert.ok(maxCfg.client)
    // Non-max uses Math.min(16000, floor(contextWindow * 0.02))
    const normalCfg = createAgentConfig(baseInput)
    assert.ok(normalCfg.client)
  })

  it('passes approvalMode through', () => {
    const cfg = createAgentConfig({ ...baseInput, approvalMode: 'dangerously-skip-permissions' })
    assert.equal(cfg.approvalMode, 'dangerously-skip-permissions')
  })

  it('defaults autoReasoning to true', () => {
    const cfg = createAgentConfig(baseInput)
    assert.equal(cfg.autoReasoning, true)
  })

  it('uses configured model reasoningEffort as the auto-reasoning floor', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'high' },
    })
    assert.equal(cfg.reasoningFloor, 'high')
  })

  it('passes songlineEnabled through when explicitly enabled', () => {
    const cfg = createAgentConfig({ ...baseInput, songlineEnabled: true })

    assert.equal(cfg.songlineEnabled, true)
  })

  it('builds main AgentConfig input from layered config including songlineEnabled', () => {
    const input = createMainAgentConfigInput({
      apiKey: 'test-key',
      model: baseInput.model,
      cwd: '/tmp/test',
      config: testConfig,
      sessionId: 'session-1',
      toolDefinitions: [],
      provider: testProvider,
      sessionMemoryBlock: 'memory block text',
    })

    assert.equal(input.compact, testConfig.compact)
    assert.equal(input.approvalMode, 'manual')
    assert.equal(input.songlineEnabled, true)
    assert.equal(input.antiAnchoring?.enabled, true)
    assert.equal(input.antiAnchoring?.branches, 2)
    const inputRouter = normalizeIntentRetrievalRouterConfig(input.intentRetrievalRouter)
    assert.equal(inputRouter.enabled, true)
    assert.equal(inputRouter.classifier, 'heuristic')

    const cfg = createAgentConfig(input)
    const cfgRouter = normalizeIntentRetrievalRouterConfig(cfg.intentRetrievalRouter)
    assert.equal(cfg.songlineEnabled, true)
    assert.equal(cfg.antiAnchoring?.enabled, true)
    assert.equal(cfgRouter.enabled, true)
  })

  it('passes sessionMemoryBlock to promptEngine', () => {
    const cfg = createAgentConfig({ ...baseInput, sessionMemoryBlock: 'memory block text' })
    assert.ok(cfg.promptEngine)
  })

  // 视觉桥接接线回归：createMainAgentConfigInput 曾长期漏传 config.agent.visionModel，
  // 导致 buildVisionClient 恒返回 undefined、桥接从不触发（"配了却报图片未发送"）。
  // 这两条测试钉住 config → input → visionClient 这条线。
  it('wires config.agent.visionModel through createMainAgentConfigInput', () => {
    const input = createMainAgentConfigInput({
      apiKey: 'test-key',
      model: baseInput.model,
      cwd: '/tmp/test',
      config: {
        ...testConfig,
        agent: { ...testConfig.agent, visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024 } },
      } as Pick<Config, 'agent' | 'compact'>,
      sessionId: 'session-1',
      toolDefinitions: [],
      provider: testProvider,
    })
    assert.deepEqual(input.visionModel, { provider: 'vprov', model: 'v-cap', maxTokens: 1024 })
  })

  it('builds a visionClient when a text-only primary has a configured vision bridge', () => {
    const visionProvider: ProviderConfig = {
      ...testProvider,
      name: 'vprov',
      apiKey: 'vision-key',
      models: [{ id: 'v-cap', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      // primary model is text-only (no supportsVision)
      allProviders: { deepseek: testProvider, vprov: visionProvider },
      visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024 },
    })
    assert.equal(cfg.supportsVision, false)
    assert.ok(cfg.visionClient, 'visionClient must be built from the configured bridge')
    assert.equal(cfg.visionModelMaxTokens, 1024)
    assert.equal(cfg.visionBridge?.source, 'configured')
    assert.equal(cfg.visionBridge?.active, true)
  })

  it('wraps primary+backup vision models when a fallback is configured', () => {
    const vprov: ProviderConfig = {
      ...testProvider, name: 'vprov', apiKey: 'k1',
      models: [{ id: 'v-cap', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const vprov2: ProviderConfig = {
      ...testProvider, name: 'vprov2', apiKey: 'k2',
      models: [{ id: 'v-cap2', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, vprov, vprov2 },
      visionModel: { provider: 'vprov', model: 'v-cap', maxTokens: 1024, fallback: { provider: 'vprov2', model: 'v-cap2' } },
    })
    assert.ok(cfg.visionClient, 'dual bridge still yields a client')
    assert.match(cfg.visionBridge?.detail ?? '', /vprov2\/v-cap2/, 'detail names the backup bridge')
  })

  it('auto-selects a vision bridge when text-only primary and none configured', () => {
    const vprov: ProviderConfig = {
      ...testProvider, name: 'minimax', apiKey: 'k',
      models: [{ id: 'MiniMax-M3', contextWindow: 128000, maxTokens: 8192, supportsVision: true }],
    }
    const cfg = createAgentConfig({
      ...baseInput,
      allProviders: { deepseek: testProvider, minimax: vprov },
      // no visionModel configured
    })
    assert.ok(cfg.visionClient, 'auto-selected bridge builds a client')
    assert.equal(cfg.visionBridge?.source, 'auto')
  })
})
