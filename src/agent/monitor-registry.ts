/**
 * monitor-registry.ts — Monitor 工具的事件订阅内核。
 *
 * 一个 monitor = 「订阅某后台 job 的输出流（可选正则过滤），命中即产事件」。
 * 事件不直接进对话——进 per-monitor 队列，由 monitor-hook（preTurn）在每个
 * API 轮边界 drain 后经 advisory bus 以 system-reminder 注入（模型必读通道，
 * 尾部追加、前缀缓存安全）。
 *
 * 设计约束（来自 advisory bus / SR 通道纪律）：
 * - bus 同 key 同轮去重 → 事件 key 必须含序号（registry 级单调 seq）
 * - 'functional' SR 类不限流，但调用方必须自带闩锁 → 每轮 drain 总量与
 *   每 monitor 双上限（MAX_DRAIN_TOTAL / MAX_DRAIN_PER_MONITOR）
 * - 高频输出必须合并 → 事件摘录截断 + 队列溢出时丢弃最旧并合成「省略 N 条」
 *
 * 生命周期：job exit → 产终态事件并自动注销；setJobs 替换 SessionJobs 实例
 * （server 注入）时监听器在下次 subscribe/drain 自动重绑。
 */

import { randomUUID } from 'node:crypto'
import type { JobEvent, SessionJobs } from '../tools/job-store.js'
import type { TelemetryWriter } from './telemetry-writer.js'

/** 每会话同时存活的 monitor 上限。 */
export const MAX_MONITORS = 5
/** 单次 drain 返回的事件总量上限（对齐 advisory bus 每轮渲染预算）。 */
export const MAX_DRAIN_TOTAL = 2
/** 单次 drain 中单个 monitor 的事件上限。 */
export const MAX_DRAIN_PER_MONITOR = 2
/** 单个 monitor 的待投事件队列上限；溢出丢最旧并合成省略标记。 */
const MAX_QUEUED_PER_MONITOR = 20
/** 事件正文摘录上限（字符）。 */
const EXCERPT_CAP = 600
/** pattern 命中时最多保留的命中行数。 */
const MAX_MATCH_LINES = 5

export type MonitorEventKind = 'match' | 'output' | 'exit' | 'overflow'

export interface MonitorEvent {
  /** registry 级单调序号——advisory bus 去重 key 的组成部分。 */
  seq: number
  monitorId: string
  jobId: string
  kind: MonitorEventKind
  /** 注入用正文（已截断）。 */
  text: string
}

export interface MonitorSnapshot {
  id: string
  jobId: string
  command: string
  pattern?: string
  createdAt: number
  /** 队列中待投递的事件数。 */
  pending: number
}

interface MonitorState {
  id: string
  jobId: string
  command: string
  pattern?: string
  regex?: RegExp
  createdAt: number
  queue: MonitorEvent[]
  /** 队列溢出被丢弃的事件数（下次 drain 合成 overflow 事件）。 */
  dropped: number
  /** job 已终态：不再接收新事件；队列排干后由 drain 移除。 */
  closed: boolean
}

export interface MonitorSubscribeInput {
  jobId: string
  pattern?: string
}

export type MonitorSubscribeResult =
  | { ok: true; monitor: MonitorSnapshot }
  | { ok: false; error: string }

export interface MonitorRegistryOptions {
  telemetry?: TelemetryWriter
  maxMonitors?: number
}

export class MonitorRegistry {
  private readonly monitors = new Map<string, MonitorState>()
  private seq = 0
  private attachedJobs: SessionJobs | undefined
  private readonly onJobEvent = (ev: JobEvent): void => this.handleJobEvent(ev)

  constructor(
    private readonly getJobs: () => SessionJobs | undefined,
    private readonly opts: MonitorRegistryOptions = {},
  ) {}

  /** SessionJobs 实例可能被 setJobs 整体替换（server 注入）——按需重绑监听。 */
  private ensureAttached(): SessionJobs | undefined {
    const jobs = this.getJobs()
    if (jobs !== this.attachedJobs) {
      try { this.attachedJobs?.off('event', this.onJobEvent) } catch { /* best-effort */ }
      this.attachedJobs = jobs
      if (jobs) {
        try { jobs.on('event', this.onJobEvent) } catch { this.attachedJobs = undefined }
      }
    }
    return jobs
  }

  subscribe(input: MonitorSubscribeInput): MonitorSubscribeResult {
    const jobs = this.ensureAttached()
    if (!jobs) return { ok: false, error: '后台任务系统不可用（无会话）。' }
    const job = jobs.list().find(j => j.id === input.jobId)
    if (!job) return { ok: false, error: `未找到后台任务 ${input.jobId}。用 job(action="list") 查看。` }
    const max = this.opts.maxMonitors ?? MAX_MONITORS
    if (this.monitors.size >= max) {
      return { ok: false, error: `已达 monitor 上限 ${max} 个，先 unsubscribe 不需要的。` }
    }
    let regex: RegExp | undefined
    if (input.pattern) {
      try {
        regex = new RegExp(input.pattern)
      } catch {
        return { ok: false, error: `pattern 不是合法正则：${input.pattern}` }
      }
    }
    const id = `mon-${randomUUID().slice(0, 6)}`
    const state: MonitorState = {
      id,
      jobId: job.id,
      command: job.command,
      pattern: input.pattern,
      regex,
      createdAt: Date.now(),
      queue: [],
      dropped: 0,
      closed: false,
    }
    this.monitors.set(id, state)
    return { ok: true, monitor: this.snapshot(state) }
  }

