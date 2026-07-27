/**
 * browser_debug — persistent browser for local frontend/backend联调 (CDP route).
 */

import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import { rivetHome } from '../../config/paths.js'
import {
  isHostAllowed,
  BROWSER_NAVIGATED_PREFIX,
  BROWSER_SCREENSHOT_OF_PREFIX,
} from '../browser.js'
import {
  getOrCreateSession,
  getSession,
  closeSession,
  resolveSessionKey,
  type BrowserDebugSession,
} from './session.js'
import {
  formatConsoleLine,
  formatNetworkLine,
  formatNetworkDetail,
  formatCookies,
  formatStorage,
  type ConsoleLevel,
  type NetworkQuery,
} from './log-capture.js'
import {
  DEFAULT_VIEWPORT,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  type BrowserDebugDriverFactory,
} from './driver.js'

export interface BrowserDebugToolOptions {
  driverFactory?: BrowserDebugDriverFactory
  allowlist?: () => string[]
  userDataDir?: () => string
  enabled?: boolean
}

const NAV_ACTIONS = new Set(['open', 'navigate'])
const CONSOLE_TAIL = 100
const NETWORK_TAIL = 100
const SNAPSHOT_MAX = 20_000

/** Above this the screenshot is left as a file reference only. Base64 inflates
 *  by a third and the payload rides in the conversation for the rest of the
 *  session, so an oversized shot costs far more than the look is worth. */
const SCREENSHOT_VISION_MAX_BYTES = 3_500_000

/** Reads width/height off the input. Either may be omitted — a caller sweeping
 *  responsive breakpoints cares about width and should not have to restate the
 *  height, so the missing side comes from `fallback` (the page's current size
 *  for a resize, the launch default for a fresh session). Returns undefined
 *  when neither was given. */
export function parseViewport(
  input: Record<string, unknown>,
  fallback: { width: number; height: number } = DEFAULT_VIEWPORT,
): { width: number; height: number } | { error: string } | undefined {
  const raw = { width: input.width, height: input.height }
  if (raw.width === undefined && raw.height === undefined) return undefined
  const read = (v: unknown, fallback: number, label: string): number | string => {
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      return `${label} 必须是整数 px。`
    }
    if (v < MIN_VIEWPORT || v > MAX_VIEWPORT) {
      return `${label} 超出范围（${MIN_VIEWPORT}–${MAX_VIEWPORT} px）。`
    }
    return v
  }
  const width = read(raw.width, fallback.width, 'width')
  if (typeof width === 'string') return { error: width }
  const height = read(raw.height, fallback.height, 'height')
  if (typeof height === 'string') return { error: height }
  return { width, height }
}

function envAllowlist(): string[] {
  return (process.env.RIVET_BROWSER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function defaultUserDataDir(): string {
  return join(rivetHome(), 'browser-debug-profile')
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')
}

export function isDebugHostAllowed(host: string, allowlist: string[]): boolean {
  return isLoopbackHost(host) || isHostAllowed(host, allowlist)
}

export function isLoopbackCdpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' && isLoopbackHost(u.hostname)
  } catch {
    return false
  }
}

export function isCdpUrlAllowed(raw: string, allowlist: string[]): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return false
    return isLoopbackHost(u.hostname) || isHostAllowed(u.hostname, allowlist)
  } catch {
    return false
  }
}

type BrowserDebugAction =
  | 'open'
  | 'navigate'
  | 'console'
  | 'network'
  | 'network_detail'
  | 'eval'
  | 'screenshot'
  | 'snapshot'
  | 'set_viewport'
  | 'click'
  | 'type'
  | 'press'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'history'
  | 'wait'
  | 'cookies'
  | 'storage'
  | 'set_cookie'
  | 'clear_cookies'
  | 'set_storage'
  | 'clear_storage'
  | 'pages'
  | 'await_login'
  | 'status'
  | 'clear_logs'
  | 'close'

