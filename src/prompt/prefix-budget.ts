/**
 * 前缀预算度量 — 把 frozen 前缀拆成可归因的块，回答「注意力花在哪」。
 *
 * 纯聚合 + 格式化，不做采集：CLI（scripts/prefix-budget.ts）从磁盘与
 * ToolRegistry 组装 parts，TUI 从活动 PromptEngine 组装 parts，两边共用同一
 * 报告口径。这样 prompt 层不需要反向依赖 tools 层。
 *
 * 分类语义与 block-policy 的三分法一致：
 * - brake     行为护栏。profile 永不影响（撤成按需召回会漂移，见 V3.1 回归）。
 * - reference 查询资料。lean 档下缩减或关闭，都有 recall 通道兜底。
 * - tools     工具 schema。非护栏，compact 档可压缩。
 * - appendix  每轮动态区，不进 frozen 前缀，列出仅供对照。
 */

export type BlockCategory = 'brake' | 'reference' | 'tools' | 'appendix'

/** 采集侧传入的原始块。content 为空/undefined 的块会被丢弃。 */
export interface BudgetInput {
  name: string
  category: BlockCategory
  content: string | undefined
  /** 该块的字符上限（truncateBlock 的 cap）。仅用于展示「原始 → 截断后」。 */
  cap?: number
  /** 截断前的原始尺寸。给出时报告会标注被砍掉多少。 */
  rawChars?: number
}

export interface BudgetPart {
  name: string
  category: BlockCategory
  chars: number
  tokens: number
  cap?: number
  rawChars?: number
}

export interface PrefixBudgetReport {
  /** 按字符数降序。 */
  parts: BudgetPart[]
  byCategory: Record<BlockCategory, number>
  totalChars: number
  totalTokens: number
}

/** 项目统一 token 估算口径（见 context/rounds.ts、payload-diagnostic.ts）。
 *  中文密集内容会低估，跨块对比时口径一致即可。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function buildBudgetReport(inputs: readonly BudgetInput[]): PrefixBudgetReport {
  const parts: BudgetPart[] = []
  for (const input of inputs) {
    if (!input.content) continue
    parts.push({
      name: input.name,
      category: input.category,
      chars: input.content.length,
      tokens: estimateTokens(input.content),
      cap: input.cap,
      rawChars: input.rawChars,
    })
  }
  parts.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))

  const byCategory: Record<BlockCategory, number> = {
    brake: 0,
    reference: 0,
    tools: 0,
    appendix: 0,
  }
  for (const p of parts) byCategory[p.category] += p.chars

  // frozen 总量不含 appendix —— appendix 每轮重算，不属于前缀。
  const totalChars = parts
    .filter(p => p.category !== 'appendix')
    .reduce((sum, p) => sum + p.chars, 0)

  return {
    parts,
    byCategory,
    totalChars,
    totalTokens: estimateTokens('x'.repeat(totalChars)),
  }
}

const CATEGORY_LABEL: Record<BlockCategory, string> = {
  brake: '护栏',
  reference: '参考',
  tools: '工具',
  appendix: '动态',
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '  0.0%'
  return `${((part / whole) * 100).toFixed(1).padStart(5)}%`
}

/** 渲染为等宽终端表格。CLI 与 TUI /prefix-budget 共用。 */
export function formatBudgetReport(report: PrefixBudgetReport): string {
  const lines: string[] = []
  const { totalChars, totalTokens } = report

  lines.push(`前缀预算  ${totalChars} 字符  ~${totalTokens} token（不含动态 appendix）`)
  lines.push('─'.repeat(76))
  lines.push(`${'块'.padEnd(30)} ${'类别'.padEnd(5)} ${'字符'.padStart(7)} ${'token'.padStart(7)} ${'占比'.padStart(6)}`)
  lines.push('─'.repeat(76))

  for (const p of report.parts) {
    const share = p.category === 'appendix' ? '     —' : pct(p.chars, totalChars)
    let row = `${p.name.padEnd(30)} ${CATEGORY_LABEL[p.category].padEnd(5)} ${String(p.chars).padStart(7)} ${String(p.tokens).padStart(7)} ${share}`
    if (p.rawChars !== undefined && p.rawChars > p.chars) {
      const cut = (((p.rawChars - p.chars) / p.rawChars) * 100).toFixed(0)
      row += `  (原始 ${p.rawChars}，截掉 ${cut}%)`
    } else if (p.cap !== undefined) {
      row += `  (cap ${p.cap})`
    }
    lines.push(row)
  }

  lines.push('─'.repeat(76))
  const cats: BlockCategory[] = ['brake', 'reference', 'tools', 'appendix']
  const summary = cats
    .filter(c => report.byCategory[c] > 0)
    .map(c => `${CATEGORY_LABEL[c]} ${report.byCategory[c]}`)
    .join('   ')
  lines.push(summary)

  return lines.join('\n')
}
