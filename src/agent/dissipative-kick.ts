import type { Sensorium } from './sensorium.js'

// ─── Types ──────────────────────────────────────────────────────────

/**
 * KickActions — a stagnation breakthrough instruction set.
 * Generated when the agent is stuck (momentum < 0.2 && stability < 0.3).
 *
 * Unlike strategy-shift (which suggests a different approach within the
 * same problem frame), the dissipative kick reframes the problem entirely.
 *
 * Actions are executed by the primary AgentLoop via existing mechanisms:
 * - deadEndPaths → StigmergyStore.deposit('dead-end')
 * - switchToExploration → increases explorationBreadth
 * - shouldEscalate → triggers tianshu-encore phase
 * - injectedMessage → injected as user guidance
 */
export interface KickActions {
  /** File paths to mark as dead-end pheromone signals */
  deadEndPaths: string[]
  /** Hint: switch to tonic exploration mode (wide search) */
  switchToExploration: boolean
  /** Hint: escalate to stronger model for re-planning */
  shouldEscalate: boolean
  /** Suggested alternative problem framings */
  alternativeFrameworks: string[]
  /** Message to inject into the conversation for the LLM */
  injectedMessage: string
}

// ─── Trigger ────────────────────────────────────────────────────────

/**
 * Determine if a dissipative kick should be triggered.
 *
 * Conditions: momentum < 0.2 AND stability < 0.3
 * → agent is making repeated mistakes + strategy isn't adapting
 *
 * This is the V4-level reframe. V2-level is strategy-shift (same frame).
 */
export function shouldKick(s: Sensorium): boolean {
  // `stability < 0.3` 在 doom='none' 下数学不可达：computeStability 里 doomBase 占
  // 0.40 权重，doom='none' 时该项单独就是 0.40×0.90=0.36。所以这条合取实际等价于
  // 「momentum 低 **且** doom 已经 warn/blocked，且预测率与工具多样性同时贴地」——
  // 它是 doom loop 的二次确认，不是独立的稳定性信号（901 帧实测 stability 最低
  // 0.48，发火率 0.0%）。
  //
  // 想改成直读 doom 档位，代价还不止阈值：`Sensorium` 快照并不携带 doomLevel
  // （它只在 `SensoriumInput` 上），得先把信号接进来。且要先知道 doom 各档的实际
  // 占比，而遥测帧至今不带该字段（已在 vitals-lite 补上）。在拿到分布前不动阈值
  // ——把死分支直接拍成高频分支是 v3 压力过冲的同一种错误。
  return s.momentum < 0.2 && s.stability < 0.3
}

// ─── Action Builder ─────────────────────────────────────────────────

/**
 * Build kick actions based on the current sensorium state.
 *
 * Pure function — deterministic, no side effects.
 * The caller (AgentLoop) is responsible for executing the actions.
 *
 * @param s - Current Sensorium snapshot
 * @param _cwd - Working directory (reserved for future import-graph use)
 * @param recentlyFailedFiles - File paths that have failed recently
 * @param ctxRatio - Real context window fill ratio (estimatedTokens / window).
 *                   `s.pressure` is a composite that includes CVM overhead —
 *                   using it to claim "context is almost full" manufactured
 *                   anxiety at 10% actual fill (session 20b9714e). Only the
 *                   real ratio may make context claims.
 */
export function buildKickActions(
  s: Sensorium,
  _cwd: string,
  recentlyFailedFiles: string[] = [],
  ctxRatio?: number,
): KickActions {
  const deadEndPaths = recentlyFailedFiles.length > 0
    ? recentlyFailedFiles
    : []

  const parts: string[] = [
    '**天璇-感知：当前策略进入低效状态。停下来，换个角度看。**',
  ]

  if (s.confidence < 0.3) {
    parts.push('- 测试验证率低，建议先写最小测试验证当前改动是否正确')
  }

  if (s.complexity > 0.5) {
    parts.push('- 涉及多文件改动，建议拆分任务：先完成一个子目标并验证，再进行下一步')
  }

  // 焦虑供给源修正（2026-07-11）：pressure 是含 CVM 开销的复合值，不能
  // 翻译成"上下文快满了"。只有实测 ctxRatio ≥ 0.7 才提上下文；否则如实
  // 说复合压力来源（资源/开销），不制造不存在的窗口焦虑。
  if (s.pressure > 0.7) {
    if (ctxRatio !== undefined && ctxRatio >= 0.8) {
      parts.push(`- 上下文使用率 ${Math.round(ctxRatio * 100)}%，接近窗口上限——立即主动 compact 或提交当前工作，不要等系统触发`)
    } else if (ctxRatio !== undefined && ctxRatio >= 0.7) {
      parts.push(`- 上下文使用率 ${Math.round(ctxRatio * 100)}%，建议提交当前完成的部分，用 checkpoint 收束`)
    } else {
      parts.push('- 系统复合压力偏高（资源/开销复合值，非窗口余量告急）——收敛当前子目标，避免同时展开多线')
    }
  }

  parts.push('- 重新阅读用户原始请求，确认当前方向是否偏离')
  parts.push('- 天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall')

  return {
    deadEndPaths,
    switchToExploration: true,
    shouldEscalate: s.confidence < 0.2 && s.complexity > 0.5,
    alternativeFrameworks: [
      're-read original request',
      'simplest viable approach',
      'decompose into sub-tasks',
    ],
    injectedMessage: parts.join('\n'),
  }
}

// ─── Escalation From Kick ───────────────────────────────────────────

/**
 * Determine if a kick should trigger model escalation (tianshu-encore).
 *
 * More conservative than normal escalation (confidence < 0.3 && momentum < 0.2).
 * Kick escalation requires confidence < 0.2 AND complexity > 0.5 —
 * i.e., it's not just failing, it's failing at a complex multi-file task.
 */
export function shouldEscalateFromKick(s: Sensorium): boolean {
  return s.confidence < 0.2 && s.complexity > 0.5
}
