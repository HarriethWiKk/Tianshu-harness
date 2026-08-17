/**
 * Recovery stack — list and undo via recovery journal entries.
 *
 * Tracks both mutations (file changes with backups) and restorations (undo events),
 * providing a complete audit trail for file operations.
 */

import { readUnacknowledged, recordRecovery, type RecoveryEntry } from './recovery-journal.js'
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** Lightweight record of a file mutation with a backup for undo. */
export interface FileChangeRecord {
  filePath: string
  action: 'edit' | 'write' | 'delete'
  /** Path to a temporary backup of the original file content. */
  backupPath?: string
  toolCallId: string
  ts: number
}

export function listRecoveryStack(cwd: string, sessionId?: string): RecoveryEntry[] {
  return readUnacknowledged(cwd, sessionId)
}

export function renderRecoveryStack(cwd: string, sessionId?: string): string {
  const entries = listRecoveryStack(cwd, sessionId)
  if (entries.length === 0) return 'Recovery stack empty — no unacknowledged recovery events.'

  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.file} — ${e.action} (${e.linesLost} lines lost, ${e.ts})`,
  )
  return `Recovery stack (${entries.length}):\n${lines.join('\n')}\n\nThese files were restored during the session; verify intent before deliver_task.`
}

/** Record a file restore event (called from undo/edit recovery paths). */
export function trackFileRestore(
  cwd: string,
  file: string,
  action: string,
  linesLost = 0,
  sessionId?: string,
): void {
  recordRecovery(cwd, { file, action, linesLost }, sessionId)
}

/** Per-process latest backup path per (cwd, filePath). Used by the edit tools
 *  to roll back a write when post-edit structural validation fails.
 *  Keyed by canonical absolute path to avoid collisions across sessions. */
const latestBackups = new Map<string, string>()

function backupKey(cwd: string, filePath: string): string {
  return join(cwd, filePath)
}

/** Cap on `.rivet/backups/` timestamp directories kept on disk. */
const MAX_BACKUP_DIRS = 100

/**
 * Evict oldest timestamp-named backup dirs beyond the cap. The dirs are
 * `Date.now()`-named (see trackFileChange), so name order = age order; only
 * fully-numeric names are eligible, foreign dirs are never touched. Best-effort
 * — eviction failures degrade silently (backup cleanup is non-critical).
 */
export function evictOldBackups(cwd: string, maxDirs = MAX_BACKUP_DIRS): void {
  try {
    const backupsDir = join(cwd, '.rivet', 'backups')
    if (!existsSync(backupsDir)) return
    const dirs = readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
      .map(e => e.name)
      .sort()
    const excess = dirs.length - maxDirs
    if (excess <= 0) return
    for (const name of dirs.slice(0, excess)) {
      rmSync(join(backupsDir, name), { recursive: true, force: true })
    }
  } catch {
    // Non-critical — degrade silently
  }
}

/**
 * Restore a file to its most recent backup recorded by trackFileChange.
 * Returns true if a backup existed and was restored; false otherwise.
 */
export function restoreLatestBackup(cwd: string, filePath: string, sessionId?: string): boolean {
  const key = backupKey(cwd, filePath)
  const backupPath = latestBackups.get(key)
  if (!backupPath || !existsSync(backupPath)) return false
  const absPath = join(cwd, filePath)
  try {
    copyFileSync(backupPath, absPath)
    recordRecovery(cwd, { file: filePath, action: 'restore latest backup', linesLost: 0 }, sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Create a backup of a file before mutation and record the change.
 * The backup lives in .rivet/backups/<timestamp>/<relpath> so undo can recover.
 */
export function trackFileChange(cwd: string, record: Omit<FileChangeRecord, 'backupPath' | 'ts'>): FileChangeRecord {
  const ts = Date.now()
  let backupPath: string | undefined

  const absPath = join(cwd, record.filePath)
  if (existsSync(absPath)) {
    const backupDir = join(cwd, '.rivet', 'backups', String(ts))
    mkdirSync(backupDir, { recursive: true })
    const relDir = dirname(record.filePath)
    if (relDir && relDir !== '.') {
      mkdirSync(join(backupDir, relDir), { recursive: true })
    }
    backupPath = join(backupDir, record.filePath)
    copyFileSync(absPath, backupPath)
    latestBackups.set(backupKey(cwd, record.filePath), backupPath)
    // Unbounded .rivet/backups growth (observed 6,396 dirs / 238MB) — cap it
    // on the write path where the dir count is already being touched.
    evictOldBackups(cwd)
  }

  return { ...record, backupPath, ts }
}

/** Estimate lines lost by comparing current file to backup if available. */
export function estimateLinesLost(cwd: string, file: string, backupPath?: string): number {
  if (!backupPath || !existsSync(backupPath)) return 0
  try {
    const backupLines = readFileSync(backupPath, 'utf-8').split('\n').length
    const currentPath = join(cwd, file)
    if (!existsSync(currentPath)) return backupLines
    const currentLines = readFileSync(currentPath, 'utf-8').split('\n').length
    return Math.max(0, backupLines - currentLines)
  } catch {
    return 0
  }
}
