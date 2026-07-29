/**
 * act / extract / observe —— 自然语言驱动的浏览器原语（路径 A：无侧路 LLM 调用）。
 *
 * 与 Stagehand 的取舍差异必须说清楚：Stagehand 在工具内部调一次小模型把描述变成
 * selector，省掉主模型"取全量 DOM → 算 selector → 点"的三次往返。这里不引侧路
 * 调用，所以定位是**启发式**的（见 locator.ts）——省下的是 DOM 快照的 token，
 * 换来的是命中率不如 LLM 定位。
 *
 * 因此三条纪律：
 * - 把握不足绝不动手，回候选清单让主模型选（act）
 * - extract / observe 不假装自己会"理解"，只负责把页面裁到相关区域交给主模型
 * - 工具描述里如实写"启发式"，别让模型以为这是语义级定位
 */

import {
  CANDIDATE_SCRIPT,
  formatCandidates,
  parseCandidates,
  parseLocatorQuery,
  resolveCandidates,
  type ActionKind,
  type ElementCandidate,
} from './locator.js'

/** act 需要的驱动能力子集——只依赖这几个方法，便于用假驱动做单测。 */
export interface ActDriver {
  evaluate(expression: string): Promise<string>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  press(selector: string | undefined, key: string): Promise<void>
  selectOption(selector: string, value: string): Promise<string[]>
  hover(selector: string): Promise<void>
  snapshot(selector?: string): Promise<string>
}

export interface ActInput {
  /** 自然语言指令，如 "点击登录按钮"。 */
  instruction: string
  /** type/select 要写入的值。 */
  value?: string
  /** 显式指定动作；不给则从措辞推断，推不出按 click。 */
  action?: ActionKind
  /** type 后是否回车提交。 */
  submit?: boolean
}

export interface ActOutcome {
  content: string
  isError?: boolean
  /** 与 ToolResult 同名同义——截断时置 'truncated'，让上游知道结果有损。 */
  lossiness?: 'truncated'
}

/** 候选枚举 —— 单独抽出来，act 与 observe 共用。 */
export async function enumerateCandidates(driver: ActDriver): Promise<ElementCandidate[]> {
  return parseCandidates(await driver.evaluate(CANDIDATE_SCRIPT))
}

/**
 * 自然语言 → 定位 → 执行。定位不确定时**不执行**，把候选清单交回模型。
 */
export async function act(driver: ActDriver, input: ActInput): Promise<ActOutcome> {
  const instruction = input.instruction?.trim()
  if (!instruction) return { content: 'act 需要 "instruction"（如 "点击登录按钮"）。', isError: true }

  const query = parseLocatorQuery(instruction)
  const action: ActionKind = input.action ?? query.action ?? 'click'

  if ((action === 'type' || action === 'select') && input.value === undefined) {
    return { content: `act 的 ${action} 需要 "value"。`, isError: true }
  }

  const candidates = await enumerateCandidates(driver)
  const resolved = resolveCandidates(candidates, query)

  if (resolved.kind === 'none') {
    return {
      content:
        `act 未能定位「${instruction}」——启发式匹配没有足够接近的元素。\n`
        + `页面可交互元素（按匹配度）：\n${formatCandidates(resolved.candidates)}\n`
        + '请从上面挑一个 selector 直接用 click/type，或换更接近页面原文的措辞重试。',
      isError: true,
    }
  }

  if (resolved.kind === 'ambiguous') {
    return {
      content:
        `act 认为「${instruction}」有多个同样像的目标，没有动手（点错有副作用）：\n`
        + `${formatCandidates(resolved.candidates)}\n`
        + '请指定 selector 用 click/type，或把描述写得更能区分（如带上所在区块的文案）。',
      isError: true,
    }
  }

  const { candidate, score, runnerUp } = resolved
  const confidence = `匹配度 ${score.toFixed(2)}（次名 ${runnerUp.toFixed(2)}）`
  const label = candidate.text || candidate.ariaLabel || candidate.placeholder || candidate.selector

  switch (action) {
    case 'click':
      await driver.click(candidate.selector)
      return { content: `已点击「${label}」（${candidate.selector}）。${confidence}` }
    case 'type': {
      await driver.type(candidate.selector, input.value!)
      if (input.submit) await driver.press(candidate.selector, 'Enter')
      return {
        content: `已向「${label}」（${candidate.selector}）输入文本${input.submit ? '并回车' : ''}。${confidence}`,
      }
    }
    case 'select': {
      const picked = await driver.selectOption(candidate.selector, input.value!)
      return { content: `已在「${label}」（${candidate.selector}）选中 ${picked.join(', ') || input.value}。${confidence}` }
    }
    case 'hover':
      await driver.hover(candidate.selector)
      return { content: `已悬停「${label}」（${candidate.selector}）。${confidence}` }
  }
}

