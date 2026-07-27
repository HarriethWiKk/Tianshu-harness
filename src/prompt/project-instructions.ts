/**
 * `<project-instructions>` 的按节选取。
 *
 * 此前的实现是 `escapeXml(md)` 后从头硬切到预算上限。对超预算的项目文档，
 * 这等于**按文档顺序**决定去留——而 AGENTS.md 一类文档的惯例恰好是先写目录索引
 * 与能力全景（给要自己找路的读者），把纪律与硬闸门写在末尾。本仓库的实测后果是
 * 「高危命令纪律 / Agent 安全保护 / 通用执行纪律」三节被整段切掉，主控和子代理
 * 都读不到自己的 git 提交纪律与高危命令闸门。
 *
 * 这里改成按节选取：预算不够时先丢参考类章节（表格为主的索引、全景矩阵），
 * 纪律类章节优先保住。被略去的章节留一条可见标记——agent 有 read_file，
 * 知道有东西被略去就能自己去读原文；静默截断则连"有东西没看到"都不知道。
 *
 * 判据全部是结构性或通用词表，不认任何仓库专有的标题名——它要处理的是任意项目
 * 的 AGENTS.md / .rivet.md。
 *
 * 纯函数，无 IO。
 */

/** 与 tools/description-compact.ts 同一张表：混在正文里的硬门禁措辞。 */
const HARD_GATE = /禁止|必须|不得|绝不|不能|NEVER|MUST|Do NOT|DO NOT/

/** 标题本身就宣告这是纪律/约定类章节。中英文都覆盖，命中即免于被丢。 */
const GATE_HEADING = /纪律|闸门|禁令|安全|规范|约定|守则|rule|convention|discipline|safety|security|polic/i

/** 表格行占比高于此值 → 判为参考类（目录索引、能力矩阵、数据布局表）。 */
const TABLE_HEAVY_RATIO = 0.4

/** 章节优先级。数字小的先保。 */
enum Tier {
  /** 硬门禁与纪律——主控事后补救不了，必须常驻。 */
  Gate = 0,
  /** 散文说明。 */
  Prose = 1,
  /** 表格为主的参考资料——agent 需要时能用 repo_map / read_file 查。 */
  Reference = 2,
}

export interface DocSection {
  /** 标题行原文；第一个标题之前的散文为 undefined。 */
  heading: string | undefined
  /** 标题去掉 `#` 与空白后的纯文本，用于略去标记。 */
  title: string
  /** 含标题行的整段原文（不含结尾换行）。 */
  text: string
  tier: Tier
}

export interface SelectionResult {
  /** 选中章节按原文顺序拼接的结果。 */
  text: string
  /** 被略去的章节标题，按原文顺序。 */
  omitted: string[]
}

function tableRatio(body: string): number {
  const lines = body.split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return 0
  return lines.filter(l => l.trimStart().startsWith('|')).length / lines.length
}

function classify(heading: string | undefined, body: string): Tier {
  // 表格判定在门禁词之前：索引表里偶然出现一个「必须」不该把整张表提到最高优先级。
  if (tableRatio(body) >= TABLE_HEAVY_RATIO) return Tier.Reference
  if (heading && GATE_HEADING.test(heading)) return Tier.Gate
  if (HARD_GATE.test(body)) return Tier.Gate
  return Tier.Prose
}

/**
 * 按 `#` / `##` 切分文档。
 *
 * `#` 也算边界，因为 project-instructions 是 AGENTS.md + .rivet.md 拼接的结果——
 * 只认 `##` 会让第二份文档的标题被吞进第一份的末节，两份文档的分界消失。
 * 更深的层级不拆：`###` 是节内结构，拆到那一层会让略去标记变成噪音。
 *
 * 第一个标题之前的散文（有的话）与文档首节同样按 Gate 处理——"这是什么项目"
 * 是所有后续判断的锚，丢了它其余章节都失去语境。
 */
