/**
 * Screen-reader announcements — the first consumer of the Phase 2 event stream.
 *
 * WHAT THIS IS FOR: in screen-reader mode the live region's dynamic segment is
 * suppressed (see TuiApp.renderLiveImpl), because it repaints every 120ms and a
 * reader re-announces it endlessly. Everything the agent *says* still reaches
 * the static scrollback via blockWriter, and finished tool calls still commit as
 * cards — so those need no help here.
 *
 * What disappears with the dynamic segment is the *start* of an activity: a tool
 * call is only a pending entry in the live region until its result lands, so a
 * two-minute build would otherwise be total silence. These announcements fill
 * exactly that gap and nothing else — anything already committed statically must
 * return null, or the reader says it twice.
 *
 * Output is deliberately plain: no glyphs, no box characters, no color. Screen
 * readers pronounce decoration.
 */

import type { SessionEvent } from '../server/protocol.js'

/** Argument worth naming out loud, in the order we'd want to hear it. */
const PRIMARY_ARG_KEYS = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'prompt'] as const

const MAX_ARG_CHARS = 80

function primaryArg(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  for (const key of PRIMARY_ARG_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const flat = value.replace(/\s+/g, ' ').trim()
      return flat.length > MAX_ARG_CHARS ? `${flat.slice(0, MAX_ARG_CHARS)}…` : flat
    }
  }
  return null
}

/**
 * Render one event as a line to speak, or null when it should stay silent.
 *
 * Silent by design: text/thinking deltas (blockWriter commits them), tool
 * results (the tool card commits them), and every event whose only consumer is
 * a visual panel.
 */
export function formatEventForScreenReader(event: SessionEvent): string | null {
  switch (event.type) {
    case 'tool_use': {
      const name = typeof event.data.name === 'string' ? event.data.name : '未知工具'
      const arg = primaryArg(event.data.input)
      return arg ? `开始 ${name}：${arg}` : `开始 ${name}`
    }
    case 'approval_required': {
      const name = typeof event.data.toolName === 'string' ? event.data.toolName : '未知工具'
      const arg = primaryArg(event.data.input)
      // 按键必须念出来——审批提示行在动态段里，读屏档下用户看不到 y/n/e 提示。
      const what = arg ? `等待批准 ${name}：${arg}` : `等待批准 ${name}`
      return `${what}。按 y 批准，n 拒绝，e 编辑，Ctrl+E 解释风险`
    }
    case 'turn_complete':
      // Intermediate turns are just tool round-trips; only the final one is a
      // moment the user is waiting for.
      return event.data.isFinal === true ? '回合完成' : null
    case 'error': {
      const message = typeof event.data.error === 'string' ? event.data.error : '未知错误'
      return `出错：${message}`
    }
    case 'status':
      return event.data.status === 'aborted' ? '已中断' : null
    default:
      return null
  }
}
