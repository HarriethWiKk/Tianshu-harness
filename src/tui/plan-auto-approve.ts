/**
 * Goal 模式计划倒计时自动批准 — TUI 纯逻辑层（2026-07-24）。
 *
 * 与 sidecar 版（src/server/session-manager.ts maybeArmPlanAutoApprove）语义
 * 一一对应：goal 激活 + 计划提交 → 武装倒计时；守卫复核通过 → 自动批准；
 * 用户任何参与即取消。本文件只做判定，不碰定时器/UI（TuiApp 持有两者）。
 */

export interface PlanAutoApproveState {
  slug: string
  deadlineMs: number
}

/** 触发前的守卫复核条件（与 server 版守卫逐项对应）。 */
export interface PlanAutoApproveGuards {
  /** TUI 空闲（无 run 在飞）。 */
  idle: boolean
  /** goal tracker 仍激活。 */
  goalActive: boolean
  /** 计划仍为 submitted（未被用户/外部改动）。 */
  planStillSubmitted: boolean
}

export const DEFAULT_PLAN_AUTO_APPROVE_MS = 150_000

/**
 * 解析 RIVET_GOAL_PLAN_AUTO_APPROVE_MS。默认 150s；0 = 关闭（纯手动审批）；
 * 非法值回落默认（与 serve.ts 的解析保持一致）。
 */
export function resolveAutoApproveMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RIVET_GOAL_PLAN_AUTO_APPROVE_MS
  if (raw == null || raw.trim() === '') return DEFAULT_PLAN_AUTO_APPROVE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLAN_AUTO_APPROVE_MS
}

/** 武装条件：窗口开启（delayMs > 0）且 goal 激活。非 goal 会话不武装。 */
export function shouldArm(goalActive: boolean, delayMs: number): boolean {
  return delayMs > 0 && goalActive
}

/** 剩余秒（ceil，≤0 归零）——overlay caption 与 GlanceBar 徽章共用。 */
export function remainingSec(state: PlanAutoApproveState, now: number): number {
  return Math.max(0, Math.ceil((state.deadlineMs - now) / 1000))
}

/** 触发判定：到点且全部守卫通过。守卫不过 = 不触发（计划退化为纯手动审批）。 */
export function shouldFire(state: PlanAutoApproveState, now: number, guards: PlanAutoApproveGuards): boolean {
  if (now < state.deadlineMs) return false
  return guards.idle && guards.goalActive && guards.planStillSubmitted
}
