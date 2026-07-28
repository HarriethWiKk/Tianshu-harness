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
 * subagent fleet panel.
 */
export function activityProgressLine(event: WorkerActivityEvent): string {
  if (event.kind === 'tool_use') return `⚙ ${event.detail ? progressSnippet(event.detail, 60) : '工具调用'}`
  if (event.kind === 'tool_result') return `✓ ${event.detail ? progressSnippet(event.detail, 50) : '完成'}`
  if (event.kind === 'thinking') return '思考中'
  if (event.kind === 'retry') return '↻ 上游重试'
  // lifecycle：派发侧补发的阶段短语（续跑 / 证据复核），detail 已是成句中文。
  if (event.kind === 'lifecycle') return event.detail ? `↻ ${progressSnippet(event.detail, 60)}` : '↻ 补偿轮'
  if (event.kind === 'turn') return ''
  return '写入中'
}

export interface DelegationActivityMapperOpts {
  /** Resolve the worker objective by workOrderId. Objective is attached only
   *  on the first running event per worker to keep the SSE stream small. */
  objectiveOf?: (workOrderId: string) => string | undefined
  /** Resolve the contract projection by workOrderId. Like objective, only
   *  attached on the first running event per worker. */
  contractOf?: (workOrderId: string) => ContractProjection | undefined
  /** text/thinking delta 尾沿合并窗口（ms），默认 120。测试可注入小值。 */
  coalesceMs?: number
}

const DEFAULT_COALESCE_MS = 120

/** text/thinking 尾沿合并槽：同 kind 连续 delta 累积进 parts，到时/切换/非流式事件触发 flush。 */
interface PendingStreamSlot {
  kind: 'text' | 'thinking'
  parts: string[]
  /** 首个 delta 原样保留作透传基底（profile/authority/objective/contract）。 */
  base: WorkerActivityEvent
  /** 组成事件里首个非空 objective/contract（可能晚于首个 delta 才携带）。 */
  objective?: string
  contract?: ContractProjection
  timer?: ReturnType<typeof setTimeout>
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
 *
 * text/thinking delta 做 per-worker 尾沿合并（默认 120ms）：同 kind 连续 delta
 * 累积为一条发出，eventDetail 是 parts 拼接全文（下游 WorkerMirrorStore 靠它重建
 * 完整转录，一个字节都不能丢）——否则每个 token 一条事件会打满 TUI 帧。flush
 * 触发：尾沿定时器到时 / 同 worker kind 切换（text↔thinking，先 flush 旧槽再起
 * 新槽）/ 该 worker 任意非流式事件到达（非流式事件不合并、不延迟，先 flush 再
 * 即时透传，保持时序）。
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
  const coalesceMs = opts?.coalesceMs ?? DEFAULT_COALESCE_MS
  // pending 槽 flush 即删；槽数受单次委派的 worker 数约束，不随事件流增长。
  const pending = new Map<string, PendingStreamSlot>()

  const counterOf = (workOrderId: string) => {
    let c = counters.get(workOrderId)
    if (!c) {
      c = { toolUseCount: 0, tokenCount: 0 }
      counters.set(workOrderId, c)
    }
    return c
  }

  // 实际发出一条 activity。objective/contract 的「首条携带、查不到下条再试」
  // 记账以发出时刻为准——被合并延迟的首条事件照常携带。
  const emit = (event: WorkerActivityEvent, detail: string | undefined) => {
    const c = counterOf(event.workOrderId)
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
      eventDetail: detail,
      ...(contract ? { contract } : {}),
    })
  }

  const flushPending = (workOrderId: string) => {
    const slot = pending.get(workOrderId)
    if (!slot) return
    if (slot.timer) clearTimeout(slot.timer)
    pending.delete(workOrderId)
    const merged: WorkerActivityEvent = { ...slot.base }
    if (slot.objective !== undefined) merged.objective = slot.objective
    if (slot.contract !== undefined) merged.contract = slot.contract
    emit(merged, slot.parts.join(''))
  }

  return (event: WorkerActivityEvent) => {
    if (event.kind === 'text' || event.kind === 'thinking') {
      const cur = pending.get(event.workOrderId)
      if (cur && cur.kind !== event.kind) flushPending(event.workOrderId)
      let slot = pending.get(event.workOrderId)
      if (!slot) {
        slot = { kind: event.kind, parts: [], base: event }
        pending.set(event.workOrderId, slot)
      }
      if (event.detail) slot.parts.push(event.detail)
      if (slot.objective === undefined && event.objective !== undefined) slot.objective = event.objective
      if (slot.contract === undefined && event.contract !== undefined) slot.contract = event.contract
      // 尾沿定时器：每个新 delta 重置；unref 不拖进程退出。
      if (slot.timer) clearTimeout(slot.timer)
      const timer = setTimeout(() => flushPending(event.workOrderId), coalesceMs)
      if (typeof timer.unref === 'function') timer.unref()
      slot.timer = timer
      return
    }
    // 非流式事件：先 flush 该 worker 的 pending（合并事件按到达时序携带此前计数），
    // 再更新计数并即时透传本事件。
    flushPending(event.workOrderId)
    const c = counterOf(event.workOrderId)
    if (event.kind === 'tool_use') c.toolUseCount += 1
    if (event.kind === 'turn') {
      const n = Number(event.detail)
      if (Number.isFinite(n) && n > c.tokenCount) c.tokenCount = n
    }
    emit(event, event.detail)
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
    // lifecycle: 补偿轮开场（续跑 / 证据复核）。整次派发最多几条，不去重——
    // 「第几次续跑」正是用户想看的，压掉就只剩一段无解释的沉默。
    if (event.kind === 'lifecycle') {
      if (event.detail) emit(`  ↳ [${label}] ↻ ${progressSnippet(event.detail, 60)}\n`)
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
