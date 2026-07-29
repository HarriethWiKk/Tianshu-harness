/**
 * 启发式元素定位器 —— `act` 原语的底座。
 *
 * **这不是 AI 定位。** 自然语言描述在这里靠规则匹配落到元素上：页面侧枚举可交互
 * 元素及其可读标签，Node 侧纯函数打分排序。命中率不如侧路 LLM，所以两条纪律：
 *
 * 1. 分数不过线 → 不猜，返回候选清单让主模型自己选（`kind: 'none'`）
 * 2. 头名与次名咬得太近 → 判歧义，同样返回清单（`kind: 'ambiguous'`）
 *
 * 宁可把球传回模型，也不点错一个按钮——浏览器操作是有副作用的，猜错的代价
 * 远高于多一轮往返。
 */

/** 页面侧枚举出的一个候选元素。字段都是"人可读的标签面"，打分只看这些。 */
export interface ElementCandidate {
  /** 页面侧已验证唯一（`querySelectorAll(sel).length === 1`）的 CSS selector。 */
  selector: string
  tag: string
  role: string | null
  /** 可见文本，已折叠空白并截断。 */
  text: string
  ariaLabel: string | null
  placeholder: string | null
  value: string | null
  title: string | null
  name: string | null
  id: string | null
  /** input 的 type，非 input 为 null。 */
  type: string | null
  disabled: boolean
  visible: boolean
}

export type ActionKind = 'click' | 'type' | 'select' | 'hover'
export type ExpectedRole = 'button' | 'textbox' | 'link' | 'select'

export interface LocatorQuery {
  raw: string
  /** 措辞里带的动词意图（"点击…" / "输入…"）；没带则 null，由调用方给默认。 */
  action: ActionKind | null
  /** 措辞尾部的角色名词（"…按钮" / "…输入框"）推出的期望角色。 */
  expectRole: ExpectedRole | null
  /** 去掉动词与角色名词后剩下的标签词。 */
  terms: string[]
  /** 引号里的字面标签——用户显式给了准确文案，按精确匹配对待。 */
  quoted: string | null
}

/**
 * 动词只在**开头**剥。中间出现的同形词很可能是标签本身的一部分
 * （"选择地点" 的 "选择" 是动词，"地点选择器" 的 "选择" 不是），
 * 位置约束比词表大小更能防误伤。
 */
const VERBS: ReadonlyArray<readonly [string, ActionKind]> = [
  ['点击', 'click'], ['单击', 'click'], ['按下', 'click'], ['按一下', 'click'],
  ['click', 'click'], ['tap', 'click'], ['press', 'click'],
  ['输入', 'type'], ['填写', 'type'], ['填入', 'type'], ['键入', 'type'],
  ['type', 'type'], ['fill', 'type'], ['enter', 'type'],
  ['选择', 'select'], ['选中', 'select'], ['select', 'select'], ['choose', 'select'],
  ['悬停', 'hover'], ['鼠标移到', 'hover'], ['hover', 'hover'],
]

/**
 * 角色名词只在**结尾**剥，同理防误伤（"登录按钮" vs "按钮组说明"）。
 *
 * 刻意不收单字"钮"——"按钮"会先被它吃掉一半，剩下的"按"变成假标签词去污染
 * 匹配。角色词表宁缺勿滥，漏判只是少一点加分，误判会把整条描述拆坏。
 */
const ROLE_NOUNS: ReadonlyArray<readonly [string, ExpectedRole]> = [
  ['按钮', 'button'], ['button', 'button'], ['btn', 'button'],
  ['输入框', 'textbox'], ['文本框', 'textbox'], ['输入栏', 'textbox'], ['文本域', 'textbox'],
  ['input', 'textbox'], ['textbox', 'textbox'], ['field', 'textbox'],
  ['链接', 'link'], ['超链接', 'link'], ['link', 'link'],
  ['下拉框', 'select'], ['下拉菜单', 'select'], ['选择框', 'select'],
  ['dropdown', 'select'], ['select', 'select'],
]

const STOPWORDS = new Set(['the', 'a', 'an', 'this', 'that', 'on', 'in', 'of', 'to', 'for', '的', '个', '这个', '那个'])

