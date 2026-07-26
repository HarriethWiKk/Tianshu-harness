import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { PressureResult } from '../context/pressure-monitor.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import { buildIntentPreview, type IntentPreview } from './intent-preview.js'

export interface IntentEvalInput {
  strategy: StrategyProfile
  vigor: VigorState
  sensorium: Sensorium
  pheromones: Pheromone[]
  pressureResult: PressureResult
  recentToolHistory: ToolHistoryEntry[]
  /**
   * Non-blocking sink for the direction note. Fired (not awaited) when the gate
   * trips; the agent always continues regardless. The user steers by typing.
   */
  onIntentNote?: (intent: IntentPreview) => void
  /** Task contract ID for structured dead-end matching (P2). */
  taskContractId?: string
}

const MAX_INTENT_NOTES = 3

/**
 * Surfaces a non-blocking "direction note" when the intent gate trips (high
 * commit threshold / linked dead-end / context thrashing). Previously this was
 * a blocking 3-way confirmation (continue/veto/alternative); it now never
 * pauses the turn — it just emits a passive note so the user can see the
 * agent's reasoning and steer if they want. Capped per turn-sequence to avoid
 * spamming the timeline.
 *
 * 去重纪律（2026-07-28）：同一组 warning 在相邻 turn 不重复渲染。
 * commitThreshold > 0.8 常由 verification debt / pressureRelative / momentum
 * 等环境信号驱动，连续多轮不变时反复弹「方向提示」是噪音，不是信号。
 */
export class TurnIntentController {
  private shown = 0
  private lastFingerprint: string | null = null

  evaluate(input: IntentEvalInput): void {
    if (!input.onIntentNote || this.shown >= MAX_INTENT_NOTES) return

    // vigor < 0.3 时已由 vigor-hook 自动适应（提高 reasoning effort、commit
    // threshold 等），无需再提示。
    if (input.vigor && input.vigor.vigor < 0.3) return

    const recentTargets = input.recentToolHistory
      .map(h => h.target)
      .filter((target): target is string => Boolean(target))
    const preview = buildIntentPreview({
      strategy: input.strategy,
      vigor: input.vigor,
      sensorium: input.sensorium,
      pheromones: input.pheromones,
      thrashingSuggestion: input.pressureResult.suggestion ?? null,
      recentTargets,
      taskContractId: input.taskContractId,
    })
    if (!preview) return

    // 与上轮相同 warning+summary 组去重——连续多轮不变不是新信号
    const fingerprint = `${preview.summary}|${(preview.warnings ?? []).sort().join('|')}`
    if (fingerprint === this.lastFingerprint) return

    this.lastFingerprint = fingerprint
    this.shown++
    input.onIntentNote(preview)
  }

  reset(): void {
    this.shown = 0
    this.lastFingerprint = null
  }

  getShownCount(): number {
    return this.shown
  }
}
