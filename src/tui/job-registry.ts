import type { JobEvent, JobSnapshot, JobStatus } from '../tools/job-store.js'

/** One background job as the TUI read model sees it. */
export interface JobRow {
  id: string
  command: string
  status: JobStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  lastLine: string
  /** True once the job has reached a terminal status (exited/killed). */
  terminal: boolean
  /** Terminal but not yet viewed by the user (drives the unread dot). */
  unread: boolean
}

/** Result of applying one event: did this event flip the job into a terminal state? */
export interface JobApplyResult {
  row: JobRow
  becameTerminal: boolean
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['exited', 'killed'])

/**
 * TUI-side read model for background jobs. Reduces the server-shaped JobEvent
 * stream (job-store.ts) into stable JobRow records. Pure data — no rendering,
 * no I/O. Mirrors FleetRegistry (fleet-registry.ts) for workers.
 */
export class JobRegistry {
  /** 终态条目上限：超出时淘汰最旧的（overlay 每次全量渲染，行数也须有界）。 */
  static readonly MAX_TERMINAL_ROWS = 50
  private jobs = new Map<string, JobRow>()

  /** Apply one event; returns the updated row + whether it just became terminal. */
  apply(ev: JobEvent): JobApplyResult {
    const snap: JobSnapshot = ev.job
    const prev = this.jobs.get(snap.id)
    const wasTerminal = prev?.terminal ?? false
    const nowTerminal = TERMINAL.has(snap.status)
    const row: JobRow = {
      id: snap.id,
      command: snap.command,
      status: snap.status,
      exitCode: snap.exitCode,
      startedAt: snap.startedAt,
      endedAt: snap.endedAt,
      lastLine: snap.lastLine || prev?.lastLine || '',
      terminal: nowTerminal,
      unread: nowTerminal && !wasTerminal ? true : (prev?.unread ?? false),
    }
    this.jobs.set(snap.id, row)
    if (nowTerminal && !wasTerminal) this.evictTerminals()
    return { row, becameTerminal: nowTerminal && !wasTerminal }
  }

  /** 淘汰最旧的终态行（见 MAX_TERMINAL_ROWS）。 */
  private evictTerminals(): void {
    const terminals = [...this.jobs.values()]
      .filter(r => r.terminal)
      .sort((a, b) => a.startedAt - b.startedAt)
    const excess = terminals.length - JobRegistry.MAX_TERMINAL_ROWS
    for (let i = 0; i < excess; i++) this.jobs.delete(terminals[i]!.id)
  }

  /** Clear the unread flag for one job (user viewed it). */
  markSeen(id: string): void {
    const row = this.jobs.get(id)
    if (row && row.unread) this.jobs.set(id, { ...row, unread: false })
  }

  /** Running jobs first, then terminal; newest startedAt first within each group. */
  rows(): JobRow[] {
    return [...this.jobs.values()].sort((a, b) => {
      if (a.terminal !== b.terminal) return a.terminal ? 1 : -1
      return b.startedAt - a.startedAt
    })
  }

  runningCount(): number {
    let n = 0
    for (const r of this.jobs.values()) if (!r.terminal) n++
    return n
  }

  unreadCount(): number {
    let n = 0
    for (const r of this.jobs.values()) if (r.unread) n++
    return n
  }
}
