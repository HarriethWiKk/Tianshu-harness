import type { CompactTier } from './types.js'
import { tierForRatio } from './compact-policy.js'

export interface PressureResult {
  tier: CompactTier
  shouldCompact: boolean
  thrashing: boolean
  fastGrowth: boolean
  suggestion?: 'task_decomposition'
  ratio: number
  growthRate: number
  /** CVM overhead: fraction of context consumed by CVM injections (0–1) */
  cvmOverheadRatio: number
  /** Should CVM throttle its injections to reduce overhead? */
  shouldThrottleCvm: boolean
  /** 相对压力 — 当前 ratio 超出近期基线（历史 p90）的幅度，log2 压缩到 0-1：
   *  持平基线为 0，涨到基线 2 倍为 1.0。tokenHistory < 5 条时为 undefined。
   *  与绝对占用互补，不可单独替代它——消费侧取两者较大。 */
  pressureRelative?: number
}

/** Minimum ratio delta between consecutive checks to flag fast growth. */
const FAST_GROWTH_THRESHOLD = 0.15

/** CVM overhead threshold: throttle when CVM injections exceed 5% of context. */
const CVM_OVERHEAD_THRESHOLD = 0.05
/** CVM overhead ceiling: hard stop at 8% — skip all non-essential injections. */
const CVM_OVERHEAD_CEILING = 0.08

/** 90th percentile of a non-empty number array. */
function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.9)
  return sorted[Math.min(idx, sorted.length - 1)]!
}

/**
 * W2-B1: egress metering source tags. Every injected request byte is charged
 * at exactly ONE egress (no double counting):
 *   - projection / ephemeral / tool-context / advisory-appendix /
 *     control-appendix — dynamic appendix blocks. Booked by PromptEngine at
 *     the point the bytes are written into a <context-update>, so a block only
 *     costs when it actually ships: unchanged blocks, tool turns reusing the
 *     cached appendix, and Top-K evictions are all free.
 *   - system-reminder — bus-drained SR appended to the session tail (K1
 *     append-only: charged once per append)
 *   - runtime-payload — runtime hook injectUserMessage payloads (K1
 *     append-only: charged once per append)
 */
export type CvmInjectionSource =
  | 'projection'
  | 'ephemeral'
  | 'tool-context'
  | 'advisory-appendix'
  | 'system-reminder'
  | 'runtime-payload'
  | 'control-appendix'

export class PressureMonitor {
  private compactionTurns: number[] = []
  private tokenHistory: Array<{ turn: number; tokens: number }> = []
  /** Accumulated CVM-injected token estimate across this session. */
  private cvmTokenAccumulator = 0
  /** W2-B1: per-source breakdown — values are CUMULATIVE session tokens.
   *  Invariant: sum over sources === cvmTokenAccumulator. */
  private cvmBySource = new Map<CvmInjectionSource, number>()

  constructor(private contextWindow: number) {}

