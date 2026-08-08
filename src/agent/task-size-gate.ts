/**
 * Task Size Gate: classify objective text to prevent small tasks from
 * triggering heavy parallel orchestration (team_orchestrate).
 *
 * Inspired by OMC's task-size-detector — but adapted for Chinese + English
 * mixed input and with an escape hatch prefix.
 */

export type OrchestrationScale = 'small' | 'medium' | 'large'

// Four-tier complexity mapped from the research orchestration protocol §1
// (极简/中等/进阶/复杂): simple↔极简, moderate↔中等, advanced↔进阶,
// complex↔复杂. Only the 'large' scale is subdivided by COMPLEX_TASK_SIGNALS.
export type TaskComplexity = 'simple' | 'moderate' | 'advanced' | 'complex'

export interface ScaleResult {
  scale: OrchestrationScale
  complexity: TaskComplexity
  reason: string
  wordCount: number
  blocked: boolean
}

const SMALL_WORD_LIMIT = 10
// When word count is between SMALL_WORD_LIMIT and SMALL_SIGNAL_BOOST_LIMIT,
// a small-task signal confirms the task is genuinely small (not just terse).
const SMALL_SIGNAL_BOOST_LIMIT = 30

const ESCAPE_HATCH_RE = /^(force|quick|simple|tiny):\s*/i

const SMALL_TASK_SIGNALS: RegExp[] = [
  /\btypo\b/i,
  /\brename\b/i,
  /\bsingle\s+file\b/i,
  /\bone[\s-]liner?\b/i,
  /\bminor\s+(fix|change|update|tweak)\b/i,
  /\bspelling\b/i,
  /\bformat(ting)?\s+(this|the)\b/i,
  /\bquick\s+fix\b/i,
  /\bbump\s+version\b/i,
  /\badd\s+a?\s*comment\b/i,
  /\bwhitespace\b/i,
  /\bindentation\b/i,
]

const LARGE_TASK_SIGNALS: RegExp[] = [
  /\barchitect(ure|ural)?\b/i,
  /\brefactor\b/i,
  /\bmigrat(e|ion)\b/i,
  /\bcross[\s-]cutting\b/i,
  /\bentire\s+(codebase|project|system)\b/i,
  /\bmultiple\s+(files|modules|components)\b/i,
  /\bsystem[\s-]wide\b/i,
  /\bend[\s-]to[\s-]end\b/i,
  /\boverhaul\b/i,
  /\bcomprehensive\b/i,
  // 中文等价信号（与上方英文一一映射；中文没有 \b 单词边界，直接按字面匹配）：
  // 架构↔architect、重构↔refactor、迁移↔migrate、跨模块↔cross-cutting、
  // 整个系统↔entire system、多个模块↔multiple modules、系统级↔system-wide、
  // 端到端↔end-to-end、全面↔comprehensive、穷尽↔exhaustive（研究类大任务）
  /架构/,
  /重构/,
  /迁移/,
  /跨模块|跨服务|跨系统/,
  /整个\s*(系统|项目|代码库|仓库)/,
  /多个\s*(文件|模块|组件|服务)/,
  /系统级|全局/,
  /端到端/,
  /全面/,
  /穷尽/,
]

// Complex-task signals from the research orchestration protocol §1 four-level
// definition of "复杂" (跨实体类型交叉验证、多跳链、穷尽覆盖、语义过滤).
// A 'large' task hitting one of these upgrades from 'advanced' to 'complex'.
const COMPLEX_TASK_SIGNALS: RegExp[] = [
  /\bmulti[\s-]hop\b/i,
  /\bcross[\s-]referenc(e|ing|es)\b/i,
  /\bexhaustive\b/i,
  /\bcomprehensive\b/i,
  /\bdeep[\s-]dive\b/i,
  /跨实体/,
  /多跳/,
  /穷尽/,
  /交叉验证/,
]

/**
 * Count "words" in mixed Chinese/English text.
 * English words split on whitespace. Chinese characters counted in pairs
 * (2 chars = 1 word) so short Chinese phrases aren't under-counted.
 */
function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  // Extract CJK characters (common ranges) and non-CJK word segments
  const cjkChars = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length
  const nonCjkText = trimmed.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
  const nonCjkWords = nonCjkText.split(/\s+/).filter(w => w.length > 0).length
  return nonCjkWords + Math.ceil(cjkChars / 2)
}

/**
 * Classify an objective string into small/medium/large scale.
 * Returns blocked:true when the task is too small for team_orchestrate.
 */
export function classifyOrchestrationScale(text: string): ScaleResult {
  // Escape hatch — explicit bypass
  if (ESCAPE_HATCH_RE.test(text)) {
    return {
      scale: 'medium',
      complexity: 'moderate',
      reason: 'escape hatch prefix — gate bypassed',
      wordCount: countWords(text),
      blocked: false,
    }
  }

  const wordCount = countWords(text)
  const smallSignal = SMALL_TASK_SIGNALS.find(r => r.test(text))
  const largeSignal = LARGE_TASK_SIGNALS.find(r => r.test(text))

  // Large signal takes priority (unless escape hatch, already handled)
  if (largeSignal) {
    const complexSignal = COMPLEX_TASK_SIGNALS.find(r => r.test(text))
    return {
      scale: 'large',
      complexity: complexSignal ? 'complex' : 'advanced',
      reason: complexSignal
        ? `large task signal: ${largeSignal.source}; complex signal: ${complexSignal.source}`
        : `large task signal: ${largeSignal.source}`,
      wordCount,
      blocked: false,
    }
  }

  // Small signal confirms smallness for terse-to-moderate text
  if (smallSignal && wordCount <= SMALL_SIGNAL_BOOST_LIMIT) {
    return {
      scale: 'small',
      complexity: 'simple',
      reason: `Task appears small (${wordCount} words, signal: ${smallSignal.source}). Use inline execution instead of team_orchestrate.`,
      wordCount,
      blocked: true,
    }
  }

  // Very short text regardless of signals
  if (wordCount <= SMALL_WORD_LIMIT) {
    return {
      scale: 'small',
      complexity: 'simple',
      reason: `Task appears small (${wordCount} words). Use inline execution instead of team_orchestrate.`,
      wordCount,
      blocked: true,
    }
  }

  return {
    scale: 'medium',
    complexity: 'moderate',
    reason: `${wordCount} words`,
    wordCount,
    blocked: false,
  }
}
