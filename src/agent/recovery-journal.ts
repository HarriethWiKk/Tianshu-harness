/**
 * Recovery Journal — intent preservation across destructive file operations.
 *
 * When a file edit goes wrong and the agent restores the file (undo / git checkout),
 * the original intent is lost — the file is clean, and the task appears "done."
 *
 * This module records each recovery event so deliver_task can flag outstanding
 * intent that might have been silently dropped.
 *
 * Format (.rivet/recovery-journal.jsonl, one JSON object per line):
 *   {"file":"src/agent/deliver-task.ts","action":"git checkout HEAD","ts":"2026-06-07T...","linesLost":22}
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RecoveryEntry {
  file: string
  action: string
  ts: string
  linesLost: number
  /** Session that actually performed the recovery. Never infer liveness from this log. */
  sessionId?: string
  /** Set to true after deliver_task has shown the warning so it won't repeat. */
  acknowledged?: boolean
  /** A handoff preserved the context in the successor session. */
  handedOff?: boolean
}

function journalPath(cwd: string): string {
  return join(cwd, '.rivet', 'recovery-journal.jsonl')
}

function readEntries(cwd: string): RecoveryEntry[] {
  const path = journalPath(cwd)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as RecoveryEntry } catch { return null }
    }).filter((e): e is RecoveryEntry => e !== null)
  } catch {
    return []
  }
}

function writeEntries(cwd: string, entries: readonly RecoveryEntry[]): void {
  const path = journalPath(cwd)
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf-8')
}

export function recordRecovery(cwd: string, entry: Omit<RecoveryEntry, 'ts' | 'sessionId'>, sessionId?: string): void {
  const dir = join(cwd, '.rivet')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const record: RecoveryEntry = { ...entry, ts: new Date().toISOString(), ...(sessionId ? { sessionId } : {}) }
  appendFileSync(journalPath(cwd), JSON.stringify(record) + '\n', 'utf-8')
}

/**
 * Session-scoped callers intentionally ignore legacy unscoped entries. They are
 * historical evidence, not proof that a different session still owns a file.
 */
export function readUnacknowledged(cwd: string, sessionId?: string): RecoveryEntry[] {
  return readEntries(cwd).filter(entry =>
    !entry.acknowledged && !entry.handedOff && (sessionId === undefined || entry.sessionId === sessionId),
  )
}

export function acknowledgeAll(cwd: string, sessionId?: string): void {
  const entries = readEntries(cwd)
  let changed = false
  const updated = entries.map(entry => {
    if (!entry.acknowledged && !entry.handedOff && (sessionId === undefined || entry.sessionId === sessionId)) {
      changed = true
      return { ...entry, acknowledged: true }
    }
    return entry
  })
  if (changed) writeEntries(cwd, updated)
}

/** Mark the source session's recovery evidence as transferred after handoff. */
export function handoffRecoveries(cwd: string, sessionId: string): void {
  const entries = readEntries(cwd)
  let changed = false
  const updated = entries.map(entry => {
    if (!entry.acknowledged && !entry.handedOff && entry.sessionId === sessionId) {
      changed = true
      return { ...entry, handedOff: true }
    }
    return entry
  })
  if (changed) writeEntries(cwd, updated)
}
