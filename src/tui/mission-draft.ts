/**
 * MissionDraft 解析（S4 数据层 v1）——把输入框原始文本解析为结构化任务草稿。
 *
 * 本轮只提供纯函数解析，不接 UI、不进 prompt；Contract 预览（Mission
 * Composer §13）待产品设计后以此为基础构建。
 *
 * 抽取规则：
 * - scope：@file:/@folder:/@symbol:/@codebase: 引用（mention-parser 协议）。
 * - criteria：`#标签`（验收条件候选，去重保序；``` 代码块内的 # 不抽取）。
 * - objective：剥离 mentions 与 #标签后的正文（连续空白折叠为单空格）。
 */

import { parseMentions, type MentionReference } from './mention-parser.js'

export interface MissionDraft {
  objective: string
  scope: MentionReference[]
  criteria: string[]
  rawText: string
}

const TAG_RE = /#([^\s#]+)/g

/** 剔除 ``` fence 代码块（其中的 # 注释不算验收标签）。 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
}

export function parseMissionDraft(text: string): MissionDraft {
  const scope = parseMentions(text)

  const noFence = stripFences(text)
  const criteria: string[] = []
  const seen = new Set<string>()
  for (const m of noFence.matchAll(TAG_RE)) {
    const tag = m[1]!
    if (!seen.has(tag)) {
      seen.add(tag)
      criteria.push(tag)
    }
  }

  // objective：去掉 mentions（mention-parser 的 strip 同口径）再去掉 #标签
  const withoutMentions = text.replace(/@(file|folder|symbol|codebase):(?:"([^"]+)"|([^\s]+))/g, ' ')
  const objective = stripFences(withoutMentions)
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return { objective, scope, criteria, rawText: text }
}

// ── Contract 预览（Mission Composer §13）────────────────────────────────

/** 长任务阈值：字符数 / 行数（简单短输入直通，不弹预览）。 */
export const CONTRACT_PREVIEW_MIN_CHARS = 400
export const CONTRACT_PREVIEW_MIN_LINES = 3

/**
 * 预览触发判定：任一命中——有 @引用（scope）/ 有 #验收标签（criteria）/
 * 长任务（>400 字符或 >3 行）。短自然语言直通零打扰。
 * 调用方豁免：斜杠命令、worker 视图、agent busy（steer 归并路径）。
 */
export function shouldPreviewContract(draft: MissionDraft, text: string): boolean {
  if (draft.scope.length > 0) return true
  if (draft.criteria.length > 0) return true
  if (text.length > CONTRACT_PREVIEW_MIN_CHARS) return true
  if (text.split('\n').length > CONTRACT_PREVIEW_MIN_LINES) return true
  return false
}

export interface ContractPreviewInput {
  draft: MissionDraft
  /** 展开 paste 标记后的原文字符数 */
  charCount: number
  imageCount: number
  /** exists 判定后不存在的 @file:/@folder: 路径（全部，非首个） */
  missingPaths: string[]
  cols: number
}

function truncatePlain(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/**
 * Contract 预览卡片（inline，与 formatApprovalPrompt 同形态——纯函数出行）。
 * 空段（无 scope/criteria/图片）对应行不渲染；/goal 提示行仅 criteria>0 出现。
 */
export function formatContractPreview(input: ContractPreviewInput, theme: { dim: string; warning: string; primary: string; muted: string; secondary?: string; success?: string; error?: string }, color: (t: string, c: string) => string): string[] {
  const { draft, charCount, imageCount, missingPaths, cols } = input
  const inner = Math.max(20, cols - 6)
  const lines: string[] = []

  const bColor = (s: string) => color(s, theme.primary)
  const succColor = (s: string) => color(s, theme.success || theme.primary)
  const secColor = (s: string) => color(s, theme.secondary || theme.primary)
  const errColor = (s: string) => color(s, theme.error || theme.dim)

  // 1. 醒目顶框：带有发光 Accent 边框与标题
  const titleStr = color('Mission Contract 预览', theme.primary)
  lines.push(`${bColor('╭─')} ${titleStr} ${bColor('─'.repeat(Math.max(2, inner - 22)) + '╮')}`)

  // 2. 目标段
  const objective = draft.objective || '（无文本目标，仅引用/附件）'
  const objWrapped = truncatePlain(objective, inner * 2 - 8)
  for (const [i, part] of objWrapped.split('\n').slice(0, 2).entries()) {
    lines.push(`${bColor('│')} ${i === 0 ? '目标  ' : '      '}${part}`)
  }

  // 3. 范围段
  if (draft.scope.length > 0) {
    const scopeStr = draft.scope
      .map(r => `@${r.type}:${r.value}`)
      .join(' · ')
    const missing = missingPaths.length > 0 ? color(`（⚠ ${missingPaths.length} 个路径不存在）`, theme.warning) : ''
    lines.push(`${bColor('│')} 范围  ${truncatePlain(scopeStr, inner - 24)}${missing}`)
  }

  // 4. 验收表达段
  if (draft.criteria.length > 0) {
    const critStr = draft.criteria.map(c => `#${c}`).join(' ')
    lines.push(`${bColor('│')} 验收  ${truncatePlain(critStr, inner - 8)}`)
  }

  // 5. 规模段
  const sizeBits = [`${charCount} 字符`, `${draft.rawText.split('\n').length} 行`]
  if (imageCount > 0) sizeBits.push(`附图 ${imageCount} 张`)
  lines.push(`${bColor('│')} 规模  ${sizeBits.join(' · ')}`)

  // 6. 提示段
  if (draft.criteria.length > 0) {
    lines.push(`${bColor('│')} ${color('提示  含验收条件 · 提交后可 /goal 创建持久目标', theme.muted)}`)
  }

  // 7. 醒目底栏操作按键行：高亮创建任务、返回编辑、取消
  const btnSubmit = succColor('⏎ 创建任务')
  const btnEdit = secColor('e 返回编辑')
  const btnCancel = errColor('Esc 取消')
  lines.push(`${bColor('│')} ${btnSubmit}   ${btnEdit}   ${btnCancel}`)

  // 8. 醒目底边框
  lines.push(`${bColor('╰' + '─'.repeat(Math.max(2, inner + 2)) + '╯')}`)

  return lines
}