/** extract / observe 交回主模型的文本上限——比 snapshot 的 20K 收紧，这两个原语
 *  的价值就在"只给相关的那部分"。 */
export const PRIMITIVE_TEXT_MAX = 6_000

export interface ExtractInput {
  /** 自然语言 schema，如 "所有商品名和价格"。 */
  schema: string
  /** 限定区域的 CSS selector，给了就只取这块。 */
  selector?: string
}

/**
 * 页面 → 结构化数据。路径 A 下**不在工具内解析**——工具负责把页面裁到相关区域、
 * 连同 schema 一起交回主模型，由模型输出结构化结果。
 *
 * 这层薄封装仍有价值：省掉模型自己写 selector 取 DOM 的往返，且把"要什么"和
 * "页面是什么"放在同一条工具结果里，模型不需要跨轮拼装。
 */
export async function extract(driver: ActDriver, input: ExtractInput): Promise<ActOutcome> {
  const schema = input.schema?.trim()
  if (!schema) return { content: 'extract 需要 "schema"（如 "所有商品名和价格"）。', isError: true }

  const text = await driver.snapshot(input.selector)
  const body = text.trim()
  if (!body) {
    return {
      content: `extract 目标区域没有文本${input.selector ? `（selector: ${input.selector}）` : ''}——`
        + '页面可能还没渲染完（先 wait），或内容在 iframe / canvas 里（snapshot 取不到）。',
      isError: true,
    }
  }

  const trimmed = body.slice(0, PRIMITIVE_TEXT_MAX)
  return {
    content:
      `extract 要提取的是：${schema}\n`
      + `${input.selector ? `区域 ${input.selector} 的` : '页面'}文本如下，请据此输出结构化结果`
      + '（注意：本工具只负责取文本，不做解析——解析由你完成）：\n\n'
      + trimmed
      + (body.length > PRIMITIVE_TEXT_MAX ? '\n…（已截断，需要更多请用 selector 缩小区域）' : ''),
    ...(body.length > PRIMITIVE_TEXT_MAX ? { lossiness: 'truncated' as const } : {}),
  }
}

export interface ObserveInput {
  /** 自然语言问题，如 "页面有没有错误提示"。 */
  question: string
}

/**
 * 页面 → 回答依据。同样不在工具内推断，交回的是"可交互元素清单 + 页面文本"，
 * 让主模型自己回答问题。
 *
 * 相比裸 snapshot 的增量：附上结构化的可交互元素清单（含 selector），模型看完
 * 就能直接接 act/click，不用再单独枚举一次。
 */
export async function observe(driver: ActDriver, input: ObserveInput): Promise<ActOutcome> {
  const question = input.question?.trim()
  if (!question) return { content: 'observe 需要 "question"（如 "页面有没有错误提示"）。', isError: true }

  const candidates = await enumerateCandidates(driver)
  const interactive = candidates.filter((c) => c.visible)
  const text = (await driver.snapshot()).trim()
  const trimmed = text.slice(0, PRIMITIVE_TEXT_MAX)

  return {
    content:
      `observe 的问题：${question}\n\n`
      + `可交互元素（${interactive.length} 个，含 selector 可直接接 act/click）：\n`
      + `${formatCandidates(interactive.map((candidate) => ({ candidate, score: 0 })), { showScore: false })}\n\n`
      + `页面文本：\n${trimmed}`
      + (text.length > PRIMITIVE_TEXT_MAX ? '\n…（已截断）' : '')
      + '\n\n（本工具只负责取证，判断由你完成。）',
    ...(text.length > PRIMITIVE_TEXT_MAX ? { lossiness: 'truncated' as const } : {}),
  }
}
