import { createProviderClient, resolveApiKey } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { createAuthProvider } from '../auth/registry.js'
import { PromptEngine } from '../prompt/engine.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'
import { detectModelFamily } from '../prompt/static.js'
import { createVolatileSnapshot } from '../prompt/volatile-snapshot.js'
import { resolvePromptBlocks, invalidatePromptBlocks } from '../prompt/block-policy.js'
import { FallbackStreamClient } from '../api/fallback-client.js'
import type { AgentConfig } from './loop-types.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../api/types.js'
import type { ProviderConfig, Config, ModelConfig } from '../config/schema.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import type { LlmSpeculationConfigInput } from './llm-speculation.js'
import type { AuthProvider } from '../auth/types.js'
import type { PermissionConfig } from './permissions.js'
import { getProviderProfile } from '../api/provider-profile.js'
import { resolveCompactionEconomics } from '../compact/compaction-profile.js'
import { gateToolDefinitions } from './tool-tiers.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { inferModelTierFromName, type ModelTier } from './model-tier-policy.js'

export interface ModelSpec {
  id: string
  maxTokens: number
  contextWindow: number
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  /** Model accepts image inputs (multimodal user messages). Gates the
   *  tool-boundary vision channel (computer_use screenshots). */
  supportsVision?: boolean
}

export interface AgentConfigInput {
  apiKey: string
  model: ModelSpec
  cwd: string
  compact: CompactionConfig
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  /** All configured providers — needed for resolving fallback chain. */
  allProviders?: Record<string, ProviderConfig>
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'
  songlineEnabled?: boolean
  hearthObserveEnabled?: boolean
  antiAnchoring?: AntiAnchoringConfig
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  llmSpeculation?: LlmSpeculationConfigInput
  autoDelegateEnabled?: boolean
  autoReasoning?: boolean
  crossSessionEnabled?: boolean
  /** Session Auto keyword routing; default true（auto 池内匹配，未命中回退天权）. */
  domainKeywordRouting?: boolean
  /** 默认星域（qiming | … | auto）。非 auto 时 bindSessionDomain 首次钉定，auto 时走关键词路由。 */
  defaultDomain?: string
  goalJudge?: { enabled?: boolean; maxRuns?: number; browser?: boolean }
  auth?: AuthProvider
  habituationThreshold?: number
  /** Optional permission config — allowlists, bash command prefixes, etc. */
  permissions?: PermissionConfig
  /** 主控工具门控。缺省 undefined → 全量（不门控）。 */
  toolGating?: {
    enabled: boolean
    coreOverride?: readonly string[]
    extraCore?: readonly string[]
    domainTier?: readonly string[]
    disabledTools?: readonly string[]
  }
  /** Optional vision bridge configuration (parsed from config.agent.visionModel). */
  visionModel?: {
    provider: string
    model: string
    prompt?: string
    maxTokens: number
    /** Optional backup vision model — failover when the primary errors. */
    fallback?: { provider: string; model: string }
  }
  /** /cd: previous PromptEngine whose frozen snapshots the new one inherits.
   *  resume 场景传盘存 FrozenSnapshotData（<id>.frozen.json），同语义。 */
  inheritFrozenFrom?: PromptEngine | FrozenSnapshotData
}

export interface MainAgentConfigInputParams {
  apiKey: string
  model: ModelSpec
  cwd: string
  config: Pick<Config, 'agent' | 'compact'>
  sessionId: string
  toolDefinitions: ToolDefinition[]
  provider: ProviderConfig
  allProviders?: Record<string, ProviderConfig>
  sessionMemoryBlock?: string
  auth?: AuthProvider
  habituationThreshold?: number
  permissions?: PermissionConfig
  /** /cd: previous PromptEngine whose frozen snapshots the new one inherits.
   *  resume 场景传盘存 FrozenSnapshotData（<id>.frozen.json），同语义。 */
  inheritFrozenFrom?: PromptEngine | FrozenSnapshotData
}

