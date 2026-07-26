/**
 * 工具描述压缩（prompt.toolDescriptions=compact）。
 *
 * 工具描述是操作手册，不是行为护栏——压缩它不会导致 V3.1 那类行为漂移。
 * 但描述里**确实混着**防误用的硬门禁（"绝不要把 … 当作 plan 传入"），
 * 砍掉那些行会让模型踩进已知陷阱。所以压缩规则是保留式而非提取式：
 *
 *   保留 = 首段总述 + 每个标题及其首行正文 + 所有含硬门禁词的行
 *   丢弃 = 举例、代码块、展开说明、边角场景枚举
 *
 * 「标题 + 首行」是有意的：标题定义工具的动作词汇表（`### Action: exit_mode`），
 * 只留标题会剩下一个模型不知道怎么用的空壳，连标题一起删则等于该 action
 * 从工具契约里消失。首行通常正是那句话的定义。
 *
 * 纯函数，无 IO。压缩后不比原文短时返回原文——省不下就别动，
 * 免得为了「压缩过了」反而增字节。
 */

/** 短描述不压——省不下几个字节，却增加读不懂的风险。 */
export const COMPACT_MIN_CHARS = 800

/** 命中即整行保留。用「包含」而非「开头」匹配：这类词多在句中出现，
 *  宁可多留一行，也不要漏掉一条防误用门禁。 */
const HARD_GATE = /禁止|必须|不要|不得|绝不|不能|NEVER|MUST|Do NOT|DO NOT/

const HEADING = /^\s{0,3}#{1,6}\s/
const FENCE = /^\s*```/

export type ToolDescriptionMode = 'full' | 'compact'

export function compactDescription(description: string): string {
  if (description.length <= COMPACT_MIN_CHARS) return description

  const lines = description.split('\n')
  const keep = new Array<boolean>(lines.length).fill(false)

  let leading = true
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (FENCE.test(line)) {
      // 代码块要么整块留要么整块丢。丢的时候连围栏一起丢，
      // 否则会留下孤立的 ``` 把后文吞进代码块。
      inFence = !inFence
      keep[i] = leading
      continue
    }
    if (inFence) {
      keep[i] = leading
      continue
    }

    if (leading) {
      keep[i] = true
      // 首段到第一个空行为止——总述说明「这个工具是干什么的」。
      if (line.trim() === '') leading = false
      continue
    }

    if (HEADING.test(line) || HARD_GATE.test(line)) keep[i] = true
  }

  // 每个标题带上首行正文——章节的定义句几乎总在这一行。
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING.test(lines[i]!) || !keep[i]) continue
    for (let j = i + 1; j < lines.length && !HEADING.test(lines[j]!); j++) {
      if (lines[j]!.trim() === '' || FENCE.test(lines[j]!)) continue
      keep[j] = true
      break
    }
  }

  // 兜底：标题下确实一条都没有（紧跟另一个标题、或章节只有代码块）时，
  // 空壳标题自己也是噪音。
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i] || !HEADING.test(lines[i]!)) continue
    let hasBody = false
    for (let j = i + 1; j < lines.length && !HEADING.test(lines[j]!); j++) {
      if (keep[j] && lines[j]!.trim() !== '') { hasBody = true; break }
    }
    if (!hasBody) keep[i] = false
  }

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue
    const line = lines[i]!
    // 折叠因丢行产生的连续空行
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1]!.trim() === '')) continue
    out.push(line)
  }

  const compacted = out.join('\n').trim()
  return compacted.length < description.length ? compacted : description
}

/**
 * 对一批工具定义应用描述档位。full 档原样返回（同一数组引用语义下的浅拷贝），
 * 保证 standard 会话逐字节不变。
 *
 * 必须在**所有**门控出口统一施加：构造期与 updateTools() 用的若不是同一变换，
 * MCP/LSP 异步注册后描述会回弹成 full → system 字节中途翻转 → 整段前缀缓存 miss。
 */
export function applyDescriptionMode<T extends { name: string; description?: string }>(
  defs: readonly T[],
  mode: ToolDescriptionMode | undefined,
): T[] {
  if (mode !== 'compact') return [...defs]
  return defs.map(d => {
    if (typeof d.description !== 'string') return d
    const compacted = compactDescription(d.description)
    return compacted === d.description ? d : { ...d, description: compacted }
  })
}
