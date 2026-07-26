/**
 * Worker Detail 内容构建器 — 为 `/tasks` Enter 提供可分页、可搜索的详情。
 *
 * 数据来源：
 * - liveView（FleetRegistry）→ profile、authority、status、elapsed、activityLog
 * - ~/.rivet/subagents/<workerId>.json（loadPersistedResult）→ result summary / changed files / artifacts / usage
 * - ~/.rivet/sessions/<slug>/worker-<id>.jsonl（SessionPersist.loadOai）→ 完整对话转录
 */

import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { loadPersistedResult } from '../agent/coordinator.js'
import type { FleetWorkerView } from './fleet-registry.js'
import type { TranscriptMessage } from './scrollback-transcript.js'
import { parseScrollbackTranscript } from './scrollback-transcript.js'
import type { OaiMessage } from '../api/oai-types.js'
import { shortOrderLabel } from '../tools/worker-activity-stream.js'
import { formatAuthorityLabel } from './format/profile-labels.js'

const MAX_CONTENT_CHARS = 500

function truncate(text: string, max = MAX_CONTENT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function formatTokens(usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_tokens?: number }): string {
  if (!usage) return '-'
  const parts: string[] = []
  if (usage.input_tokens !== undefined) parts.push(`in ${usage.input_tokens}`)
  if (usage.output_tokens !== undefined) parts.push(`out ${usage.output_tokens}`)
  if (usage.cache_read_input_tokens) parts.push(`cache ${usage.cache_read_input_tokens}`)
  if (usage.reasoning_tokens) parts.push(`reason ${usage.reasoning_tokens}`)
  return parts.join(' · ') || '-'
}

/** 诚实标签：根据 failureReason / evidenceStatus 返回人类可读的警告文本。 */
function honestyLabel(failureReason?: string, evidenceStatus?: string): string | null {
  switch (failureReason) {
    case 'max_turns': return '预算耗尽 · 摘要可能不完整'
    case 'json_parse': return '结果解析失败 · 已从碎片恢复'
    case 'worker_crash': return 'Worker 异常终止'
    case 'timeout': return 'Worker 超时'
    case 'caller_aborted': return '已被取消'
    case 'worker_blocked': return 'Worker 被阻断'
    default: break
  }
  if (evidenceStatus === 'failed') return '验收证据验证失败'
  return null
}

function formatOaiMessages(messages: OaiMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'system': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(`┌─ system`)
        lines.push(truncate(text))
        break
      }
      case 'user': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(`▌ you`)
        lines.push(truncate(text))
        break
      }
      case 'assistant': {
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          lines.push(truncate(text))
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? '?'
            const args = tc.function?.arguments ?? '{}'
            lines.push(`● ${name} ${truncate(args, 160)}`)
          }
        }
        break
      }
      case 'tool': {
        lines.push(`● tool result  ${msg.tool_call_id ?? ''}`)
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(truncate(text))
        break
      }
    }
  }
  return lines.join('\n')
}

export interface WorkerDetailContent {
  content: string
  title: string
  messages: TranscriptMessage[]
}

/**
 * 构建指定 worker 的详情内容。
 * @param workerId work order id（如 wo_team:T1）
 * @param cwd 当前项目目录，用于定位会话文件
 * @param liveView FleetRegistry 中的实时视图（可选，提供 profile/authority/activityLog）
 */