export function createMainAgentConfigInput(params: MainAgentConfigInputParams): AgentConfigInput {
  return {
    apiKey: params.apiKey,
    model: params.model,
    cwd: params.cwd,
    compact: params.config.compact,
    sessionId: params.sessionId,
    toolDefinitions: params.toolDefinitions,
    provider: params.provider,
    allProviders: params.allProviders,
    sessionMemoryBlock: params.sessionMemoryBlock,
    approvalMode: params.config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions',
    songlineEnabled: params.config.agent.songlineEnabled,
    hearthObserveEnabled: params.config.agent.hearthObserveEnabled,
    crossSessionEnabled: params.config.agent.crossSessionEnabled,
    antiAnchoring: params.config.agent.antiAnchoring,
    intentRetrievalRouter: params.config.agent.intentRetrievalRouter,
    llmSpeculation: params.config.agent.llmSpeculation,
    autoDelegateEnabled: params.config.agent.autoDelegateEnabled,
    autoReasoning: params.config.agent.autoReasoning,
    domainKeywordRouting: params.config.agent.domainKeywordRouting,
    defaultDomain: params.config.agent.defaultDomain,
    goalJudge: params.config.agent.goal?.judge,
    // 视觉桥接配置：这条线曾长期断裂（builder 从不透传 → buildVisionClient 恒返回
    // undefined → 桥接从不触发 → "配了却报图片未发送"）。visionModel 必须从 config
    // 流到 input，桥接才建得起来。见 buildVisionClient / loop.ts 桥接点。
    visionModel: params.config.agent.visionModel,
    auth: params.auth,
    habituationThreshold: params.habituationThreshold,
    permissions: params.config.agent.permissions as PermissionConfig,
    inheritFrozenFrom: params.inheritFrozenFrom,
    toolGating: params.config.agent.toolGating
      ? {
          enabled: params.config.agent.toolGating.enabled,
          coreOverride: params.config.agent.toolGating.coreTools,
          extraCore: params.config.agent.toolGating.extraCore,
          disabledTools: params.config.agent.toolGating.disabledTools,
        }
      : undefined,
 }
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'cwd' | 'blockPolicy' | 'providerProfile' | 'providerName' | 'compactionProfile' | 'primaryClient' | 'compactClient' | 'sessionId' | 'approvalMode' | 'autoReasoning' | 'reasoningFloor' | 'turnLevelThinking' | 'songlineEnabled' | 'hearthObserveEnabled' | 'crossSessionEnabled' | 'antiAnchoring' | 'intentRetrievalRouter' | 'llmSpeculation' | 'autoDelegateEnabled' | 'domainKeywordRouting' | 'defaultDomain' | 'goalJudge' | 'allProviders' | 'permissions' | 'toolGating' | 'prefixCacheStrategy' | 'supportsVision' | 'visionClient' | 'visionModelPrompt' | 'visionModelMaxTokens' | 'visionBridge'
> {
  const { model, apiKey, cwd, provider } = input
  const capabilities = resolveCapabilities(provider.name, provider.capabilities)
  const thinkingBudget = model.reasoningEffort === 'max'
    ? 64000
    : Math.min(16000, Math.floor(model.contextWindow * 0.02))

  const primaryClient = createProviderClient(provider, capabilities, {
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
    thinkingBudget,
    auth: input.auth,
    sessionId: input.sessionId,
  })

  const client = buildFallbackChain(primaryClient, provider, model, input)

  // Optional dedicated compaction client (compact.provider + compact.model).
  // Routes summarization to a cheap model on its own server-side cache so it
  // neither spends the main model's tokens nor evicts its hot prefix. Silent
  // fallback to primaryClient when unconfigured/invalid (mirrors review/council).
  const compactClient = buildCompactClient(input)

  // Optional vision bridge client (agent.visionModel.provider + model).
  // When the primary model is not multimodal, this client describes user images
  // so the primary model still receives their content as text.
  const visionBridge = buildVisionClient(input)

  const modelPricing = provider.models.find(m => m.id === model.id || m.alias === model.id)?.pricing

  // 复盘修复（2026-07-25）：每次创建 agent 前丢弃进程级 memo——长驻 sidecar
  // 同进程多会话时，改完配置开新会话必须吃到新档位（文档承诺）。活会话不受
  // 影响：解析结果快照进 AgentConfig.blockPolicy，loop 内消费点只读快照。
  invalidatePromptBlocks()
  const blockPolicy = resolvePromptBlocks(cwd)

  // 工具门控：构造期与 updateTools() 共用同一过滤（gateToolDefinitions），
  // 确保 MCP/LSP 异步注册后调用 updateTools 不会把 EXTENDED 工具整个还原。
  // 描述档位也走同一入口——两处不一致会让描述回弹、翻转前缀字节。
  const gatedTools = input.toolGating
    ? gateToolDefinitions(input.toolDefinitions, {
        enabled: input.toolGating.enabled,
        coreOverride: input.toolGating.coreOverride,
        extraCore: input.toolGating.extraCore,
        domainTier: input.toolGating.domainTier,
        disabledTools: input.toolGating.disabledTools,
        toolDescriptions: blockPolicy.toolDescriptions,
      })
    : applyDescriptionMode(input.toolDefinitions, blockPolicy.toolDescriptions)

  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { tools: gatedTools, modelFamily: detectModelFamily(model.id) },
    volatileCtx: createVolatileSnapshot({
      cwd,
      sessionMemoryBlock: input.sessionMemoryBlock,
      // 会话启动期解析一次并冻结——中途改配置不生效（改前缀 = 全量重建）。
      blockPolicy,
   }),
    habituationThreshold: input.habituationThreshold ?? 5,
    prefixCache: capabilities.prefixCacheStrategy,
    appendixDelta: process.env['RIVET_APPENDIX_DELTA'] !== '0',
    inheritFrozenFrom: input.inheritFrozenFrom,
 })

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    cwd: input.cwd,
    blockPolicy,
    providerProfile: getProviderProfile(provider.name, model.contextWindow),
    providerName: provider.name,
    // Model-aware compaction economics: billing from provider identity
    // (oauth/baseUrl hints for custom providers), cache kind from the provider
    // profile with the aggregator escape hatch (deepseek-native capability +
    // known model family), pricing from the model's config entry.
    compactionProfile: resolveCompactionEconomics({
      providerName: provider.name,
      modelId: model.id,
      contextWindow: model.contextWindow,
      ...(provider.auth?.type !== undefined ? { authType: provider.auth.type } : {}),
      baseUrl: provider.baseUrl,
      prefixCacheStrategy: capabilities.prefixCacheStrategy,
      ...(modelPricing ? { pricing: modelPricing } : {}),
    }),
    primaryClient: primaryClient,
    compactClient,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    songlineEnabled: input.songlineEnabled,
    hearthObserveEnabled: input.hearthObserveEnabled,
    crossSessionEnabled: input.crossSessionEnabled,
    antiAnchoring: input.antiAnchoring,
    intentRetrievalRouter: input.intentRetrievalRouter,
    llmSpeculation: input.llmSpeculation,
    autoDelegateEnabled: input.autoDelegateEnabled,
    domainKeywordRouting: input.domainKeywordRouting ?? true,
    defaultDomain: input.defaultDomain ?? 'qiming',
    goalJudge: input.goalJudge,
    allProviders: input.allProviders,
    autoReasoning: input.autoReasoning ?? true,
    reasoningFloor: model.reasoningEffort,
    // GLM turn-level thinking: disable thinking on tool execution turns
    // to prevent reasoning_content accumulation and context window stalls.
    turnLevelThinking: provider.name === 'glm',
    permissions: input.permissions,
    toolGating: input.toolGating,
    prefixCacheStrategy: capabilities.prefixCacheStrategy,
    // Per-model vision capability — switchModel rebuilds the agent, so this
    // value always tracks the active model (no live getter needed).
    supportsVision: model.supportsVision ?? false,
    visionClient: visionBridge?.client,
    visionModelPrompt: visionBridge?.prompt,
    visionModelMaxTokens: visionBridge?.maxTokens,
    visionBridge: deriveVisionBridgeStatus(model.supportsVision ?? false, visionBridge, input),
 }
}

