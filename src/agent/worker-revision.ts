/**
 * 证据不达标时的有界复核（Wave 8）。
 *
 * `verifyWorkerEvidence` 全程只降 `evidenceStatus` 加 risk，没有任何打回路径：
 * 写工撞闸门有一轮有界修复，只读工宣称「全绿」却没有验证痕迹时只是被静默降级，
 * 那份没有复现的宣称照样交给主控。对标 Claude Code 的 Performance Outcomes
 * （grader 在自己的上下文里判定，不合格就把 worker 打回去改），这里给只读工补上
 * 「打回」那条边。
 *
 * 边界：**复核只提升结果质量，不阻断交付**。上限一轮，复核后仍不达标就照常降级
 * 交回——门禁始终在主控收口，不在这里改判。
 */
import type { WorkerResult } from './work-order.js'
import type { WorkerTranscript } from './worker-session.js'
import { verifyWorkerEvidence } from './worker-evidence.js'

/** 一个 order 最多复核几轮。 */
export const MAX_EVIDENCE_REVISIONS = 1

/** 证据缺口的两种形状——都属于「宣称了但没复现」。 */
export type EvidenceShortfall = 'claimed_verified_downgraded' | 'unproven_claim_in_summary'

/**
 * 用真正的证据闸门跑一遍，看它会不会打回。判据不复刻闸门逻辑（那会两处漂移），
 * 而是比对闸门前后的差异：
 *
 * - `verified` 被降级 → 宣称的验证没有执行痕迹
 * - `evidenceStatus` 没变但闸门加了「未经复现」的 risk → summary 里有验证宣称
 *   （`CLAIM_RE` 那条分支）而 transcript 里找不到对应执行
 */
export function detectEvidenceShortfall(
  result: WorkerResult,
  profile?: string,
  transcript?: WorkerTranscript,
): EvidenceShortfall | undefined {
  // 没有 transcript 就没有取证依据，闸门那边也不会因此降级——不打回。
  if (!transcript) return undefined
  const gated = verifyWorkerEvidence(result, profile, transcript)
  if (result.evidenceStatus === 'verified' && gated.evidenceStatus !== 'verified') {
    return 'claimed_verified_downgraded'
  }
  const addedRisks = gated.risks.filter(r => !result.risks.includes(r))
  if (addedRisks.some(r => r.includes('宣称未经复现'))) return 'unproven_claim_in_summary'
  return undefined
}

export interface RevisionInput {
  result: WorkerResult
  shortfall: EvidenceShortfall | undefined
  /** 已经复核过几轮。 */
  attempt: number
  /** 父信号是否已断开。 */
  aborted: boolean
  /** 写工——它有写闸门的有界修复，不走这条路，否则同一份产出被打回两次。 */
  isWrite: boolean
  /** 上一轮是否交回了会话消息——复核靠它承接上下文。 */
  hasSessionMessages: boolean
}

export type RevisionDecision =
  | { readonly proceed: true; readonly shortfall: EvidenceShortfall }
  | { readonly proceed: false; readonly skipReason: string }

export function decideRevision(input: RevisionInput): RevisionDecision {
  if (!input.shortfall) return { proceed: false, skipReason: '证据闸门没有打回，无需复核' }
  if (input.aborted) return { proceed: false, skipReason: '调用方已中止——不再起复核轮' }
  if (input.isWrite) return { proceed: false, skipReason: '写工的打回走写闸门的有界修复，不在这里重复' }
  if (input.attempt >= MAX_EVIDENCE_REVISIONS) {
    return { proceed: false, skipReason: `已复核 ${input.attempt} 轮，达到上限——照常降级交回` }
  }
  if (!input.hasSessionMessages) {
    return { proceed: false, skipReason: '上一轮没有会话消息可承接，复核等于让它凭空重讲一遍' }
  }
  return { proceed: true, shortfall: input.shortfall }
}

/** 复核轮的 objective——二选一：要么复现，要么撤回。 */
export function buildRevisionObjective(
  originalObjective: string,
  shortfall: EvidenceShortfall,
  claimSummary: string,
): string {
  const diagnosis = shortfall === 'claimed_verified_downgraded'
    ? '你把 evidenceStatus 报成了 verified，但这一轮的工具调用里找不到任何真实的验证执行（run_tests 或验证形状的命令）。'
    : '你的 summary 里有验证结论（全绿 / 已修复 / N 过 N / typecheck 干净），但这一轮的工具调用里找不到对应的验证执行。'
  return [
    '你的报告没通过证据闸门，这一轮只做一件事：让宣称和证据对上。',
    diagnosis,
    '',
    '二选一，没有第三条路：',
    'A. 现在真的跑一遍验证（run_tests 或对应命令），把真实输出作为证据写进 verification 字段，宣称才算数。',
    'B. 撤回宣称——把 evidenceStatus 改成 unverified，把 summary 里没有复现的结论改写成「未验证」的表述。',
    '',
    '不要删掉上一轮已经查到的 findings，它们仍然有效；这一轮只修「宣称 vs 证据」这一处。',
    `上一轮的宣称：${claimSummary.slice(0, 300)}`,
    '',
    `原始目标：${originalObjective}`,
  ].join('\n')
}

/** 复核留痕——与续跑的 `budget-continuation` 分开，主控要能分清是哪一种再跑。 */
export function markRevised(result: WorkerResult, shortfall: EvidenceShortfall): WorkerResult {
  const cause = shortfall === 'claimed_verified_downgraded' ? '宣称 verified 但无执行痕迹' : 'summary 含验证宣称但无执行痕迹'
  const note = `evidence-revision: ${cause}，已打回复核一轮`
  return result.risks.includes(note) ? result : { ...result, risks: [...result.risks, note] }
}
