/**
 * Event payload redaction — shared by every producer of `SessionEvent`.
 *
 * Extracted from session-manager.ts so non-server producers (the TUI event tap)
 * can redact identically without importing a 4900-line class module into their
 * dependency graph.
 *
 * HARD CONSTRAINT: keep this a dependency-free LEAF, same discipline as
 * protocol.ts. Producers on both sides of the wire import it.
 */

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization)/i

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (!value || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child)
  }
  return redacted
}

export function redactText(text: string): string {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,'"]+/gi, `$1${REDACTED}`)
    // 裸密钥形态（无上下文关键词也遮）：sk- 族 / GitHub ghp_ 族 / AWS AKIA。
    // sk- 用 lookbehind 要求前导非字母数字，防 "desk-top1234567890" 类 prose 误伤。
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
}

/** Truncate by UTF-16 units without splitting a surrogate pair. */
export function truncateUtf16Safe(text: string, maxUnits: number): string {
  let units = 0
  let end = 0
  for (const point of text) {
    if (units + point.length > maxUnits) break
    units += point.length
    end += point.length
  }
  return text.slice(0, end)
}