export function splitSections(md: string): DocSection[] {
  const lines = md.split('\n')
  const headingAt: number[] = []
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    else if (!inFence && /^#{1,2}\s+/.test(line)) headingAt.push(i)
  })

  const out: DocSection[] = []
  const leadEnd = headingAt[0] ?? lines.length
  const lead = lines.slice(0, leadEnd).join('\n').trimEnd()
  if (lead.trim() !== '') {
    out.push({ heading: undefined, title: '(前言)', text: lead, tier: Tier.Gate })
  }
  headingAt.forEach((start, i) => {
    const end = headingAt[i + 1] ?? lines.length
    const heading = lines[start]!
    const body = lines.slice(start + 1, end).join('\n')
    const isDocTitle = /^#\s+/.test(heading)
    out.push({
      heading,
      title: heading.replace(/^#+\s*/, '').trim(),
      text: lines.slice(start, end).join('\n').trimEnd(),
      tier: isDocTitle ? Tier.Gate : classify(heading, body),
    })
  })
  return out
}

/**
 * 在 `budget` 字符内选出尽可能多的章节，优先级高的先占位，输出保持原文顺序。
 *
 * `measure` 让调用方按**渲染后**的长度计费（project-instructions 要经 escapeXml，
 * 转义膨胀在本仓库是 31%——按原文长度算会超预算）。缺省按原文长度。
 *
 * 预算连最高优先级的章节都装不下时，退回原来的行为：从头截断，让上层补截断标记。
 */
export function selectSections(
  sections: readonly DocSection[],
  budget: number,
  measure: (text: string) => number = t => t.length,
): SelectionResult {
  const sep = '\n\n'
  const sepCost = measure(sep)
  const chosen = new Set<DocSection>()
  let used = 0

  for (const tier of [Tier.Gate, Tier.Prose, Tier.Reference]) {
    for (const section of sections) {
      if (section.tier !== tier) continue
      const cost = measure(section.text) + (chosen.size > 0 ? sepCost : 0)
      if (used + cost > budget) continue
      chosen.add(section)
      used += cost
    }
  }

  const ordered = sections.filter(s => chosen.has(s))
  return {
    text: ordered.map(s => s.text).join(sep),
    omitted: sections.filter(s => !chosen.has(s)).map(s => s.title),
  }
}

/**
 * 选取 + 渲染略去标记。返回的文本尚未转义——调用方负责。
 *
 * 略去标记用 markdown 注释而非 XML 注释：这段文本随后会过 escapeXml，
 * XML 注释的尖括号会变成 `&lt;!--`，反而更吵。
 */
export function selectProjectInstructions(
  md: string,
  budget: number,
  measure?: (text: string) => number,
): SelectionResult {
  const sections = splitSections(md)
  const measured = measure ?? (t => t.length)
  if (measured(md) <= budget) return { text: md, omitted: [] }

  // 略去标记本身要占预算，否则加完就超。首轮按最坏情况（全部章节被略）预留，
  // 再用实际略去集重算一次把余量还回去——本仓库最坏与实际差约 800 字符。
  //
  // 二轮不保证更好：按序贪心对预算**不单调**（预算变大可能换进一个大章节、
  // 挤掉两个小的），略去集因此可能换成标题更长的一组，总长反而溢出。所以二轮
  // 只作为候选，装不下就退回首轮——首轮按最坏情况预留，恒定装得下。
  const sepCost = measured('\n\n')
  const reserve = (note: string) => budget - (note === '' ? 0 : measured(note) + sepCost)
  const first = selectSections(sections, reserve(renderNote(sections.map(s => s.title))), measured)
  const second = selectSections(sections, reserve(renderNote(first.omitted)), measured)
  const best = measured(render(second)) <= budget ? second : first

  // 预算连一节都装不下——退回调用方的整块截断，不在这里制造只剩标记的空块。
  if (best.text === '') return { text: md, omitted: [] }
  return { text: render(best), omitted: best.omitted }
}

function renderNote(omitted: readonly string[]): string {
  if (omitted.length === 0) return ''
  return `[本块超出前缀预算，已略去 ${omitted.length} 节：${omitted.join('、')}。需要时直接读 AGENTS.md / .rivet.md 原文。]`
}

function render(r: SelectionResult): string {
  return r.omitted.length === 0 ? r.text : `${r.text}\n\n${renderNote(r.omitted)}`
}
