import type { ApprovalResult } from '../../agent/approval-edit.js'
import type { RiskExplanation } from '../../agent/risk-explain.js'

export interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (result: ApprovalResult | boolean) => void
  /** 审批等待起点（Date.now()）。spinner 据此显示「等待审批 Ns」而非冒充思考。 */
  startMs: number
}

/**
 * Approval state manager — holds the approval state fields extracted from
 * TuiApp (W-B4). Key handling, rendering, and resolution logic stay in TuiApp;
 * this class only manages the pending state objects. (Intent is now a
 * non-blocking timeline note with no pending state.)
 */
export class ApprovalIntentController {
  approvalPending: PendingApproval | null = null
  approvalEditMode = false
  approvalEditError = ''
  /** 审批选项列表的光标行（0 批准 / 1 拒绝 / 2 编辑 JSON / 3 解释风险）。 */
  approvalOptionIndex = 0

  /** 风险解释（Ctrl+E 按需拉取，绝不预生成）。三态：未请求 / 在途 / 有结果。 */
  riskExplanation: RiskExplanation | null = null
  riskExplainPending = false
  riskExplainError = ''

  /** 换一个待批项时清空解释——上一条命令的风险结论套在新命令上是危险的误导。 */
  resetRiskExplanation(): void {
    this.riskExplanation = null
    this.riskExplainPending = false
    this.riskExplainError = ''
    this.approvalOptionIndex = 0
  }
}