function parseNavUrl(raw: string): { url: URL } | { error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: `无效 URL：${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `不支持的协议：${url.protocol}。仅允许 http/https。` }
  }
  return { url }
}

function resolveConnectUrl(input: Record<string, unknown>, action: string): string | undefined {
  const explicit = input.connect_url
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (action === 'open' && process.env.RIVET_BROWSER_URL?.trim()) {
    return process.env.RIVET_BROWSER_URL.trim()
  }
  return undefined
}

function sessionKeyFrom(params: ToolCallParams): string {
  return resolveSessionKey(params.sessionId)
}

async function withLiveLogs<T>(
  session: BrowserDebugSession,
  onOutput: ToolCallParams['onOutput'],
  fn: () => Promise<T>,
): Promise<T> {
  session.setOutputSink(onOutput ?? null)
  try {
    return await fn()
  } finally {
    session.setOutputSink(null)
  }
}

function safePageUrls(session: BrowserDebugSession): string[] {
  try {
    return session.driver.pageUrls()
  } catch {
    return [session.driver.currentUrl()]
  }
}

function formatStatus(session: BrowserDebugSession): string {
  const net = session.log.getNetwork()
  const failed = session.log.getNetwork({ failedOnly: true }).length
  const consoleTotal = session.log.getConsole().length
  const errCount = session.log.getConsole('error').length
  const urls = safePageUrls(session)
  const lines = [
    `会话：${session.sessionKey}`,
    `模式：${session.mode}${session.connectUrl ? `（${session.connectUrl}）` : ''}`,
    `无头：${session.headless}`,
    `url：${session.driver.currentUrl()}`,
    `页面：${urls.length} 个已打开${urls.length > 1 ? `（末个为活动）：${urls.join(' | ')}` : ''}`,
    `控制台：${consoleTotal} 条消息（${errCount} 条错误）`,
    `网络：${net.length} 条请求（${failed} 条失败/4xx/5xx）`,
  ]
  if (session.userDataDir) lines.push(`配置目录：${session.userDataDir}`)
  if (session.mode === 'connect') {
    lines.push('说明：close 会断开与 Chrome 的连接，但不会退出浏览器')
  }
  return lines.join('\n')
}

function buildNetworkQuery(input: Record<string, unknown>): NetworkQuery {
  return {
    failedOnly: input.failed_only === true,
    urlFilter: typeof input.url_filter === 'string' && input.url_filter.trim()
      ? input.url_filter.trim()
      : undefined,
    apiOnly: input.api_only === true,
  }
}

function formatNetworkResults(
  entries: ReturnType<BrowserDebugSession['log']['getNetwork']>,
  includeBody: boolean,
): string {
  return entries.map((e) => formatNetworkLine(e, includeBody)).join('\n')
}

export function createBrowserDebugTool(options: BrowserDebugToolOptions = {}): Tool {
  const driverFactory = options.driverFactory
  const allowlist = options.allowlist ?? envAllowlist
  const userDataDir = options.userDataDir ?? defaultUserDataDir
  const enabled = options.enabled ?? false

  async function ensureSession(
    sessionKey: string,
    headless: boolean,
    connectUrl?: string,
    viewport?: { width: number; height: number },
  ): Promise<BrowserDebugSession> {
    const session = await getOrCreateSession({
      sessionKey,
      headless,
      userDataDir: userDataDir(),
      connectUrl,
      driverFactory,
      viewport,
    })
    // Passing the viewport to the factory sizes a fresh launch without a resize
    // flash; applying it again covers the case where the session already
    // existed, so `open` with a size always lands on that size.
    if (viewport) await session.driver.setViewport(viewport.width, viewport.height).catch(() => {})
    return session
  }

  return {
    definition: {
      name: 'browser_debug',
      description: `驱动持久浏览器通过 CDP 调试本地 Web 应用（前后端 + API 联调）。

连接：
- 默认：有头 Chromium；登录态持留在 ~/.rivet/browser-debug-profile。
- 连接模式：open 时传 connect_url 或设 RIVET_BROWSER_URL（Chrome --remote-debugging-port=9222）。close 仅断开连接。

API 联调技巧：
- network {url_filter="/api/", failed_only=true, include_body=true, api_only=true} — 失败 API 调用含响应体。
- network_detail {request_id="r2"} — 单个请求完整详情（状态、耗时、响应体）。

操作：
- open / navigate {url}
- console {level?}
- network {failed_only?, url_filter?, api_only?, include_body?}
- network_detail {request_id} — 状态、耗时、请求头+载荷、响应头+响应体（Authorization/Cookie 等密钥已遮蔽）。
- snapshot / eval / screenshot / click
- screenshot — 视觉模型（或已配置的 vision 桥）会直接看到截图；改完 UI 用它自查，别只看 DOM。
- set_viewport {width?, height?} — 改视口验响应式断点；只给 width 时保留当前高度。
- type {selector, text, submit?} — submit=true 填完后按 Enter
- press {selector?, key} — 键盘按键，如 Enter/Tab/Escape/ArrowDown
- select {selector, value} — 选择 <select> 选项
- hover {selector} / scroll {selector? | to?}
- wait {selector? | state?} — 等待选择器可见，或载入状态（load/domcontentloaded/networkidle）
- history {go: back|forward|reload}
- cookies {url_filter?} — 列出上下文 cookie（值已遮蔽）
- storage {kind: local|session} — 导出 localStorage/sessionStorage（疑似密钥的值已遮蔽）
- set_cookie {name, value, url? | domain?+path?} — 注入 cookie（恢复登录态）
- clear_cookies — 清除所有 cookie（重置会话）
- set_storage {kind, key, value} / clear_storage {kind} — 写入/重置 Web Storage
- pages — 列出打开的标签页/弹窗（OAuth 弹窗自动成为操作目标）
- status / clear_logs / await_login / close`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'open', 'navigate', 'console', 'network', 'network_detail', 'eval', 'screenshot', 'snapshot',
              'click', 'type', 'press', 'select', 'hover', 'scroll', 'history', 'set_viewport',
              'wait', 'cookies', 'storage', 'pages',
              'set_cookie', 'clear_cookies', 'set_storage', 'clear_storage',
              'await_login', 'status', 'clear_logs', 'close',
            ],
            description: '要执行的操作。',
          },
          url: { type: 'string', description: 'open/navigate 的目标 URL。' },
          connect_url: { type: 'string', description: 'open 的 CDP 端点，如 http://127.0.0.1:9222。' },
          request_id: { type: 'string', description: 'network_detail：来自 network 输出的 id（如 r2）。' },
          url_filter: { type: 'string', description: 'network：请求 URL 子串过滤（如 /api/）。' },
          api_only: { type: 'boolean', description: 'network：仅 xhr/fetch 请求。' },
          include_body: { type: 'boolean', description: 'network：包含捕获的响应体（xhr/fetch 及 4xx/5xx）。' },
          selector: { type: 'string', description: 'click/type/press/select/hover/scroll/wait/snapshot 的 CSS 选择器。' },
          text: { type: 'string', description: 'type 要填入的文本。' },
          submit: { type: 'boolean', description: 'type：填完后按 Enter（提交表单）。' },
          key: { type: 'string', description: 'press：键盘按键（Enter/Tab/…）；set_storage：存储键名。' },
          value: { type: 'string', description: 'select 选项值 / set_cookie 值 / set_storage 值。' },
          state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'wait：等待的载入状态（无选择器时）。' },
          to: { type: 'string', enum: ['top', 'bottom'], description: 'scroll：无选择器时的页面目标（默认 bottom）。' },
          go: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'history：导航方向。' },
          kind: { type: 'string', enum: ['local', 'session'], description: 'storage/set_storage/clear_storage：哪个 Web Storage（默认 local）。' },
          name: { type: 'string', description: 'set_cookie：cookie 名称。' },
          domain: { type: 'string', description: 'set_cookie：cookie 域名（无 url 时配合 path 使用）。' },
          path: { type: 'string', description: 'set_cookie：cookie 路径（默认 /）。' },
          expression: { type: 'string', description: 'eval 的 JavaScript 表达式。' },
          level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'], description: '控制台日志级别过滤。' },
          failed_only: { type: 'boolean', description: 'network：仅失败和 4xx/5xx。' },
          headless: { type: 'boolean', description: '隐藏启动（默认 false）。' },
          width: { type: 'integer', description: 'set_viewport/open：视口宽度 px（默认 1280）。响应式断点问题只在特定宽度下暴露，改完 UI 至少验两个宽度。' },
          height: { type: 'integer', description: 'set_viewport/open：视口高度 px（默认 800）。' },
          timeout_ms: { type: 'integer', description: 'wait：超时毫秒数（默认 10000）。' },
          message: { type: 'string', description: 'await_login：展示给用户的提示。' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action as BrowserDebugAction
      const headless = params.input.headless === true
      const viewport = parseViewport(params.input)
      if (viewport && 'error' in viewport) return { content: viewport.error, isError: true }
      const connectUrl = resolveConnectUrl(params.input, action)
      const sessionKey = sessionKeyFrom(params)
      const signal = params.abortSignal

      if (action === 'close') {
        const session = getSession(sessionKey)
        if (!session) return { content: `会话 ${sessionKey} 没有打开的浏览器会话。` }
        const mode = session.mode
        await closeSession(sessionKey)
        return {
          content: mode === 'connect'
            ? `已断开与 Chrome 的连接（会话 ${sessionKey}，浏览器仍在运行）。`
            : `浏览器会话已关闭（${sessionKey}）。`,
        }
      }

      if (action === 'status') {
        const session = getSession(sessionKey)
        if (!session) return { content: `会话 ${sessionKey} 没有打开的浏览器会话。`, isError: true }
        return { content: formatStatus(session) }
      }

      if (action === 'await_login') {
        if (connectUrl && !isCdpUrlAllowed(connectUrl, allowlist())) {
          return {
            content: `browser_debug 已拦截：CDP 端点 "${connectUrl}" 不是回环地址且未在许可名单中。`,
            isError: true,
          }
        }
        try {
          const session = await ensureSession(sessionKey, headless, connectUrl)
          if (!headless) await session.driver.bringToFront().catch(() => {})
        } catch (err) {
          return { content: `browser_debug 打开失败：${(err as Error).message}`, isError: true }
        }
        const msg =
          (typeof params.input.message === 'string' && params.input.message.trim()) ||
          '请在浏览器窗口完成登录/手动步骤，然后回复以继续。'
        return {
          content: '[等待手动登录——用户完成后会回复。]',
          uiContent: `${msg}\n\n（OAuth 弹窗/新标签页会自动跟踪；持久化配置会为后续 browser_debug 操作保留登录态。）`,
          endTurn: true,
        }
      }

      if (NAV_ACTIONS.has(action)) {
        const rawUrl = params.input.url as string | undefined
        if (!rawUrl) return { content: `${action} 需要 "url"。`, isError: true }
        const parsed = parseNavUrl(rawUrl)
        if ('error' in parsed) return { content: parsed.error, isError: true }

        const list = allowlist()
        if (!isDebugHostAllowed(parsed.url.hostname, list)) {
          return {
            content:
              `browser_debug 已拦截：主机 "${parsed.url.hostname}" 不是回环地址且不在许可名单中（fail-closed）。` +
              (list.length === 0
                ? '当前仅 localhost 可访问——其他主机请设置 RIVET_BROWSER_ALLOWLIST。'
                : `已允许：${list.join(', ')}。`),
            isError: true,
          }
        }
        if (connectUrl && !isCdpUrlAllowed(connectUrl, list)) {
          return {
            content: `browser_debug 已拦截：CDP 端点 "${connectUrl}" 不是回环地址且未在许可名单中。`,
            isError: true,
          }
        }

        try {
          const session = await ensureSession(sessionKey, headless, connectUrl, viewport)
          await withLiveLogs(session, params.onOutput, () =>
            session.driver.goto(rawUrl, signal),
          )
          const finalUrl = session.driver.currentUrl()
          const netCount = session.log.getNetwork().length
          const errCount = session.log.getConsole('error').length
          const modeHint = session.mode === 'connect' ? '（已通过 CDP 连接）' : ''
          return {
            content:
              // URL 后用 ASCII `. ` 分隔——browser-mirror / walkthrough 的 \S+ 提取依赖此边界。
              `${BROWSER_NAVIGATED_PREFIX} ${finalUrl}${modeHint}. 已捕获 ${netCount} 条网络请求、${errCount} 条控制台错误。` +
              `使用 network 并设 url_filter="/api/" failed_only=true include_body=true 可查看 API 错误。`,
          }
        } catch (err) {
          return { content: `browser_debug 导航失败：${(err as Error).message}`, isError: true }
        }
      }

      const session = getSession(sessionKey)
      if (!session) {
        return {
          content: `会话 ${sessionKey} 没有打开的浏览器会话。请先用 action="open" 并提供 url。`,
          isError: true,
        }
      }

      try {
        switch (action) {
          case 'console': {
            const level = params.input.level as ConsoleLevel | undefined
            const entries = session.log.getConsole(level).slice(-CONSOLE_TAIL)
            if (entries.length === 0) return { content: '（无控制台输出）' }
            return { content: entries.map(formatConsoleLine).join('\n') }
          }
          case 'network': {
            const query = buildNetworkQuery(params.input)
            const includeBody = params.input.include_body === true
            const entries = session.log.getNetwork(query).slice(-NETWORK_TAIL)
            if (entries.length === 0) {
              return { content: query.failedOnly ? '（无匹配的失败请求）' : '（无匹配的网络活动）' }
            }
            return { content: formatNetworkResults(entries, includeBody) }
          }
          case 'network_detail': {
            const requestId = params.input.request_id as string | undefined
            if (!requestId) return { content: 'network_detail 需要 "request_id"。', isError: true }
            const entry = session.log.getByRequestId(requestId)
            if (!entry) {
              return { content: `没有 id 为 "${requestId}" 的请求。请先运行 action="network" 列出 id。`, isError: true }
            }
            return { content: formatNetworkDetail(entry) }
          }
          case 'clear_logs': {
            session.log.clear()
            return { content: '控制台与网络日志已清除。' }
          }
          case 'snapshot': {
            const selector = params.input.selector as string | undefined
            const text = await withLiveLogs(session, params.onOutput, () => session.driver.snapshot(selector))
            const trimmed = text.slice(0, SNAPSHOT_MAX)
            return {
              content: trimmed + (text.length > SNAPSHOT_MAX ? '\n…（已截断）' : ''),
              lossiness: text.length > SNAPSHOT_MAX ? 'truncated' : undefined,
            }
          }
          case 'eval': {
            const expression = params.input.expression as string | undefined
            if (!expression) return { content: 'eval 需要 "expression"。', isError: true }
            const result = await withLiveLogs(session, params.onOutput, () =>
              session.driver.evaluate(expression),
            )
            return { content: result.slice(0, SNAPSHOT_MAX) }
          }
          case 'click': {
            const selector = params.input.selector as string | undefined
            if (!selector) return { content: 'click 需要 "selector"。', isError: true }
            await withLiveLogs(session, params.onOutput, () => session.driver.click(selector))
            return { content: `已点击 ${selector}。` }
          }
          case 'type': {
            const selector = params.input.selector as string | undefined
            const text = params.input.text as string | undefined
            if (!selector || text === undefined) {
              return { content: 'type 需要 "selector" 和 "text"。', isError: true }
            }
            const submit = params.input.submit === true
            await withLiveLogs(session, params.onOutput, async () => {
              await session.driver.type(selector, text)
              if (submit) await session.driver.press(selector, 'Enter')
            })
            return { content: `已向 ${selector} 输入文本${submit ? '并按下 Enter' : ''}。` }
          }
          case 'press': {
            const selector = params.input.selector as string | undefined
            const key = params.input.key as string | undefined
            if (!key) return { content: 'press 需要 "key"（如 Enter、Tab、Escape）。', isError: true }
            await withLiveLogs(session, params.onOutput, () => session.driver.press(selector, key))
            return { content: selector ? `已在 ${selector} 上按下 ${key}。` : `已按下 ${key}。` }
          }
          case 'select': {
            const selector = params.input.selector as string | undefined
            const value = params.input.value as string | undefined
            if (!selector || value === undefined) {
              return { content: 'select 需要 "selector" 和 "value"。', isError: true }
            }
            const chosen = await withLiveLogs(session, params.onOutput, () =>
              session.driver.selectOption(selector, value),
            )
            return { content: `已在 ${selector} 中选择 ${JSON.stringify(chosen)}。` }
          }
          case 'hover': {
            const selector = params.input.selector as string | undefined
            if (!selector) return { content: 'hover 需要 "selector"。', isError: true }
            await withLiveLogs(session, params.onOutput, () => session.driver.hover(selector))
            return { content: `已悬停 ${selector}。` }
          }
          case 'scroll': {
            const selector = params.input.selector as string | undefined
            const to = params.input.to === 'top' ? 'top' : 'bottom'
            await withLiveLogs(session, params.onOutput, () => session.driver.scroll(selector, to))
            return { content: selector ? `已将 ${selector} 滚入视图。` : `已滚动到 ${to}。` }
          }
          case 'history': {
            const go = params.input.go as string | undefined
            if (go !== 'back' && go !== 'forward' && go !== 'reload') {
              return { content: 'history 需要 "go"：back | forward | reload。', isError: true }
            }
            if (go === 'reload') {
              await withLiveLogs(session, params.onOutput, () => session.driver.reload(signal))
              return { content: `已重新加载 ${session.driver.currentUrl()}。` }
            }
            const moved = await withLiveLogs(session, params.onOutput, () =>
              go === 'back' ? session.driver.goBack(signal) : session.driver.goForward(signal),
            )
            const goLabel = go === 'back' ? '后退' : '前进'
            return {
              content: moved
                ? `已${goLabel}至 ${session.driver.currentUrl()}。`
                : `没有可${goLabel}的历史记录。`,
            }
          }
          case 'wait': {
            const selector = params.input.selector as string | undefined
            const state = params.input.state as 'load' | 'domcontentloaded' | 'networkidle' | undefined
            const timeoutMs =
              typeof params.input.timeout_ms === 'number' && params.input.timeout_ms > 0
                ? params.input.timeout_ms
                : 10_000
            if (selector) {
              await withLiveLogs(session, params.onOutput, () =>
                session.driver.waitForSelector(selector, timeoutMs, signal),
              )
              return { content: `元素 "${selector}" 已可见（超时 ${timeoutMs}ms）。` }
            }
            if (state) {
              await withLiveLogs(session, params.onOutput, () =>
                session.driver.waitForLoadState(state, timeoutMs, signal),
              )
              return { content: `已到达载入状态 "${state}"（超时 ${timeoutMs}ms）。` }
            }
            return { content: 'wait 需要 "selector" 或 "state"（load/domcontentloaded/networkidle）。', isError: true }
          }
          case 'cookies': {
            const urlFilter = typeof params.input.url_filter === 'string' && params.input.url_filter.trim()
              ? params.input.url_filter.trim()
              : undefined
            const cookies = await withLiveLogs(session, params.onOutput, () => session.driver.cookies(urlFilter))
            return { content: formatCookies(cookies) }
          }
          case 'storage': {
            const kind = params.input.kind === 'session' ? 'session' : 'local'
            const record = await withLiveLogs(session, params.onOutput, () => session.driver.storage(kind))
            return { content: `${kind}Storage:\n${formatStorage(record)}` }
          }
          case 'set_cookie': {
            const name = params.input.name as string | undefined
            const value = params.input.value as string | undefined
            if (!name || value === undefined) {
              return { content: 'set_cookie 需要 "name" 和 "value"。', isError: true }
            }
            const url = typeof params.input.url === 'string' ? params.input.url : undefined
            const domain = typeof params.input.domain === 'string' ? params.input.domain : undefined
            const path = typeof params.input.path === 'string' ? params.input.path : undefined
            if (!url && !domain) {
              const current = (() => { try { return new URL(session.driver.currentUrl()).origin } catch { return undefined } })()
              if (!current) return { content: 'set_cookie 需要 "url" 或 "domain"（当前页面没有可用 URL）。', isError: true }
              await withLiveLogs(session, params.onOutput, () => session.driver.addCookie({ name, value, url: current }))
              return { content: `已为 ${current} 设置 cookie "${name}"。` }
            }
            await withLiveLogs(session, params.onOutput, () =>
              session.driver.addCookie({ name, value, url, domain, path: path ?? (domain ? '/' : undefined) }),
            )
            return { content: `已为 ${url ?? `${domain}${path ?? '/'}`} 设置 cookie "${name}"。` }
          }
          case 'clear_cookies': {
            await withLiveLogs(session, params.onOutput, () => session.driver.clearCookies())
            return { content: '已清除此上下文的全部 cookie。' }
          }
          case 'set_storage': {
            const kind = params.input.kind === 'session' ? 'session' : 'local'
            const key = params.input.key as string | undefined
            const value = params.input.value as string | undefined
            if (!key || value === undefined) {
              return { content: 'set_storage 需要 "key" 和 "value"。', isError: true }
            }
            await withLiveLogs(session, params.onOutput, () => session.driver.setStorage(kind, key, value))
            return { content: `已设置 ${kind}Storage["${key}"]。` }
          }
          case 'clear_storage': {
            const kind = params.input.kind === 'session' ? 'session' : 'local'
            await withLiveLogs(session, params.onOutput, () => session.driver.clearStorage(kind))
            return { content: `已清除 ${kind}Storage。` }
          }
          case 'pages': {
            const urls = safePageUrls(session)
            if (urls.length === 0) return { content: '（无打开的页面）' }
            const active = urls.length - 1
            return {
              content: urls
                .map((u, i) => `${i === active ? '* ' : '  '}[${i}] ${u}`)
                .join('\n'),
            }
          }
          case 'set_viewport': {
            // Re-parse against the live size so a width-only resize keeps the
            // height the page already has.
            const target = parseViewport(params.input, session.driver.viewportSize() ?? DEFAULT_VIEWPORT)
            if (!target) {
              return { content: 'set_viewport 需要 "width" 和/或 "height"（整数 px）。', isError: true }
            }
            if ('error' in target) return { content: target.error, isError: true }
            await session.driver.setViewport(target.width, target.height)
            return { content: `视口已设为 ${target.width}×${target.height}。重新截图或量 DOM 以查看该宽度下的布局。` }
          }
          case 'screenshot': {
            const png = await session.driver.screenshot()
            const base64 = png.toString('base64')
            let artifactId: string | undefined
            if (params.artifactStore) {
              const host = (() => {
                try {
                  return new URL(session.driver.currentUrl()).hostname
                } catch {
                  return 'page'
                }
              })()
              artifactId = await params.artifactStore.save({
                tool: 'browser_screenshot',
                target: `${host}-screenshot.png`,
                rawContent: base64,
                summary: `Screenshot of ${session.driver.currentUrl()}`,
                sections: [],
              })
            }
            // CLI 可见性：纯 ANSI 终端无法内联渲染截图——把 PNG 落成真实文件，
            // 结果尾注给出可直接打开的路径（桌面端仍走 artifact id 内联渲染）。
            let pngNote = ''
            if (artifactId) {
              const rawPath = params.artifactStore?.get?.(artifactId)?.rawPath
              if (rawPath) {
                const pngPath = rawPath.replace(/\.raw$/, '.png')
                try {
                  await writeFile(pngPath, png)
                  pngNote = `\n已保存：${pngPath}`
                } catch { /* 落盘失败不影响截图结果 */ }
              }
            }
            // Vision channel: hand the PNG to the pipeline, which forwards it
            // to a vision-capable model or routes it through the configured
            // vision bridge for a text-only one. Without this the model only
            // ever learned that a screenshot exists, never what was in it —
            // the loop stopped one step short of actually looking.
            const size = session.driver.viewportSize()
            const sizeNote = size ? `（视口 ${size.width}×${size.height}）` : ''
            const tooBig = png.byteLength > SCREENSHOT_VISION_MAX_BYTES
            return {
              content: `${BROWSER_SCREENSHOT_OF_PREFIX} ${session.driver.currentUrl()}${sizeNote}`
                + (artifactId ? ` → artifact ${artifactId}` : '')
                + pngNote
                + (tooBig ? `\n（${Math.round(png.byteLength / 1024)}KB 超出视觉通道上限，未附图——缩小视口后重截，或用 eval 量 DOM。）` : ''),
              images: tooBig ? undefined : [`data:image/png;base64,${base64}`],
            }
          }
          default:
            return { content: `未知操作：${String(action)}`, isError: true }
        }
      } catch (err) {
        return { content: `browser_debug ${action} 失败：${(err as Error).message}`, isError: true }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = params.input.action as string
      const connectUrl = resolveConnectUrl(params.input, action)
      if (connectUrl) {
        try {
          if (!isLoopbackHost(new URL(connectUrl).hostname)) return true
        } catch {
          /* invalid URL handled in execute */
        }
      }
      if (!NAV_ACTIONS.has(action)) return false
      const rawUrl = params.input.url
      if (typeof rawUrl !== 'string') return false
      try {
        return !isLoopbackHost(new URL(rawUrl).hostname)
      } catch {
        return false
      }
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: (params) => (params?.input.action === 'wait' ? 120_000 : 60_000),
  }
}

export const BROWSER_DEBUG_TOOL: Tool = createBrowserDebugTool({ enabled: true })
