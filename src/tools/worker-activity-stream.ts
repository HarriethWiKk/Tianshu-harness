import type { WorkerActivityEvent } from '../agent/coordinator.js'
import type { ContractProjection } from '../agent/contract-projection.js'
import type { DelegationActivity } from './types.js'

/** Shorten a work order id to a human label: "wo_team:T1" → "T1". */
export function shortOrderLabel(workOrderId: string): string {
  const seg = workOrderId.split(':').pop() ?? workOrderId
  return seg.replace(/^wo_/, '').slice(0, 12)
}

/**
 * 单行进度片段：压平空白（含 \n/\r/\t）后截断。
 *
 * progressLine / activity 最终落进 TUI live region 的单行槽位——worker 的
 * summary/detail 是自由文本（review 门 evidence 甚至显式用 \n 拼接），
 * 直接 slice 会把嵌入换行带进渲染行，破坏 LiveEngine 的显示行数追踪
 * （输入框重影根因之一）。所有进度片段截断必须走这里。
 */
export function progressSnippet(text: string, max = 80): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * One concise progress line for a worker activity event, for the structured
 * subagent fleet panel. Uses minimal English labels — tools already cycle
 * between types, so the label just records the current state without noise.
 */
export function activityProgressLine(event: WorkerActivityEvent): string {
  if (event.kind === 'tool_use') return `⚙ ${event.detail ? progressSnippet(event.detail, 60) : 'tool'}`
  if (event.kind === 'tool_result') return `✓ ${event.detail ? progressSnippet(event.detail, 50) : 'done'}`
  if (event.kind === 'thinking') return 'thinking'
  if (event.kind === 'retry') return '↻ upstream retry'
  if (event.kind === 'turn') return ''
  return 'writing'
}

export interface DelegationActivityMapperOpts {
  /** Resolve the worker objective by workOrderId. Objective is attached only
   *  on the first running event per worker to keep the SSE stream small. */
  objectiveOf?: (workOrderId: string) => string | undefined
  /** Resolve the contract projection by workOrderId. Like objective, only
   *  attached on the first running event per worker. */
  contractOf?: (workOrderId: string) => ContractProjection | undefined
}

/**
 * 共享的 WorkerActivityEvent → DelegationActivity 映射器（delegate_task /
 * delegate_batch / team_orchestrate 三处委派工具复用）。
 *
 * 在事件流上做 per-worker 计数聚合（CC AgentProgress 对标）：
 * - tool_use 事件累计工具调用次数
 * - turn 事件携带累计 token 总数（worker 每 turn 结束上报一次）
 * 每条 running 事件都带上最新计数，读模型（FleetRegistry / 桌面面板）只做归约。
 * objective 仅在该 worker 首条 running 事件携带（避免每 tick 重复传输）。
 */
export function createDelegationActivityMapper(
  parentToolId: string,
  onWorkerActivity: (activity: DelegationActivity) => void,
  opts?: DelegationActivityMapperOpts,
): (event: WorkerActivityEvent) => void {
  const counters = new Map<string, { toolUseCount: number; tokenCount: number }>()
  const objectiveSent = new Set<string>()
  // contract 与 objective 分开记账。objective 的「没查到就下条再试」是有意的
  // （objectiveOf 查表可能首条事件时还没就绪），但那道守卫此前连 contract 一起
  // 管着——objective 恰好为空时，contract 会跟着每条事件重发，下游按「首条才带」
  // 的约定去重就会漏。
  const contractSent = new Set<string>()

  return (event: WorkerActivityEvent) => {
    let c = counters.get(event.workOrderId)
    if (!c) {
      c = { toolUseCount: 0, tokenCount: 0 }
      counters.set(event.workOrderId, c)
    }
    if (event.kind === 'tool_use') c.toolUseCount += 1
    if (event.kind === 'turn') {
      const n = Number(event.detail)
      if (Number.isFinite(n) && n > c.tokenCount) c.tokenCount = n
    }
    const line = activityProgressLine(event)
    let objective: string | undefined
    let contract: ContractProjection | undefined
    if (!objectiveSent.has(event.workOrderId)) {
      // Prefer coordinator-attached objective; fall back to tool-side lookup.
      objective = event.objective ?? opts?.objectiveOf?.(event.workOrderId)
      if (objective) objectiveSent.add(event.workOrderId)
    }
    if (!contractSent.has(event.workOrderId)) {
      // Contract: coordinator 随事件携带（首选）；contractOf 为工具侧兜底。
      contract = event.contract ?? opts?.contractOf?.(event.workOrderId)
      if (contract) contractSent.add(event.workOrderId)
    }
    onWorkerActivity({
      workOrderId: event.workOrderId,
      parentToolId,
      profile: event.profile,
      authority: event.authority,
      authorityReason: event.authorityReason,
      status: 'running',
      ...(objective ? { objective } : {}),
      progressLine: line || undefined,
      toolUseCount: c.toolUseCount,
      tokenCount: c.tokenCount > 0 ? c.tokenCount : undefined,
      eventKind: event.kind,
      eventDetail: event.detail,
      ...(contract ? { contract } : {}),
    })
  }
}

/**
 * T9 P3 实时上行: convert raw worker activity events into a bounded stream of
 * progress lines for the live tool card.
 *
 * V2 改进：
 * - text 心跳不再输出 deltas 计数行（用户不需要 token 吞吐量）
 * - 首次 text 只输出一次「写作中」，之后静默
 * - tool_use / tool_result 始终输出（一行一条）
 */
export function createActivityStreamer(
  emit: (line: string) => void,
  _opts?: { textEvery?: number },
): (event: WorkerActivityEvent) => void {
  const textSeen = new Set<string>()
  const retrySeen = new Set<string>()

  return (event: WorkerActivityEvent) => {
    if (event.kind === 'turn') return  // 计数心跳，不产生文本行
    const label = `${shortOrderLabel(event.workOrderId)}·${event.profile}`
    if (event.kind === 'tool_use') {
      const toolDetail = event.detail ? ` ${progressSnippet(event.detail, 60)}` : ''
      emit(`  ↳ [${label}] ⚙${toolDetail}\n`)
      return
    }
    if (event.kind === 'tool_result') {
      const resultHint = event.detail ? ` (${progressSnippet(event.detail, 40)})` : ''
      emit(`  ↳ [${label}] ✓ 完成${resultHint}\n`)
      return
    }
    // retry: 上游内部重试（慢 ≠ 死）——每个 worker 只报一次，避免刷屏
    if (event.kind === 'retry') {
      if (!retrySeen.has(event.workOrderId)) {
        retrySeen.add(event.workOrderId)
        emit(`  ↳ [${label}] ↻ 上游重试中\n`)
      }
      return
    }
    // text / thinking: 首次输出状态行，之后静默——避免 deltas 计数刷屏
    if (!textSeen.has(event.workOrderId)) {
      textSeen.add(event.workOrderId)
      const glyph = event.kind === 'thinking' ? '思考中' : '写作中'
      emit(`  ↳ [${label}] ✎ ${glyph}\n`)
    }
  }
}