/** 派生识图桥真实状态供 UI 显示——不再让 UI 只凭 config 有没有 visionModel 键去猜。 */
function deriveVisionBridgeStatus(
  primarySupportsVision: boolean,
  bridge: VisionBridgeBuild | undefined,
  input: AgentConfigInput,
): AgentConfig['visionBridge'] {
  if (primarySupportsVision) {
    return { active: true, source: 'none', detail: '主模型原生支持识图，无需桥接' }
  }
  if (bridge) {
    return {
      active: true,
      source: bridge.source,
      detail: bridge.source === 'auto' ? `自动选用 ${bridge.ref}` : bridge.ref,
    }
  }
  const detail = input.visionModel
    ? `已配置 ${input.visionModel.provider}/${input.visionModel.model} 但桥接起不来（缺 key/模型不存在）`
    : '未配置 agent.visionModel，且无可自动选用的视觉模型'
  return { active: false, source: 'none', detail }
}

export function resolveFallbackModel(fp: ProviderConfig): ModelConfig {
  const tierOf = (m: ModelConfig): ModelTier => {
    if (m.tier) return m.tier
    return inferModelTierFromName(m.id) ?? 'balanced'
  }

  const preferred = fp.fallbackModel
    ? fp.models.find(m => m.id === fp.fallbackModel || m.alias === fp.fallbackModel)
    : undefined

  const allowProFallback = fp.allowProFallback ?? false

  // 1. preferred is cheap → use it
  if (preferred && tierOf(preferred) === 'cheap') return preferred

  // 2. preferred is strong and pro fallback explicitly allowed → use it
  if (preferred && tierOf(preferred) === 'strong' && allowProFallback) return preferred

  // 3. preferred is strong but pro fallback forbidden → downgrade to cheap
  if (preferred && tierOf(preferred) === 'strong' && !allowProFallback) {
    const cheap = fp.models.find(m => tierOf(m) === 'cheap')
    if (cheap) {
      console.warn(`[fallback] ${preferred.id} is strong tier and allowProFallback=false; downgrading to ${cheap.id}`)
      return cheap
    }
  }

  // 4. no preferred or not allowed → prefer cheap, then balanced, then strong
  const candidates = [
    ...fp.models.filter(m => tierOf(m) === 'cheap'),
    ...fp.models.filter(m => tierOf(m) === 'balanced'),
    ...(!allowProFallback ? [] : fp.models.filter(m => tierOf(m) === 'strong')),
  ]
  if (candidates.length > 0) return candidates[0]!

  // 5. legacy fallback: if pro is forbidden and no cheap/balanced exists, still
  //    need a model to avoid breaking the chain — fall back to the first model.
  return fp.models[0]!
}