/** 归一：NFKC（全角→半角）+ 小写 + 折叠空白。标点保留，引号解析要用。 */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 比较用的更狠一档归一：连空白和常见标点一起去掉，跨中英标点差异对齐。 */
function compareKey(s: string): string {
  return normalizeText(s).replace(/[\s!-/:-@[-`{-~·—…、。！？，；：“”‘’（）【】]/g, '')
}

/**
 * 把 "点击登录按钮" 拆成 { action: 'click', expectRole: 'button', terms: ['登录'] }。
 *
 * 剥不掉动词/名词也不算失败——terms 退化为整条描述，仍能靠标签匹配打分。
 */
export function parseLocatorQuery(raw: string): LocatorQuery {
  let s = normalizeText(raw)

  const quotedMatch = s.match(/["'“”‘’]([^"'“”‘’]{1,80})["'“”‘’]/)
  const quoted = quotedMatch ? quotedMatch[1]!.trim() : null
  if (quoted) s = s.replace(quotedMatch![0], ' ').replace(/\s+/g, ' ').trim()

  let action: ActionKind | null = null
  for (const [word, kind] of VERBS) {
    if (s.startsWith(word)) {
      action = kind
      s = s.slice(word.length).trim()
      break
    }
  }

  // 名词剥完不能一无所剩——"按钮"这种整条就是角色名的描述，剥掉就没标签可匹配了。
  // 但引号已经给了准确标签时例外：残余的"点击…按钮"纯属脚手架，吃干净反而对。
  let expectRole: ExpectedRole | null = null
  for (const [word, role] of ROLE_NOUNS) {
    if (!s.endsWith(word)) continue
    if (s.length === word.length && !quoted) continue
    expectRole = role
    s = s.slice(0, s.length - word.length).trim()
    break
  }

  // 有引号 → 标签词只认引号内容。其余措辞是动词/角色/连接词，混进 terms 会
  // 变成"必须同时包含"的额外约束，把本来精确的匹配拖成部分命中。
  if (quoted) return { raw, action, expectRole, terms: [quoted], quoted }

  const terms = s
    .split(/[\s,，、]+/)
    .map((t) => t.replace(/^[的]+|[的]+$/g, '').trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))

  return { raw, action, expectRole, terms, quoted }
}

/** 候选的标签面，按可信度从高到低——同一个词命中 aria-label 比命中 id 更可信。 */
function labelFields(c: ElementCandidate): ReadonlyArray<readonly [string | null, number]> {
  return [
    [c.text, 1.0],
    [c.ariaLabel, 1.0],
    [c.placeholder, 0.9],
    [c.title, 0.8],
    [c.value, 0.7],
    [c.name, 0.5],
    [c.id, 0.4],
  ]
}

function roleOf(c: ElementCandidate): ExpectedRole | null {
  if (c.role === 'button' || c.tag === 'button') return 'button'
  if (c.tag === 'input' && (c.type === 'submit' || c.type === 'button' || c.type === 'reset')) return 'button'
  if (c.tag === 'textarea') return 'textbox'
  if (c.tag === 'input') return 'textbox'
  if (c.role === 'textbox') return 'textbox'
  if (c.tag === 'select') return 'select'
  if (c.tag === 'a') return 'link'
  if (c.role === 'link') return 'link'
  return null
}

export interface ScoredCandidate {
  candidate: ElementCandidate
  score: number
}

/**
 * 单个候选的匹配分。0 表示完全不沾。
 *
 * 分数只在同一次查询内可比——阈值是相对的（见 resolve 的 margin），不要把
 * 绝对值当"置信度"对外解释。
 */
export function scoreCandidate(c: ElementCandidate, q: LocatorQuery): number {
  if (!c.visible) return 0

  const terms = q.terms.map(compareKey).filter((t) => t.length > 0)
  let best = 0
  for (const [field, weight] of labelFields(c)) {
    if (!field) continue
    const key = compareKey(field)
    if (!key) continue
    let fieldScore = 0
    if (terms.length === 0) {
      // 没有标签词（如纯 "点击按钮"）——只靠角色分，标签面不贡献。
      fieldScore = 0
    } else if (terms.every((t) => key === t)) {
      fieldScore = 1
    } else if (terms.every((t) => key.includes(t))) {
      // 标签包含全部词：越短越可能是"就是它"（"登录" vs "登录后可查看历史"）。
      fieldScore = 0.85 - Math.min(0.25, (key.length - terms.join('').length) / 100)
    } else {
      const hit = terms.filter((t) => key.includes(t) || t.includes(key)).length
      if (hit > 0) fieldScore = 0.45 * (hit / terms.length)
    }
    best = Math.max(best, fieldScore * weight)
  }

  let score = best
  const role = roleOf(c)
  if (q.expectRole) {
    if (role === q.expectRole) score += 0.25
    else if (role !== null) score -= 0.2
  }
  // 动词也是弱角色信号：说"输入"就该落到可输入的东西上。
  if (q.action === 'type' && role !== 'textbox') score -= 0.15
  if (q.action === 'select' && role !== 'select') score -= 0.1
  if (c.disabled) score -= 0.3

  return Math.max(0, score)
}

export type LocateResult =
  | { kind: 'match'; candidate: ElementCandidate; score: number; runnerUp: number }
  | { kind: 'ambiguous'; candidates: ScoredCandidate[] }
  | { kind: 'none'; candidates: ScoredCandidate[] }

/** 过线门槛与歧义边界。调这两个数会直接改"猜"与"问"的比例。 */
export const LOCATOR_MIN_SCORE = 0.35
export const LOCATOR_AMBIGUITY_MARGIN = 0.12

/**
 * 排序 + 判定。永不在把握不足时返回单一结果——`ambiguous` / `none` 都带
 * 候选清单，调用方要把清单原样交给模型，而不是取第一个。
 */
export function resolveCandidates(
  candidates: ReadonlyArray<ElementCandidate>,
  query: LocatorQuery,
  opts: { minScore?: number; margin?: number; listCap?: number } = {},
): LocateResult {
  const minScore = opts.minScore ?? LOCATOR_MIN_SCORE
  const margin = opts.margin ?? LOCATOR_AMBIGUITY_MARGIN
  const listCap = opts.listCap ?? 8

  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, query) }))
    .sort((a, b) => b.score - a.score || a.candidate.selector.localeCompare(b.candidate.selector))

  const top = scored[0]
  if (!top || top.score < minScore) {
    return { kind: 'none', candidates: scored.filter((s) => s.score > 0).slice(0, listCap) }
  }
  const runnerUp = scored[1]?.score ?? 0
  if (top.score - runnerUp < margin) {
    return { kind: 'ambiguous', candidates: scored.filter((s) => s.score > 0).slice(0, listCap) }
  }
  return { kind: 'match', candidate: top.candidate, score: top.score, runnerUp }
}

/**
 * 候选清单的可读渲染——歧义/未命中时原样回给模型选。
 *
 * `showScore` 默认开：歧义场景下分数是模型判断"为什么难分"的依据。observe
 * 那种纯列举场景要关掉，否则一列 ~0.00 是纯噪声。
 */
export function formatCandidates(
  list: ReadonlyArray<ScoredCandidate>,
  opts: { showScore?: boolean } = {},
): string {
  if (list.length === 0) return '（页面上没有找到任何可交互元素）'
  const showScore = opts.showScore ?? true
  return list
    .map(({ candidate: c, score }) => {
      const label = c.text || c.ariaLabel || c.placeholder || c.value || c.name || c.id || '(无标签)'
      const flags = [c.disabled ? 'disabled' : null, roleOf(c)].filter(Boolean).join(' ')
      return `- ${c.selector}  «${label.slice(0, 60)}»${flags ? ` [${flags}]` : ''}`
        + (showScore ? `  ~${score.toFixed(2)}` : '')
    })
    .join('\n')
}

/**
 * 页面侧枚举脚本。返回 JSON **字符串**——driver.evaluate 对字符串原样透出，
 * 对对象会 pretty-print，走字符串这条路解析确定。
 *
 * 不改 DOM：selector 用 id / name / aria-label / data-testid 里第一个能验证
 * 唯一的，都不唯一才退化到 nth-of-type 路径。给页面塞临时 data 属性能省事，
 * 但那会触发页面自己的 MutationObserver / 属性选择器，调试工具不该有这种副作用。
 */
export const CANDIDATE_SCRIPT = `(() => {
  const CAP = 300;
  const sel = 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [onclick], [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(sel)).slice(0, CAP);
  const uniq = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  const q = (v) => JSON.stringify(String(v));
  const cssPath = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      if (cur.id && uniq('#' + CSS.escape(cur.id))) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const pick = (el) => {
    const cands = [];
    if (el.id) cands.push('#' + CSS.escape(el.id));
    const testid = el.getAttribute('data-testid');
    if (testid) cands.push('[data-testid=' + q(testid) + ']');
    const name = el.getAttribute('name');
    if (name) cands.push(el.tagName.toLowerCase() + '[name=' + q(name) + ']');
    const aria = el.getAttribute('aria-label');
    if (aria) cands.push(el.tagName.toLowerCase() + '[aria-label=' + q(aria) + ']');
    for (const c of cands) if (uniq(c)) return c;
    return cssPath(el);
  };
  const out = [];
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    out.push({
      selector: pick(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      value: 'value' in el && typeof el.value === 'string' ? el.value.slice(0, 120) : null,
      title: el.getAttribute('title'),
      name: el.getAttribute('name'),
      id: el.id || null,
      type: el.getAttribute('type'),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      visible: visible,
    });
  }
  return JSON.stringify(out);
})()`

/** 解析枚举脚本的输出。页面异常时给空数组而不是抛——调用方按"没找到"处理。 */
export function parseCandidates(raw: string): ElementCandidate[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c): c is ElementCandidate => typeof c?.selector === 'string' && c.selector.length > 0)
  } catch {
    return []
  }
}