  check(estimatedTokens: number, currentTurn: number): PressureResult {
    const ratio = this.contextWindow > 0 ? estimatedTokens / this.contextWindow : 1
    const tier = tierForRatio(ratio)
    const thrashing = this.detectThrashing(currentTurn)

    // ── Growth rate: ratio delta since last check ──
    const prevRatio = this.tokenHistory.length > 0
      ? (this.tokenHistory[this.tokenHistory.length - 1]!.tokens / this.contextWindow)
      : ratio
    const growthRate = ratio - prevRatio
    const fastGrowth = growthRate >= FAST_GROWTH_THRESHOLD

    // ── Relative pressure: 当前 ratio 超出近期基线的幅度 ──
    // 绝对阈值 0.5 在 ctxRatio 均值 ~10% 时永远不触发，所以这一维衡量「相对
    // 自己最近的水位涨了多少」，与绝对占用互补（消费侧取两者较大，见
    // sensorium.ts::computePressure）。
    //
    // 不能直接用 min(1, ratio / p90)：上下文单调增长时当前 ratio 几乎必然是
    // 尾部 20 轮的最大值、p90 约等于次大值，比值恒 ≥1 而被钉死在 1.0。该写法
    // 上线后实测 901 轮里 662 轮（73.5%）pressure 恰为 0.50，这一维不再携带
    // 信息（见 docs/analysis/2026-07-28-第二轮指标监测.md）。
    //
    // 改为对「超出倍数」取 log2：持平基线记 0，涨到基线的 2 倍记 1.0。平缓
    // 增长每轮只超出百分之几，落在 0.0x 量级；真实突增仍能报满。
    const historyRatios = this.tokenHistory.map(h => h.tokens / this.contextWindow)
    const pressureRelative = historyRatios.length >= 5
      ? Math.max(0, Math.min(1, Math.log2(Math.max(ratio / Math.max(p90(historyRatios), 0.01), 1))))
      : undefined

    // Record for next comparison
    this.tokenHistory = [...this.tokenHistory, { turn: currentTurn, tokens: estimatedTokens }].slice(-20)

    // ── CVM overhead ──
    const cvmOverheadRatio = this.contextWindow > 0
      ? this.cvmTokenAccumulator / this.contextWindow
      : 0

    const shouldCompact = tier > 0

    return {
      tier,
      shouldCompact,
      thrashing,
      fastGrowth,
      suggestion: thrashing && shouldCompact ? 'task_decomposition' : undefined,
      ratio,
      growthRate,
      cvmOverheadRatio,
      shouldThrottleCvm: cvmOverheadRatio >= CVM_OVERHEAD_THRESHOLD,
      pressureRelative,
    }
  }

  /**
   * Record CVM-injected tokens for overhead tracking.
   *
   * 计费口径 = 真实上线字节。appendix 类注入由 PromptEngine 在写进
   * <context-update> 的那一刻记账（drainAppendixLedger），调用方只负责转交；
   * SR / runtime-payload 类在各自的 append 点记一次。
   *
   * 累加器语义是「当前历史里驻留的 CVM 字节」，由 resetAppendixBaseline 的
   * 回调在历史重写时归零——不要在别处再加独立的复位调用，两套复位会漂移。
   * 比例越过阈值后，下一次 check() 置 shouldThrottleCvm。
   */
  recordCvmInjection(estimatedTokens: number, source: CvmInjectionSource = 'projection'): void {
    this.cvmTokenAccumulator += estimatedTokens
    this.cvmBySource.set(source, (this.cvmBySource.get(source) ?? 0) + estimatedTokens)
  }

  /** W2-B1: cumulative per-source injection tokens (telemetry breakdown). */
  getCvmInjectionBySource(): Readonly<Partial<Record<CvmInjectionSource, number>>> {
    return Object.fromEntries(this.cvmBySource)
  }

  /** Reset CVM overhead counter (e.g., after checkpoint-resume). */
  resetCvmOverhead(): void {
    this.cvmTokenAccumulator = 0
    this.cvmBySource.clear()
  }

  getCvmOverheadRatio(): number {
    return this.contextWindow > 0
      ? this.cvmTokenAccumulator / this.contextWindow
      : 0
  }

  isCvmThrottling(): boolean {
    return this.getCvmOverheadRatio() >= CVM_OVERHEAD_THRESHOLD
  }

  isCvmThrottlingCeiling(): boolean {
    return this.getCvmOverheadRatio() >= CVM_OVERHEAD_CEILING
  }

  recordCompaction(turn: number): void {
    this.compactionTurns = [...this.compactionTurns, turn].slice(-10)
  }

  getCompactionTurns(): number[] {
    return [...this.compactionTurns]
  }

  private detectThrashing(currentTurn: number): boolean {
    return this.compactionTurns.filter(turn => currentTurn - turn <= 4).length >= 3
  }
}
