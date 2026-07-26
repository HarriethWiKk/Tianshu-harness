/**
 * render-actions — 渲染动作序列（firecrawl actions 体系原生重写）。
 *
 * 登录墙、无限滚动、Tab 切换内容的通用解法：goto 完成（+ 水合等待）后按序
 * 执行动作，再取页面内容。约束与 firecrawl 同款：
 *   - 步数 ≤ 50
 *   - wait 类（ms 形式）总时长 ≤ 60s
 * 单步失败即中止——后续动作依赖前面步骤产生的页面状态。
 *
 * 安全面：动作在审批门内执行（web_fetch requiresApproval 恒 true，动作明细
 * 随调用呈现）；SSRF 逐请求拦截与 final URL 复检在动作期间持续生效。
 */
import type { PwPage } from '../net/playwright-driver.js'

export type RenderAction =
  | { type: 'wait'; ms: number }
  | { type: 'wait'; selector: string }
  | { type: 'click'; selector: string; all?: boolean }
  | { type: 'write'; selector: string; text: string }
  | { type: 'press'; key: string; selector?: string }
  | { type: 'scroll'; direction?: 'down' | 'up' | 'top' | 'bottom'; selector?: string }
  | { type: 'execute_js'; script: string }

export const MAX_ACTIONS = 50
export const MAX_TOTAL_WAIT_MS = 60_000
const ACTION_STEP_TIMEOUT_MS = 10_000
const EXECUTE_JS_RESULT_LIMIT = 2_048

export interface ActionResult {
  type: string
  ok: boolean
  /** execute_js 的返回值（JSON 化、截断 2K）或失败原因。 */
  detail?: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 校验并规范化工具入参的 actions 字段；任何一步非法整体拒绝（不启动渲染）。 */
export function parseRenderActions(raw: unknown): { actions: RenderAction[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'actions 必须是数组' }
  if (raw.length === 0) return { error: 'actions 不能为空数组' }
  if (raw.length > MAX_ACTIONS) return { error: `actions 步数超限（${raw.length} > ${MAX_ACTIONS}）` }

  let totalWaitMs = 0
  const actions: RenderAction[] = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as Record<string, unknown> | null
    if (!a || typeof a !== 'object') return { error: `actions[${i}] 不是对象` }
    switch (a.type) {
      case 'wait':
        if (typeof a.ms === 'number') {
          if (!Number.isFinite(a.ms) || a.ms <= 0 || a.ms > MAX_TOTAL_WAIT_MS) {
            return { error: `actions[${i}].ms 非法（须为 1..${MAX_TOTAL_WAIT_MS}）` }
          }
          totalWaitMs += a.ms
          actions.push({ type: 'wait', ms: a.ms })
        } else if (isNonEmptyString(a.selector)) {
          actions.push({ type: 'wait', selector: a.selector.trim() })
        } else {
          return { error: `actions[${i}] wait 需要 ms 或 selector` }
        }
        break
      case 'click':
        if (!isNonEmptyString(a.selector)) return { error: `actions[${i}].selector 不能为空` }
        actions.push({ type: 'click', selector: a.selector.trim(), all: a.all === true })
        break
      case 'write':
        if (!isNonEmptyString(a.selector)) return { error: `actions[${i}].selector 不能为空` }
        if (typeof a.text !== 'string') return { error: `actions[${i}].text 必须是字符串` }
        actions.push({ type: 'write', selector: a.selector.trim(), text: a.text })
        break
      case 'press':
        if (!isNonEmptyString(a.key)) return { error: `actions[${i}].key 不能为空` }
        actions.push({
          type: 'press',
          key: a.key.trim(),
          ...(isNonEmptyString(a.selector) ? { selector: a.selector.trim() } : {}),
        })
        break
      case 'scroll': {
        const dir = a.direction
        actions.push({
          type: 'scroll',
          direction: dir === 'up' || dir === 'top' || dir === 'bottom' ? dir : 'down',
          ...(isNonEmptyString(a.selector) ? { selector: a.selector.trim() } : {}),
        })
        break
      }
      case 'execute_js':
        if (!isNonEmptyString(a.script)) return { error: `actions[${i}].script 不能为空` }
        actions.push({ type: 'execute_js', script: a.script })
        break
      default:
        return { error: `actions[${i}] 未知类型：${String(a.type)}（支持 wait/click/write/press/scroll/execute_js）` }
    }
  }
  if (totalWaitMs > MAX_TOTAL_WAIT_MS) {
    return { error: `wait 总时长超限（${totalWaitMs}ms > ${MAX_TOTAL_WAIT_MS}ms）` }
  }
  return { actions }
}

async function scrollPage(page: PwPage, action: Extract<RenderAction, { type: 'scroll' }>): Promise<void> {
  if (action.selector) {
    await page.evaluate(
      `document.querySelector(${JSON.stringify(action.selector)})?.scrollIntoView({ block: 'center', inline: 'nearest' })`,
    )
    return
  }
  switch (action.direction) {
    case 'top':
      await page.evaluate('window.scrollTo(0, 0)')
      break
    case 'bottom':
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
      break
    case 'up':
      await page.evaluate('window.scrollBy(0, -window.innerHeight * 0.8)')
      break
    default:
      await page.evaluate('window.scrollBy(0, window.innerHeight * 0.8)')
  }
}

/** 按序执行动作；单步失败即中止并记录（ok:false + detail）。 */
export async function executeRenderActions(page: PwPage, actions: RenderAction[]): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'wait':
          if ('ms' in action) await new Promise((r) => setTimeout(r, action.ms))
          else await page.waitForSelector(action.selector, { timeout: ACTION_STEP_TIMEOUT_MS })
          results.push({ type: 'wait', ok: true })
          break
        case 'click':
          if (action.all) {
            // 全量点击走 DOM 原生 click（跳过 actionability 检查）
            await page.evaluate(
              `document.querySelectorAll(${JSON.stringify(action.selector)}).forEach((el) => el.click())`,
            )
          } else {
            await page.click(action.selector, { timeout: ACTION_STEP_TIMEOUT_MS })
          }
          results.push({ type: 'click', ok: true })
          break
        case 'write':
          await page.fill(action.selector, action.text, { timeout: ACTION_STEP_TIMEOUT_MS })
          results.push({ type: 'write', ok: true })
          break
        case 'press':
          if (action.selector) await page.press(action.selector, action.key, { timeout: ACTION_STEP_TIMEOUT_MS })
          else if (page.keyboard) await page.keyboard.press(action.key)
          results.push({ type: 'press', ok: true })
          break
        case 'scroll':
          await scrollPage(page, action)
          results.push({ type: 'scroll', ok: true })
          break
        case 'execute_js': {
          const value = await page.evaluate(action.script)
          let detail: string
          try {
            detail = JSON.stringify(value) ?? String(value)
          } catch {
            detail = String(value)
          }
          if (detail.length > EXECUTE_JS_RESULT_LIMIT) {
            detail = `${detail.slice(0, EXECUTE_JS_RESULT_LIMIT)}…（截断）`
          }
          results.push({ type: 'execute_js', ok: true, detail })
          break
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
      results.push({ type: action.type, ok: false, detail: msg })
      break
    }
  }
  return results
}
