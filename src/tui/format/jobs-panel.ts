import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { formatElapsed } from '../worker-panel-model.js'
import type { JobRow } from '../job-registry.js'

/** Flatten whitespace (incl. \n \r \t) then truncate — LiveEngine row-count safety. */
function snippet(text: string, max = 60): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function statusGlyph(row: JobRow): string {
  if (!row.terminal) return '◐'
  if (row.status === 'killed') return '⊗'
  return row.exitCode === 0 ? '✓' : '✗'
}

function statusColor(row: JobRow, theme: RivetTheme): string {
  if (!row.terminal) return theme.success
  if (row.status === 'killed') return theme.warning
  return row.exitCode === 0 ? theme.success : theme.error
}

/**
 * Full-screen `/jobs` overlay: one row per background job. Running jobs first
 * (JobRegistry.rows() already sorts), terminal after. selectedIndex draws the
 * cursor marker. Framework-agnostic — ansi/theme only.
 */
export function renderJobsOverlay(
  rows: JobRow[],
  columns: number,
  _rows: number,
  theme: RivetTheme,
  selectedIndex: number,
): string[] {
  const out: string[] = []
  out.push(color(` 后台任务 (${rows.length})`, theme.success, { bold: true }))
  out.push('')
  if (rows.length === 0) {
    out.push(color('  没有后台任务。bash(run_in_background=true) 启动的任务会出现在这里。', theme.muted))
    return out
  }
  const cmdWidth = Math.max(10, Math.min(40, columns - 40))
  rows.forEach((row, i) => {
    const sel = i === selectedIndex
    const marker = sel ? '❯' : ' '
    const glyph = statusGlyph(row)
    const c = statusColor(row, theme)
    const dot = row.unread ? color('●', theme.warning) : ' '
    const cmd = snippet(row.command, cmdWidth).padEnd(cmdWidth)
    const elapsed = formatElapsed(row.terminal && row.endedAt ? row.endedAt - row.startedAt : Date.now() - row.startedAt)
    const state = row.terminal
      ? (row.status === 'killed' ? 'killed' : `exit ${row.exitCode ?? '?'}`)
      : 'running'
    const tail = row.lastLine ? `  ${color(snippet(row.lastLine, 40), theme.muted)}` : ''
    const head = `${marker}${dot}${color(glyph, c)} ${color(row.id, theme.dim)} ${cmd} ${color(state, c)} ${color(elapsed, theme.dim)}`
    out.push(head + tail)
  })
  out.push('')
  out.push(color('  ↑↓ 选择 · Enter 查看日志 · x 停止 · Esc 关闭', theme.muted))
  return out
}
