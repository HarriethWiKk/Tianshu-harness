/**
 * T9 格式化函数 — thinking 指示器。
 *
 * 纯函数，从 `thinking.tsx` 的渲染逻辑提取。
 */

import { color } from '../engine/ansi.js'
import { useAsciiGlyphs } from '../term-caps.js'
import type { RivetTheme } from '../theme.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'

export interface FormatThinkingInput {
  /** thinking 文本内容 */
  text: string
  /** 已用时间（毫秒） */
  elapsedMs: number
  /** 包含头部状态行（凝思中…）。默认 true。流式渲染时 spinner 已显示状态，可设 false。 */
  header?: boolean
  /** 展开正文内容。默认 false。 */
  expanded?: boolean
  /** 正文最大行数。默认 8。commit 时可加大。 */
  maxLines?: number
  /** 推理已完成（提交到 scrollback）。头部用过去式「✶ 已推理」而非进行时「◐ 凝思中…」。默认 false。 */
  done?: boolean
  /** 当前激活的星域 ID（如 qiming / changgeng / wenqu / tianshu 等） */
  domainId?: string
}

const DEFAULT_MAX_LINES = 8

/**
 * 格式化 thinking 指示器为 ANSI 行数组（星域符印与多层对比色）。
 */
export function formatThinking(input: FormatThinkingInput, theme: RivetTheme): string[] {
  if (!input.text) return []

  const lines: string[] = []
  const textLines = input.text.split('\n').filter(l => l.trim().length > 0)
  const useAscii = useAsciiGlyphs()

  // ── 获取当前星域元数据与符印 ──────────────────────────────────
  const domainId = input.domainId ?? 'tianshu'
  const domain = starDomainRegistry.get(domainId) ?? starDomainRegistry.get('tianshu')
  
  // 兜底用 ◇（「未定/自定义域」的中性符，与 glance-bar 的自定义域展示同口径），
  // 不用 ✦——那是品牌星，星域缺失时打一颗品牌星是语义污染。
  const rawGlyph = domain?.uiPersona?.glyph ?? '◇'
  const accentKey = domain?.uiPersona?.accent ?? 'primary'
  const accentColor = (theme as Record<string, any>)[accentKey] ?? theme.primary
  const domainName = domain?.name ?? '天枢'

  // ── Header line ─────────────────────────────────────────────
  if (input.header !== false) {
    if (input.done) {
      const secs = Math.round(input.elapsedMs / 1000)
      const glyphStr = useAscii ? '*' : rawGlyph
      const lineInfo = textLines.length > 0 ? ` · ${textLines.length} 行` : ''
      
      const headSymbol = color(glyphStr, accentColor, { bold: true })
      const headLabel = color(`${domainName}·已推理`, theme.secondary)
      const headMeta = color(` · ${secs}s${lineInfo}`, theme.dim)
      lines.push(`${headSymbol} ${headLabel}${headMeta}`)
    } else {
      const statusLabel = getThinkingStatus(input.elapsedMs)
      const lineInfo = textLines.length > 0 ? ` · ${textLines.length} 行` : ''
      const glyphStr = useAscii ? '~' : rawGlyph
      
      const headSymbol = color(glyphStr, accentColor, { bold: true })
      const headLabel = color(`${domainName}·${statusLabel}`, theme.primary)
      const headMeta = color(`${lineInfo}`, theme.dim)
      lines.push(`${headSymbol} ${headLabel}${headMeta}`)
    }
  }

  // ── Content lines (保留最新 maxLines 行的 tail，带淡色树脉前缀) ─
  if (input.expanded && textLines.length > 0) {
    const max = input.maxLines ?? DEFAULT_MAX_LINES
    const prefix = color('│ ', theme.dim)
    if (textLines.length > max) {
      lines.push(`${prefix}${color(`… 上方省略 ${textLines.length - max} 行`, theme.dim)}`)
    }
    for (const line of textLines.slice(-max)) {
      lines.push(`${prefix}${color(line, theme.muted)}`)
    }
  }

  return lines
}

function getThinkingStatus(elapsedMs: number): string {
  const s = Math.round(elapsedMs / 1000)
  if (s < 30) return `凝思中… ${s}s`
  if (s < 90) return `融汇上下文… ${s}s`
  if (s < 180) return `深沉长考中… ${s}s`
  return `长考中 — Ctrl+C 终止 (${Math.floor(s / 60)}m)`
}