  unsubscribe(id: string): boolean {
    return this.monitors.delete(id)
  }

  list(): MonitorSnapshot[] {
    return [...this.monitors.values()].map(m => this.snapshot(m))
  }

  hasActive(): boolean {
    return this.monitors.size > 0
  }

  /**
   * 每 API 轮边界由 monitor-hook 调用：取出本轮待投事件（总量/单 monitor 双
   * 上限），其余留队下轮再投。队列溢出时先发一条 overflow 合成事件。
   */
  drainEvents(maxTotal: number = MAX_DRAIN_TOTAL): MonitorEvent[] {
    this.ensureAttached()
    const out: MonitorEvent[] = []
    for (const state of this.monitors.values()) {
      if (out.length >= maxTotal) break
      let taken = 0
      // 溢出合成事件优先投递（它解释了之后事件的空洞）。
      if (state.dropped > 0 && taken < MAX_DRAIN_PER_MONITOR && out.length < maxTotal) {
        out.push(this.makeEvent(state, 'overflow', `…高频输出，省略了 ${state.dropped} 条中间事件`))
        state.dropped = 0
        taken++
      }
      while (taken < MAX_DRAIN_PER_MONITOR && out.length < maxTotal && state.queue.length > 0) {
        out.push(state.queue.shift()!)
        taken++
      }
      // 终态 monitor 排干即移除（遗言已投递）。
      if (state.closed && state.queue.length === 0 && state.dropped === 0) {
        this.monitors.delete(state.id)
      }
    }
    for (const ev of out) {
      try {
        this.opts.telemetry?.write({ kind: 'monitor-event', monitorId: ev.monitorId, jobId: ev.jobId, evKind: ev.kind, chars: ev.text.length })
      } catch { /* telemetry best-effort */ }
    }
    return out
  }

  /** 会话关闭/setJobs 替换前调用：摘监听、清空订阅。 */
  dispose(): void {
    try { this.attachedJobs?.off('event', this.onJobEvent) } catch { /* best-effort */ }
    this.attachedJobs = undefined
    this.monitors.clear()
  }

  // ── 内部 ────────────────────────────────────────────────────

  private handleJobEvent(ev: JobEvent): void {
    if (ev.kind === 'started') return
    for (const state of this.monitors.values()) {
      if (state.jobId !== ev.job.id) continue
      if (ev.kind === 'output' && ev.chunk) {
        this.enqueueOutput(state, ev.chunk)
      } else if (ev.kind === 'exit') {
        const status = ev.job.status === 'killed' ? '被终止' : '已退出'
        this.enqueue(state, this.makeEvent(state, 'exit', `任务${status} (exit ${ev.job.exitCode ?? '?'})`))
        // 标记终态但保留在 map——drain 排干遗言后才移除，否则终态事件丢失。
        state.closed = true
      }
    }
  }

  private enqueueOutput(state: MonitorState, chunk: string): void {
    if (state.regex) {
      const hits = chunk.split('\n').filter(l => state.regex!.test(l))
      if (hits.length === 0) return
      const excerpt = hits.slice(-MAX_MATCH_LINES).join('\n')
      this.enqueue(state, this.makeEvent(state, 'match', truncate(`命中 /${state.pattern}/：\n${excerpt}`)))
    } else {
      this.enqueue(state, this.makeEvent(state, 'output', truncate(`新输出：\n${tailLines(chunk)}`)))
    }
  }

  private enqueue(state: MonitorState, ev: MonitorEvent): void {
    state.queue.push(ev)
    while (state.queue.length > MAX_QUEUED_PER_MONITOR) {
      state.queue.shift()
      state.dropped++
    }
  }

  private makeEvent(state: MonitorState, kind: MonitorEventKind, text: string): MonitorEvent {
    return { seq: ++this.seq, monitorId: state.id, jobId: state.jobId, kind, text }
  }

  private snapshot(state: MonitorState): MonitorSnapshot {
    return {
      id: state.id,
      jobId: state.jobId,
      command: state.command,
      pattern: state.pattern,
      createdAt: state.createdAt,
      pending: state.queue.length,
    }
  }
}

function truncate(text: string): string {
  return text.length > EXCERPT_CAP ? text.slice(0, EXCERPT_CAP) + '…' : text
}

function tailLines(chunk: string, maxLines = 5): string {
  const lines = chunk.split('\n').filter(l => l.length > 0)
  return lines.slice(-maxLines).join('\n')
}
