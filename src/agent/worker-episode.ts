import { createHash } from 'node:crypto'
import type { WorkOrder, WorkerResult } from './work-order.js'
import type { WorkerWriteGateReport } from './worker-write-gate.js'
import type { RoutingRewardInput } from './routing-reward.js'

/**
 * W4-D3: worker episode record — one row per delegated worker run, persisted
 * into the SAME append-only routing-metrics store (saveBanditState) used by
 * routing_shadow / team_wave / team_episode. No new isolated failure ledger.
 *
 * The reward derivation (D2) feeds the existing closure pipeline:
 * producer (write gate, hands-session) → episode → reward closure →
 * buildHistoricalModelRewards → future dispatch ranking (gated: shadow by
 * default, applied only when efeRouting.enabled). Rewards NEVER change the
 * current task's model — dispatch already happened when the episode is built.
 */
export interface WorkerEpisode {
  schemaVersion: 1
  orderId: string
  sessionId: string
  objectiveHash: string
  model: string
  profile?: string
  role: 'hands' | 'brain'
  scopeFileCount: number
  changedFileCount: number
  status: WorkerResult['status']
  evidenceStatus?: WorkerResult['evidenceStatus']
  /** Main-side write gate outcome; 'not-run' when the gate did not execute. */
  gateOutcome: WorkerWriteGateReport['outcome'] | 'not-run'
  /** Worker claimed passed but the main gate failed (heaviest penalty). */
  falseGreen: boolean
  /** Bounded repair rounds consumed (0 or 1). */
  repairCount: number
  timestamp: number
  /** 预算发准（2026-08-18）：实际用量四件套——同 objective 重派时的预算先验来源。 */
  actualToolUses?: number
  /** 墙钟（从 delegateOrder 入口到落定，含排队）——episode 落盘早于
   *  WorkerResult.durationMs 盖章，故在构建时自算而非读 result。 */
  durationMs?: number
  /** 预算耗尽（failureReason ∈ timeout/max_turns）——回馈估值的强信号。 */
  exhausted?: boolean
  failureReason?: string
  usage?: { input: number; output: number }
  /** 本次派发的预算回声（审计对账：预算 vs 实际）。 */
  budget?: { maxTurns: number; timeoutMs: number }
}

/** sha256(objective) 前 12 位——episode 主行与 worker_actual 索引行共用的
 *  目标指纹（预算回馈按它前缀查询）。 */
export function hashObjective(objective: string): string {
  return createHash('sha256').update(objective).digest('hex').slice(0, 12)
}

export function workerEpisodeKey(episode: Pick<WorkerEpisode, 'sessionId' | 'orderId' | 'timestamp'>): string {
  return `worker_episode:${episode.sessionId}:${episode.orderId.replace(/:/g, '-')}:${episode.timestamp}`
}

export interface BuildWorkerEpisodeInput {
  order: WorkOrder
  result: WorkerResult
  sessionId: string
  model: string
  role: 'hands' | 'brain'
  writeGate?: { report: WorkerWriteGateReport; repairCount: number }
  timestamp?: number
  /** 预算发准（2026-08-18）：实际用量四件套——缺席 = 旧调用方，字段不写。 */
  actuals?: {
    toolUses?: number
    durationMs?: number
    usage?: { input: number; output: number }
    budget?: { maxTurns: number; timeoutMs: number }
  }
}

export function buildWorkerEpisode(input: BuildWorkerEpisodeInput): WorkerEpisode {
  const { order, result, writeGate } = input
  const exhausted = result.failureReason === 'timeout' || result.failureReason === 'max_turns'
  return {
    schemaVersion: 1,
    orderId: order.id,
    sessionId: input.sessionId,
    objectiveHash: hashObjective(order.objective),
    model: input.model,
    ...(order.profile ? { profile: order.profile } : {}),
    role: input.role,
    scopeFileCount: order.scope.files?.length ?? 0,
    changedFileCount: result.changedFiles.length,
    status: result.status,
    ...(result.evidenceStatus ? { evidenceStatus: result.evidenceStatus } : {}),
    gateOutcome: writeGate?.report.outcome ?? 'not-run',
    falseGreen: writeGate?.report.falseGreen === true,
    repairCount: writeGate?.repairCount ?? 0,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.actuals?.toolUses !== undefined ? { actualToolUses: input.actuals.toolUses } : {}),
    ...(input.actuals?.durationMs !== undefined ? { durationMs: input.actuals.durationMs } : {}),
    ...(exhausted ? { exhausted: true } : {}),
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    ...(input.actuals?.usage && (input.actuals.usage.input > 0 || input.actuals.usage.output > 0)
      ? { usage: input.actuals.usage }
      : {}),
    ...(input.actuals?.budget ? { budget: input.actuals.budget } : {}),
  }
}

export interface WorkerEpisodeStore {
  saveBanditState(kind: string, json: string): void
}

export function persistWorkerEpisode(store: WorkerEpisodeStore | undefined | null, episode: WorkerEpisode): void {
  if (!store) return
  try {
    store.saveBanditState(workerEpisodeKey(episode), JSON.stringify(episode))
  } catch {
    // Episode telemetry must never affect delegation.
  }
}

/** 预算回馈的紧凑索引行（预算发准，2026-08-18）。
 *
 *  episode 主行的 key 是 sessionId:orderId:timestamp——按 objective 查历史需要
 *  全量扫描。本行把 objectiveHash 提进 key（`worker_actual:<hash>:<ts>`），前缀
 *  查询直达；只带预算估值需要的最小字段。episode 主行不动，reward_closure 等
 *  现有读者零影响。 */
export interface WorkerActualIndexRow {
  toolUses: number
  durationMs: number
  usage?: { input: number; output: number }
  budget?: { maxTurns: number; timeoutMs: number }
  exhausted: boolean
  status: WorkerResult['status']
}

export function workerActualKey(objectiveHash: string, timestamp: number): string {
  return `worker_actual:${objectiveHash}:${timestamp}`
}

export function persistWorkerActualIndex(
  store: WorkerEpisodeStore | undefined | null,
  objectiveHash: string,
  row: WorkerActualIndexRow,
): void {
  if (!store) return
  try {
    store.saveBanditState(workerActualKey(objectiveHash, Date.now()), JSON.stringify(row))
  } catch {
    // Best-effort: budget feedback must never affect delegation.
  }
}

/**
 * Reward derivation (shadow-first):
 * - gate passed              → verificationPass true
 * - gate failed              → verificationPass false (+falseGreen when claimed)
 * - gate blocked             → null: environment-neutral, NO reward row — the
 *                              plan forbids penalizing model capability for
 *                              env failures (tsc timeout, missing deps).
 * - gate skipped / not-run   → read-only or gate disabled: verification was
 *                              not observed; neutral undefined, reward still
 *                              recorded so completion/cost dimensions can be
 *                              extended later without a schema break.
 */
export function deriveWorkerEpisodeRewardInput(episode: WorkerEpisode): RoutingRewardInput | null {
  if (episode.gateOutcome === 'blocked') return null
  const base: RoutingRewardInput = { currentModel: episode.model }
  if (episode.gateOutcome === 'passed') return { ...base, verificationPass: true }
  if (episode.gateOutcome === 'failed') {
    return { ...base, verificationPass: false, ...(episode.falseGreen ? { falseGreen: true } : {}) }
  }
  return base
}