function buildFallbackChain(
  primary: import('../api/stream-client.js').StreamClient,
  provider: ProviderConfig,
  model: ModelSpec,
  input: AgentConfigInput,
): import('../api/stream-client.js').StreamClient {
  const fallbackNames = provider.fallback
  if (!fallbackNames?.length || !input.allProviders) return primary

  const entries = fallbackNames
    .filter(name => name !== provider.name && input.allProviders![name])
    .map(name => ({
      name,
      create: () => {
        const fp = input.allProviders![name]!
        const fCaps = resolveCapabilities(fp.name, fp.capabilities)
        // Resolve fallback API key — fail loudly instead of silently returning
        // primary so the user knows their fallback provider is misconfigured.
        let fApiKey: string
        try {
          fApiKey = resolveApiKey(fp)
        } catch {
          throw new Error(
            `Fallback provider "${name}" has no API key configured. ` +
            `Set ${fp.apiKeyEnv ?? `<PROVIDER>_API_KEY`} env var or inline apiKey in config.`
          )
        }
        // Resolve a fallback model that is safe by default: cheap tier only,
        // unless the user explicitly opts in via allowProFallback.
        const fModel = resolveFallbackModel(fp)
        return createProviderClient(fp, fCaps, {
          apiKey: fApiKey,
          model: fModel.id,
          maxTokens: fModel.maxTokens,
          reasoningEffort: model.reasoningEffort,
          sessionId: input.sessionId,
        })
      },
    }))

  if (entries.length === 0) return primary
  return new FallbackStreamClient(primary, provider.name, entries)
}

/**
 * Build the dedicated compaction StreamClient from compact.provider+model.
 * Returns undefined (→ caller falls back to primaryClient) when:
 *  - provider/model not both set
 *  - provider unknown, or model not in its model list
 *  - credentials missing (apiKey empty / oauth not authenticated)
 * This matches the silent-fallback contract of review/council routing: a
 * misconfigured compact route degrades to the primary model, never errors.
 */
