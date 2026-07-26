/**
 * render-pool — web_fetch 专用的常驻 headless chromium 渲染池。
 *
 * 懒起单 Browser、多 Page 并发（Playwright 自管）；空闲超时自动关闭 Browser
 * ——桌面 sidecar 是长驻进程，chromium 常驻 150-300MB，必须有回收兜底；
 * Page 数设上限防僵尸页累积。进程退出清理照抄 browser-debug/session.ts
 * 的惰性 exit hook。与 browser-debug 不共享实例（避免会话状态串扰）；
 * 不进 worker_threads（浏览器是有状态 IO 资源，不匹配 cpu-pool 模型）。
 */
import { launchHeadlessChromium, type PwBrowser, type PwContext, type PwPage } from '../net/playwright-driver.js'

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_PAGES = 8

/**
 * 渲染用 UA 池（firecrawl playwright-service 同款随机 UA 策略）：
 * 版本号对齐桌面端打包的 Chrome for Testing 151；每次开 context 随机取一。
 */
const RENDER_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
]

function pickUserAgent(): string {
  return RENDER_USER_AGENTS[Math.floor(Math.random() * RENDER_USER_AGENTS.length)]!
}

export interface RenderPoolOptions {
  /** 空闲多久后关闭 Browser（默认 10 分钟）。 */
  idleTimeoutMs?: number
  /** 并发 Page 上限（默认 8）。 */
  maxPages?: number
  proxy?: { server: string; bypass?: string }
  /** 测试注入：替换真实 chromium 启动。 */
  launchBrowser?: () => Promise<PwBrowser>
}

export class RenderPool {
  private browser: PwBrowser | null = null
  private launching: Promise<PwBrowser> | null = null
  private activePages = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** page → 其所属 context（每页独立 context：serviceWorkers 阻断 + UA/viewport 隔离） */
  private readonly pageContexts = new WeakMap<PwPage, PwContext>()
  private readonly idleTimeoutMs: number
  private readonly maxPages: number
  private readonly launch: () => Promise<PwBrowser>

  constructor(opts: RenderPoolOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
    this.launch = opts.launchBrowser ?? (() => launchHeadlessChromium({ proxy: opts.proxy }))
  }

  /** 当前活跃 Page 数（诊断与测试用）。 */
  get pageCount(): number {
    return this.activePages
  }

  /** Browser 是否在跑（诊断与测试用）。 */
  get isRunning(): boolean {
    return this.browser !== null
  }

  async acquirePage(): Promise<PwPage> {
    if (this.activePages >= this.maxPages) {
      throw new Error(`渲染池 Page 数超限（${this.maxPages}）`)
    }
    const browser = await this.ensureBrowser()
    this.activePages += 1
    try {
      // 每页独立 context（firecrawl playwright-service 同构）：serviceWorkers 阻断
      // 防站点注册 SW 干扰渲染，viewport/UA 与浏览器指纹解耦
      const context = await browser.newContext({
        serviceWorkers: 'block',
        viewport: { width: 1280, height: 800 },
        userAgent: pickUserAgent(),
      })
      const page = await context.newPage()
      this.pageContexts.set(page, context)
      this.disarmIdleTimer()
      return page
    } catch (err) {
      this.activePages -= 1
      throw err
    }
  }

  async releasePage(page: PwPage): Promise<void> {
    this.activePages = Math.max(0, this.activePages - 1)
    const context = this.pageContexts.get(page)
    try {
      // context 关闭连带其 page；无 context 记录（异常路径）退化为关 page
      await (context ?? page).close()
    } catch {
      /* 已关闭（Browser 崩溃等）——回收语义不受影响 */
    }
    this.pageContexts.delete(page)
    if (this.activePages === 0) this.armIdleTimer()
  }

  /** 立即关闭 Browser（空闲回收与进程退出共用）。 */
  async closeBrowser(): Promise<void> {
    this.disarmIdleTimer()
    const browser = this.browser
    this.browser = null
    if (browser) {
      try {
        await browser.close()
      } catch {
        /* 退出期兜底 */
      }
    }
  }

  private async ensureBrowser(): Promise<PwBrowser> {
    if (this.browser) {
      // Browser 崩溃/被杀后 playwright 连接断开——丢弃引用，重新拉起
      if (this.browser.isConnected && !this.browser.isConnected()) {
        this.browser = null
      } else {
        return this.browser
      }
    }
    if (this.launching) return this.launching
    this.launching = this.launch()
      .then((browser) => {
        this.browser = browser
        this.launching = null
        browser.on('disconnected', (() => {
          this.browser = null
        }) as never)
        return browser
      })
      .catch((err) => {
        this.launching = null
        throw err
      })
    return this.launching
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer()
    this.idleTimer = setTimeout(() => {
      void this.closeBrowser()
    }, this.idleTimeoutMs)
    // 不阻塞进程退出
    this.idleTimer.unref?.()
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

let defaultPool: RenderPool | null = null
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    if (defaultPool) void defaultPool.closeBrowser().catch(() => {})
  }
  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
}

/**
 * 进程级默认渲染池。opts 只在首次创建时生效（代理配置在同一进程内不变，
 * 与 config.network 静态语义一致）。
 */
export function getDefaultRenderPool(opts: RenderPoolOptions = {}): RenderPool {
  if (!defaultPool) {
    defaultPool = new RenderPool(opts)
    installExitHook()
  }
  return defaultPool
}

/** Test hook: close and drop the default pool without touching real browsers. */
export async function __resetRenderPoolForTest(): Promise<void> {
  if (defaultPool) await defaultPool.closeBrowser()
  defaultPool = null
}
