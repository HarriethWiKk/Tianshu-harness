/**
 * 证据摘要的 wire 侧类型——EvidenceSummary 随 SSE turn_complete / 交付事件
 * 流向桌面端（CompletionCurtain / event-reducer），经 src/server/ui-shared.ts
 * 共享。
 *
 * HARD CONSTRAINT: 叶子模块——只允许 `import type`（value import 会把内核
 * 运行时拖进前端 bundle）。运行时逻辑在 evidence.ts，那里 re-export 这些
 * 类型以保持内核调用方不变。
 */
import type { VerificationMetadata } from '../tools/types.js'

export type DeliveryVerificationStatus = 'verified' | 'failed' | 'blocked' | 'unverified'

export interface EvidenceSummary {
  filesRead: string[]
  filesModified: string[]
  verificationStatus: DeliveryVerificationStatus
  verifications: VerificationMetadata[]
  gate: {
    state: 'GREEN' | 'YELLOW' | 'RED' | 'ok' | 'warn' | 'error'
    label: string
    reason?: string
    blockingReason?: string
    nextAction?: string
  }
  impactedFiles: string[]
  impactedTests: string[]
}