function buildCompactClient(
  input: AgentConfigInput,
): import('../api/stream-client.js').StreamClient | undefined {
  const compactProvider = input.compact.provider
  const compactModel = input.compact.model
  if (!compactProvider || !compactModel) return undefined
  const prov = input.allProviders?.[compactProvider]
  if (!prov) return undefined
  const spec = prov.models.find(m => m.id === compactModel || m.alias === compactModel)
  if (!spec) return undefined

  let apiKey = ''
  let auth: AuthProvider | undefined
  try {
    if (prov.auth?.type === 'oauth') {
      auth = prov.name === input.provider.name ? input.auth : createAuthProvider(prov.auth, process.env)
      if (!auth?.isAuthenticated()) return undefined
    } else {
      apiKey = resolveApiKey(prov)
      if (!apiKey) return undefined
    }
  } catch {
    return undefined
  }

  const caps = resolveCapabilities(prov.name, prov.capabilities)
  // A dedicated compact client always runs the generous char budget (up to ~16K
  // chars at 1M). maxTokens only caps output (billed per generated token), so a
  // high ceiling is cost-neutral but prevents truncating a generous CJK summary
  // mid-sentence — 16K chars is ~10K tokens for Chinese, far above a 4K cap.
  const maxTokens = Math.min(16_384, spec.maxTokens)
  return createProviderClient(prov, caps, {
    apiKey,
    model: spec.id,
    reasoningEffort: spec.reasoningEffort,
    maxTokens,
    auth,
    sessionId: input.sessionId,
  })
}

/**
 * 已报过的桥失效原因——这个函数每次建 agent 都跑（每会话 + 每次 switchModel 重建），
 * 不去重会把同一条配置错误刷满日志。
 */
const warnedVisionBridge = new Set<string>()

/** 配了桥但用不上时点名原因。「没配」和「配了但起不来」表现完全相同（图照样被丢），
 *  沉默降级会让人以为配置生效了——这类不可见失败前面刚在截图路径上咬过一次。 */
function warnVisionBridge(key: string, reason: string): undefined {
  if (!warnedVisionBridge.has(key)) {
    warnedVisionBridge.add(key)
    console.warn(`[vision] 识图桥未启用：${reason}（图片仍会被丢弃）`)
  }
  return undefined
}

interface VisionBridgeBuild {
  client: import('../api/stream-client.js').StreamClient
  prompt?: string
  maxTokens: number
  /** configured=用户显式指定；auto=未配但自动选了个可用视觉模型。 */
  source: 'configured' | 'auto'
  /** 选中的 provider/model，供 UI 显示。 */
  ref: string
}

/**
 * Try to build a vision StreamClient from one (provider, modelSpec) pair.
 * Returns the client or an error reason string (never throws).
 */
function tryBuildVisionClientFrom(
  input: AgentConfigInput,
  prov: ProviderConfig,
  spec: ModelConfig,
  requestedMaxTokens: number,
): { client: import('../api/stream-client.js').StreamClient; maxTokens: number } | { error: string } {
  let apiKey = ''
  let auth: AuthProvider | undefined
  try {
    if (prov.auth?.type === 'oauth') {
      auth = prov.name === input.provider.name ? input.auth : createAuthProvider(prov.auth, process.env)
      if (!auth?.isAuthenticated()) return { error: `${prov.name} 未完成 OAuth 登录` }
    } else {
      apiKey = resolveApiKey(prov)
      if (!apiKey) return { error: `${prov.name} 的 API key 为空` }
    }
  } catch {
    // resolveApiKey 拿不到 key 就抛。最常见的成因不是"没有 key"而是"key 只存在环境变量里，
    // 而这个进程没继承到它"——GUI/Dock 启动的桌面端拿不到 shell profile 里的变量，
    // 且 config.env 那套解析只作用于命令执行，不改 process.env。
    return {
      error: `取不到 ${prov.name} 的 API key（${prov.apiKeyEnv ?? `${prov.name.toUpperCase()}_API_KEY`} 未传入本进程？`
        + '改用 Settings → Providers 把 key 存进配置，就不依赖启动方式了）',
    }
  }
  const caps = resolveCapabilities(prov.name, prov.capabilities)
  const maxTokens = Math.min(requestedMaxTokens, spec.maxTokens)
  const client = createProviderClient(prov, caps, {
    apiKey,
    model: spec.id,
    reasoningEffort: spec.reasoningEffort,
    maxTokens,
    auth,
    sessionId: input.sessionId,
  })
  return { client, maxTokens }
}

/**
 * Auto-select a default vision bridge when the user hasn't configured one but the
 * primary model is text-only. Picks the first vision-capable model that has usable
 * credentials, priority: same provider as the primary > minimax > glm > others.
 * Returns undefined when nothing is available (维持现状：图片会被丢弃 + warn 在别处补）。
 */
