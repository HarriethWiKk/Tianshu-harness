/**
 * Lenient coercion helpers for tool input parameters.
 *
 * Model-provided tool arguments don't always match the declared schema types
 * (e.g. a numeric `count` arriving as "3"). These pure functions normalize an
 * `unknown` value to a sensible typed value — or `undefined` when the input is
 * unusable, letting the caller fall back to defaults or existing strict paths.
 */

/** number/boolean → String(v)；string 原样；其余 undefined。 */
export function lenientString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

/** number 且有限 → v；数字字符串（含 "3.5"）→ 解析；其余 undefined。 */
export function lenientNumber(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined
  }
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** lenientNumber 基础上要求 ≥1。 */
export function lenientPositiveNumber(v: unknown): number | undefined {
  const n = lenientNumber(v)
  return n !== undefined && n >= 1 ? n : undefined
}

/** "true"/"1"/"yes"/"True" → true；"false"/"0"/"no" → false；boolean 原样；其余 undefined。 */
export function lenientBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    switch (v.toLowerCase()) {
      case 'true':
      case '1':
      case 'yes':
        return true
      case 'false':
      case '0':
      case 'no':
        return false
    }
  }
  return undefined
}
