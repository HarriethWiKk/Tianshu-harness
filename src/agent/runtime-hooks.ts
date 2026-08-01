import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { CognitiveSeason } from './cognitive-season.js'
import type { FailureClass } from './failure-classifier.js'
import type { Sensorium, SensoriumInput, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import type { DecisionShift } from './loop-types.js'

export type RuntimeHookPhase = 'preTurn' | 'afterPerception' | 'postTool' | 'postTurn' | 'postSession'

export interface RuntimeToolEvent {
  name: string
  success: boolean
  target?: string
  /** Original structured ToolUse input. Hooks that need file semantics must
   *  prefer this over target because target is a display/history fallback. */
  input?: Record<string, unknown>
  isError?: boolean
  /** Failure classification from failure-classifier.ts — enables vigor to distinguish
   *  semantic failures (type_error, assertion) from environment issues (timeout, api_error). */
  failureClass?: FailureClass
  /** Tool result content string — enables hooks to inspect output for lossy markers
   *  and other content-level signals without duplicating tool-pipeline logic. */
  resultContent?: string
  /** Mode-level approximation: true when approvalMode requires interactive
   *  approval for writes (i.e. not dangerously-skip-permissions). This is NOT
   *  a per-call audit — allowlist auto-approves and "always allow" also count
   *  as true. Used by virtue detection (礼) as a v1 heuristic. */
  approvalRequired?: boolean
}

export interface RuntimeHookSnapshot {
  cwd: string
  turn: number
  recentToolHistory: Array<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'argsHash' | 'errorClass'>>
  sensorium: Sensorium | null
  sensoriumInput?: SensoriumInput
  providerDegradationRatio?: number
  strategy: StrategyProfile | null
  vigor: VigorState | null
  gitChangeRate: number
  season: CognitiveSeason | null
  /** Theta telemetry for elm-micro-release timeout suppression. */
  thetaTelemetry?: {
    lastTimedOut: boolean
    consecutiveTimeouts: number
  }
  /** Component C (typecheck-reminder): a .ts/.tsx file was written this session.
   *  Task-level, not windowed — survives a long turn where the edit scrolled out
   *  of recentToolHistory. */
  touchedTsFiles?: boolean
  /** Component C: a real typecheck has run since the last TS edit. */
  sawTypecheckThisTask?: boolean
  /** W5 (render-verify): a UI file (.tsx/.jsx/.vue/.svelte/.css/.html) was
   *  written this session. Task-level, like touchedTsFiles. */
  touchedUiFiles?: boolean
  /** W5 (render-verify): a visual verification tool (browser / computer_use /
   *  browser_debug) was used this session. */
  sawVisualVerify?: boolean
  /** Reasoning spiral guard: length of last turn's thinking content.
   *  Populated from AgentLoop.lastThinkingContent.length in buildRuntimeSnapshot. */
  lastThinkingLength?: number
  /** Reasoning spiral guard: whether last turn had any tool calls.
   *  Derived from recentToolHistory in buildRuntimeSnapshot. */
  lastTurnHadTools?: boolean
}

export interface RuntimePhaseChangeDetail {
  tool?: string
  reason?: string
  suggestion?: string
}

export interface RuntimeHookEffects {
  setSensorium(sensorium: Sensorium): void
  setStrategy(strategy: StrategyProfile): void
  setVigor(vigor: VigorState): void
  setGitChangeRate(rate: number): void
  injectUserMessage(message: string): void
  requestThetaCheck(reason: string): void
  emitPhaseChange(phase: string, detail?: RuntimePhaseChangeDetail): void
  /** R4 — surface a structured course-correction to the desktop conversation. */
  emitDecisionShift(shift: DecisionShift): void
  markClaimStale(claimId: string): void
  /** 控制面事实上报（Wave 2）：hook 报告结构化事实，由控制面统一路由
   *  silent/status/appendix/decision-gate。默认 no-op；shadow 模式只记账不改
   *  prompt。任务数据（MCTS seed / scout packet）不得走此通道。
   *  Optional（兼容既有手工构造的 effects 字面量）；createRuntimeHookContext
   *  恒填充，hook 侧可直接调用。 */
  emitControlSignal?(signal: import('./control-plane.js').ControlSignal): void
}

export interface RuntimeHookContext {
  snapshot: RuntimeHookSnapshot
  effects: RuntimeHookEffects
}

export interface PreTurnRuntimeHook {
  phase: 'preTurn'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface AfterPerceptionRuntimeHook {
  phase: 'afterPerception'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface PostToolRuntimeHook {
  phase: 'postTool'
  name: string
  run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> | void
}

export interface PostTurnRuntimeHook {
  phase: 'postTurn'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface PostSessionRuntimeHook {
  phase: 'postSession'
  name: string
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export type RuntimeHook =
  | PreTurnRuntimeHook
  | AfterPerceptionRuntimeHook
  | PostToolRuntimeHook
  | PostTurnRuntimeHook
  | PostSessionRuntimeHook

export interface RuntimeHookError {
  phase: RuntimeHookPhase
  hookName: string
  message: string
  error: unknown
}

export interface RuntimeHookPipelineOptions {
  onError?: (error: RuntimeHookError) => void
  /** 单 hook 异步执行超时（默认 10s）——pending promise 永不 resolve 时降级
   *  跳过并报 onError，后续 hook 照常执行；卡死的 promise 遗留后台（泄漏有界）。
   *  注意：同步 CPU 死循环无法被 in-process 抢占（同线程），此类缺陷只能
   *  靠 worker 隔离根治；本护栏守住「异步挂起」与「慢 hook 可观测」两条线。
   *  （2026-08-01 事故：postTool hook 正则死循环拖死整个 agent loop。） */
  hookTimeoutMs?: number
  /** 慢 hook 遥测阈值（默认 2s）——同步执行超过即报 onError（事后检测，
   *  不能抢占，但让慢 hook 可见）。 */
  hookSlowMs?: number
}

const DEFAULT_HOOK_TIMEOUT_MS = 10_000
const DEFAULT_HOOK_SLOW_MS = 2_000

function noop(): void {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRuntimeHookContext(
  snapshot: RuntimeHookSnapshot,
  effects: Partial<RuntimeHookEffects> = {},
): RuntimeHookContext {
  return {
    snapshot,
    effects: {
      setSensorium: sensorium => {
        snapshot.sensorium = sensorium
        effects.setSensorium?.(sensorium)
      },
      setStrategy: strategy => {
        snapshot.strategy = strategy
        effects.setStrategy?.(strategy)
      },
      setVigor: vigor => {
        snapshot.vigor = vigor
        effects.setVigor?.(vigor)
      },
      setGitChangeRate: rate => {
        snapshot.gitChangeRate = rate
        effects.setGitChangeRate?.(rate)
      },
      injectUserMessage: effects.injectUserMessage ?? noop,
      requestThetaCheck: effects.requestThetaCheck ?? noop,
      emitPhaseChange: effects.emitPhaseChange ?? noop,
      emitDecisionShift: effects.emitDecisionShift ?? noop,
      markClaimStale: effects.markClaimStale ?? noop,
      emitControlSignal: effects.emitControlSignal ?? noop,
    },
  }
}

export class RuntimeHookPipeline {
  private preTurnHooks: PreTurnRuntimeHook[] = []
  private afterPerceptionHooks: AfterPerceptionRuntimeHook[] = []
  private postToolHooks: PostToolRuntimeHook[] = []
  private postTurnHooks: PostTurnRuntimeHook[] = []
  private postSessionHooks: PostSessionRuntimeHook[] = []

  constructor(
    hooks: RuntimeHook[] = [],
    private options: RuntimeHookPipelineOptions = {},
  ) {
    for (const hook of hooks) this.register(hook)
  }

  register(hook: RuntimeHook): void {
    switch (hook.phase) {
      case 'preTurn':
        this.preTurnHooks.push(hook)
        break
      case 'afterPerception':
        this.afterPerceptionHooks.push(hook)
        break
      case 'postTool':
        this.postToolHooks.push(hook)
        break
      case 'postTurn':
        this.postTurnHooks.push(hook)
        break
      case 'postSession':
        this.postSessionHooks.push(hook)
        break
    }
  }

  async runPreTurn(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('preTurn', this.preTurnHooks, hook => hook.run(ctx))
  }

  async runAfterPerception(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('afterPerception', this.afterPerceptionHooks, hook => hook.run(ctx))
  }

  async runPostTool(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> {
    await this.runPhase('postTool', this.postToolHooks, hook => hook.run(ctx, tool))
  }

  async runPostTurn(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('postTurn', this.postTurnHooks, hook => hook.run(ctx))
  }

  async runPostSession(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('postSession', this.postSessionHooks, hook => hook.run(ctx))
  }

  private async runPhase<T extends RuntimeHook>(
    phase: RuntimeHookPhase,
    hooks: T[],
    invoke: (hook: T) => Promise<void> | void,
  ): Promise<void> {
    const timeoutMs = this.options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
    const slowMs = this.options.hookSlowMs ?? DEFAULT_HOOK_SLOW_MS
    for (const hook of hooks) {
      const start = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const result = invoke(hook)
        if (result instanceof Promise) {
          await Promise.race([
            result,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true
                reject(new Error(`[hook-timeout] "${hook.name}" exceeded ${timeoutMs}ms in phase ${phase} — skipped`))
              }, timeoutMs)
            }),
          ])
        }
      } catch (error) {
        this.options.onError?.({
          phase,
          hookName: hook.name,
          message: toMessage(error),
          error,
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        const elapsed = Date.now() - start
        // 超时已通过 [hook-timeout] 上报——同一次超时事件不再重复报 [hook-slow]
        // （生产默认 timeoutMs=10s > slowMs=2s，超时后 elapsed 必 ≥ slowMs，
        //  不跳过会把用户 onError 钩子对同一事件触发两次）。
        if (!timedOut && elapsed >= slowMs) {
          this.options.onError?.({
            phase,
            hookName: hook.name,
            message: `[hook-slow] "${hook.name}" took ${elapsed}ms in phase ${phase}`,
            error: undefined,
          })
        }
      }
    }
  }
}