function autoSelectVisionBridge(input: AgentConfigInput): VisionBridgeBuild | undefined {
  const providers = input.allProviders
  if (!providers) return undefined
  const PRIORITY = [input.provider.name, 'minimax', 'glm']
  const rank = (name: string): number => {
    const i = PRIORITY.indexOf(name)
    return i === -1 ? PRIORITY.length + 1 : i
  }
  const candidates: Array<{ prov: ProviderConfig; spec: ModelConfig }> = []
  for (const prov of Object.values(providers)) {
    for (const spec of prov.models) {
      if (spec.supportsVision) candidates.push({ prov, spec })
    }
  }
  candidates.sort((a, b) => rank(a.prov.name) - rank(b.prov.name))
  for (const { prov, spec } of candidates) {
    const built = tryBuildVisionClientFrom(input, prov, spec, 1024)
    if ('client' in built) {
      const ref = `${prov.name}/${spec.id}`
      console.warn(`[vision] 自动启用识图桥：${ref}（未显式配置 agent.visionModel，已选一个可用视觉模型）`)
      return { client: built.client, prompt: undefined, maxTokens: built.maxTokens, source: 'auto', ref }
    }
    // 有 key 问题的候选跳过，继续找下一个——自动路径不刷 warn（显式路径才点名）。
  }
  return undefined
}

/**
 * Build the dedicated vision bridge StreamClient.
 * 1) 显式 agent.visionModel 优先——配了就用它，起不来则点名原因（不静默降级）。
 * 2) 未显式配置但主模型 text-only → 自动选一个可用视觉模型做默认桥（开箱即用）。
 * 返回 undefined 表示无桥可用（主模型照旧看不到图）。
 */
function buildVisionClient(input: AgentConfigInput): VisionBridgeBuild | undefined {
  const vm = input.visionModel
  if (!vm) {
    // 主模型自身支持视觉时无需桥；否则尝试自动选。
    return autoSelectVisionBridge(input)
  }
  const ref = `${vm.provider}/${vm.model}`
  const prov = input.allProviders?.[vm.provider]
  if (!prov) return warnVisionBridge(`prov:${ref}`, `provider "${vm.provider}" 不在已配置的 provider 列表里`)
  const spec = prov.models.find(m => m.id === vm.model || m.alias === vm.model)
  if (!spec) return warnVisionBridge(`model:${ref}`, `provider "${vm.provider}" 下没有模型 "${vm.model}"`)
  // 不拦：手改配置可以指一个非视觉模型，那时桥能连上但描述必然是瞎猜。
  if (!spec.supportsVision) {
    warnVisionBridge(`novision:${ref}`, `${ref} 未声明视觉能力，描述结果不可信——桌面端 Settings → Integrations 的下拉只列声明了视觉能力的模型`)
  }

  const built = tryBuildVisionClientFrom(input, prov, spec, vm.maxTokens)
  if ('error' in built) return warnVisionBridge(`key:${ref}`, built.error)

  // 主/备双桥：备桥可解析时，用 FallbackStreamClient 包一层——主视觉模型 5xx/超时
  // 自动切备。备桥起不来（缺 key/模型不存在）不致命，仅点名，降级为单桥。
  let client = built.client
  let refLabel = ref
  const fb = vm.fallback
  if (fb) {
    const fbRef = `${fb.provider}/${fb.model}`
    const fbProv = input.allProviders?.[fb.provider]
    const fbSpec = fbProv?.models.find(m => m.id === fb.model || m.alias === fb.model)
    if (!fbProv || !fbSpec) {
      warnVisionBridge(`fbmodel:${fbRef}`, `备用识图模型 ${fbRef} 不存在，降级为单桥`)
    } else {
      const fbBuilt = tryBuildVisionClientFrom(input, fbProv, fbSpec, vm.maxTokens)
      if ('error' in fbBuilt) {
        warnVisionBridge(`fbkey:${fbRef}`, `备用识图桥 ${fbRef} 起不来：${fbBuilt.error}，降级为单桥`)
      } else {
        client = new FallbackStreamClient(built.client, ref, [{ name: fbRef, create: () => fbBuilt.client }])
        refLabel = `${ref} → ${fbRef}`
      }
    }
  }
  return { client, prompt: vm.prompt, maxTokens: built.maxTokens, source: 'configured', ref: refLabel }
}