export function buildWorkerDetailContent(
  workerId: string,
  cwd: string,
  liveView?: FleetWorkerView,
): WorkerDetailContent {
  const shortLabel = liveView?.shortLabel ?? shortOrderLabel(workerId)
  const lines: string[] = []

  lines.push(`══ Worker ${shortLabel} ══`)
  lines.push(`id: ${workerId}`)
  if (liveView?.profile) lines.push(`profile: ${liveView.profile}`)
  if (liveView?.authority) {
    lines.push(`authority: ${formatAuthorityLabel(liveView.authority, liveView.authorityReason)}`)
  }
  const statusLineParts: string[] = []
  statusLineParts.push(`status: ${liveView?.status ?? 'unknown'}`)
  if (liveView?.elapsedMs !== undefined) {
    const sec = Math.floor(liveView.elapsedMs / 1000)
    statusLineParts.push(`elapsed: ${sec}s`)
  }
  lines.push(statusLineParts.join(' · '))

  // ── 契约摘要（首条 running 事件携带） ──
  if (liveView?.contract) {
    const c = liveView.contract
    lines.push('')
    lines.push('── Contract ──')
    lines.push(`objective: ${truncate(c.objective)}`)
    lines.push(`profile: ${c.profile} · tools: ${c.allowedToolsDigest}`)
    if (c.authority) lines.push(`authority: ${formatAuthorityLabel(c.authority, c.authorityReason)}`)
    lines.push(`budget: ${c.budget.maxTurns} turns · ${Math.floor(c.budget.timeoutMs / 1000)}s timeout`)
    if (c.scope.files?.length) {
      lines.push(`scope: ${c.scope.files.slice(0, 5).join(', ')}${c.scope.files.length > 5 ? ` +${c.scope.files.length - 5}` : ''}`)
    }
  }

  // ── 活动日志 ──
  if (liveView?.activityLog && liveView.activityLog.length > 0) {
    lines.push('')
    lines.push('── Activity ──')
    for (const entry of liveView.activityLog) {
      lines.push(`  ${entry}`)
    }
  }

  // ── 持久化结果 ──
  const result = loadPersistedResult(workerId)
  if (result) {
    lines.push('')
    lines.push('── Result ──')
    lines.push(`status: ${result.status}`)
    if (result.model) lines.push(`model: ${result.model}`)
    if (result.provider) lines.push(`provider: ${result.provider}`)
    if (result.usage) lines.push(`usage: ${formatTokens(result.usage)}`)
    // 诚实标签（failureReason 驱动）
    const honesty = honestyLabel(result.failureReason, result.evidenceStatus)
    if (honesty) lines.push(`⚠ ${honesty}`)
    lines.push(`summary: ${truncate(result.summary)}`)
    if (result.findings && result.findings.length > 0) {
      lines.push(`findings: ${result.findings.length}`)
      for (const f of result.findings.slice(0, 5)) {
        const conf = f.confidence ? ` [${f.confidence}]` : ''
        lines.push(`  ·${conf} ${truncate(f.claim, 120)}`)
      }
      if (result.findings.length > 5) {
        lines.push(`  … +${result.findings.length - 5} more`)
      }
    }
    if (result.verification) {
      const v = result.verification
      const statusGlyph = v.status === 'passed' ? '✅' : v.status === 'failed' ? '❌' : '⚠'
      lines.push(`verification: ${statusGlyph} ${v.passed}/${v.passed + v.failed} passed · ${v.command}`)
    }
    if (result.nextActions && result.nextActions.length > 0) {
      lines.push('next actions:')
      for (const a of result.nextActions.slice(0, 5)) {
        lines.push(`  · ${truncate(a, 120)}`)
      }
    }
    if (result.changedFiles && result.changedFiles.length > 0) {
      lines.push('changed files:')
      for (const f of result.changedFiles.slice(0, 20)) {
        lines.push(`  · ${f}`)
      }
      if (result.changedFiles.length > 20) {
        lines.push(`  … +${result.changedFiles.length - 20} more`)
      }
    }
    if (result.artifacts && result.artifacts.length > 0) {
      lines.push('artifacts:')
      for (const a of result.artifacts) {
        lines.push(`  · [${a.kind}] ${a.title}`)
        lines.push(`    ${truncate(a.content, 200)}`)
      }
    }
    if (result.risks && result.risks.length > 0) {
      lines.push('risks:')
      for (const r of result.risks.slice(0, 10)) {
        lines.push(`  · ${r}`)
      }
    }
  }

  // ── 完整会话转录 ──
  const sessionId = `worker-${workerId.replace(/:/g, '-')}`
  const persist = new SessionPersist(sessionId, cwd)
  let transcriptText = ''
  try {
    const messages = persist.loadOai()
    transcriptText = formatOaiMessages(messages)
  } catch {
    transcriptText = '(worker transcript not available)'
  }

  if (transcriptText) {
    lines.push('')
    lines.push('── Transcript ──')
    lines.push(transcriptText)
  }

  const content = lines.join('\n')
  return {
    content,
    title: `Worker ${shortLabel}`,
    messages: parseScrollbackTranscript(content),
  }
}

/** 返回 worker 会话文件是否已落盘（用于 UI 判断是否可进入 detail）。 */
export function workerSessionExists(workerId: string, cwd: string): boolean {
  try {
    const sessionId = `worker-${workerId.replace(/:/g, '-')}`
    const persist = new SessionPersist(sessionId, cwd)
    return !!persist.getFilePath()
  } catch {
    return false
  }
}
