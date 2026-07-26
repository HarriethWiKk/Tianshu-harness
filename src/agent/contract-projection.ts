/**
 * contract-projection.ts — 从 WorkOrder 白名单构造用户可见的「契约投影」。
 *
 * 设计约束（来自子代理可观测性设计 doc）：
 * - 只暴露 objective/scope/constraints/profile/authority/budget/allowedTools
 * - 绝不泄露星域 volatileBlock、将星账本、claims、域课、stigmergy 等内部认知层
 * - model 字段由调用方在 dispatch 后填入（WorkOrder.modelOverride 只是候选）
 * - allowedToolsDigest 取前 3 个工具名 + "+N" 计数器
 */

import type { WorkOrder } from './work-order.js'

export interface ContractProjection {
  objective: string
  profile: string
  authority?: string
  authorityReason?: string
  scope: {
    files?: string[]
    symbols?: string[]
    maxFiles?: number
  }
  constraints: string[]
  budget: {
    maxTurns: number
    timeoutMs: number
  }
  /** 运行时填入（dispatch 后才知道实际 model），构造时不设 */
  model?: string
  /** 工具集合摘要：前 3 个工具名 + "+N" */
  allowedToolsDigest: string
}

/** 工具名按字母序排序后取前 3 + "+N"（如 "bash,edit_file,grep +12"）。 */
export function digestAllowedTools(tools: string[]): string {
  const sorted = [...tools].sort()
  const head = sorted.slice(0, 3).join(',')
  const tail = sorted.length > 3 ? ` +${sorted.length - 3}` : ''
  return head + tail
}

/**
 * 从 WorkOrder 白名单构造契约投影。
 *
 * 白名单字段：objective, profile, authority, authorityReason,
 *   scope.{files,symbols,maxFiles}, constraints, budget.{maxTurns,timeoutMs},
 *   allowedTools → allowedToolsDigest。
 *
 * 显式排除（不出现于返回值）：id, parentTurnId, kind, scope.{commands,externalUrls,maxTokens},
 *   disallowedTools, dedupeKey, dependencies, aggregationPolicy, budget.{maxTokens,maxRetries,retryBackoffMs,maxRetryBackoffMs},
 *   domain, workerCwd, reviewDepth, delegationDepth, riskTier, modelOverride, tierFloor。
 *
 * 模型层注入的 volatileBlock/账本/claims/stigmergy 不在 WorkOrder 上——
 * 它们由 buildWorkerPrompt 在 prompt 构造阶段注入，本函数天然隔离。
 */
export function buildContractProjection(order: WorkOrder): ContractProjection {
  return {
    objective: order.objective,
    profile: order.profile,
    ...(order.authority ? { authority: order.authority } : {}),
    ...(order.authorityReason ? { authorityReason: order.authorityReason } : {}),
    scope: {
      ...(order.scope.files?.length ? { files: order.scope.files } : {}),
      ...(order.scope.symbols?.length ? { symbols: order.scope.symbols } : {}),
      ...(order.scope.maxFiles != null ? { maxFiles: order.scope.maxFiles } : {}),
    },
    constraints: order.constraints,
    budget: {
      maxTurns: order.budget.maxTurns,
      timeoutMs: order.budget.timeoutMs,
    },
    allowedToolsDigest: digestAllowedTools(order.allowedTools),
  }
}
