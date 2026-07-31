/**
 * /browser/* routes — chromium 就绪探测与一键安装，供桌面端使用。
 *
 * `browser_debug` / `computer_use` 的截图能力依赖 chromium（~150MB，不随包分发）。
 * CLI 侧有 `rivet browser status|install`，但**只装桌面端的用户没有 CLI**——没有这两条
 * 路由，他们唯一的出路是自己开终端敲 npx，等于截图能力对桌面单独部署不成立。
 *
 *   GET  /browser/readiness   探测状态（零副作用，不启动浏览器）+ 当前安装任务进度
 *   POST /browser/install     启动安装（异步；进度靠轮询 readiness 拿）
 *
 * 安装是单例任务：一次只允许一个（并发跑两个 playwright install 会互相写同一份缓存）。
 * 进程内状态，sidecar 重启即忘——重启后 readiness 探测本身就是事实来源，不需要持久化。
 */
import { spawn } from 'node:child_process'
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { probeChromium, formatBrowserMissingBanner } from '../tools/net/browser-readiness.js'
import { buildInstallPlan } from '../cli/browser-cli.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export interface BrowserInstallState {
  running: boolean
  startedAt?: number
  finishedAt?: number
  exitCode?: number
  /** 是否走了国内镜像（UI 上失败时可提示改用官方源重试）。 */
  mirror?: boolean
  /** 最近若干行输出——够 UI 显示进度，不够的去看 sidecar 日志。 */
  log: string[]
  error?: string
}

const LOG_TAIL_LINES = 40

/** 进程内单例安装任务。测试可用 `__resetBrowserInstallState` 复位。 */
let installState: BrowserInstallState = { running: false, log: [] }

/** @internal 测试用：清掉单例状态，避免用例间互相污染。 */
export function __resetBrowserInstallState(): void {
  installState = { running: false, log: [] }
}

/** 依赖注入口子：测试替换 spawn，避免真去下 150MB chromium。 */
export type SpawnInstall = (plan: ReturnType<typeof buildInstallPlan>) => {
  onLine: (cb: (line: string) => void) => void
  onExit: (cb: (code: number | null, err?: Error) => void) => void
}

function defaultSpawnInstall(plan: ReturnType<typeof buildInstallPlan>): ReturnType<SpawnInstall> {
  const child = spawn(plan.command, plan.args, {
    env: { ...process.env, ...plan.env },
    // Windows 上 npx 是 .cmd shim，需 shell 解析。
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lineCbs: Array<(line: string) => void> = []
  const emit = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed) for (const cb of lineCbs) cb(trimmed)
    }
  }
  child.stdout?.on('data', emit)
  child.stderr?.on('data', emit)
  return {
    onLine: cb => { lineCbs.push(cb) },
    onExit: cb => {
      child.on('error', err => cb(null, err))
      child.on('close', code => cb(code))
    },
  }
}

/**
 * 启动 chromium 安装。已在跑则返回 `already-running`（不排队第二个）。
 * 纯逻辑 + 注入的 spawn，便于测试断言状态机而不真下浏览器。
 */
export function startBrowserInstall(
  opts: { mirror?: boolean } = {},
  spawnInstall: SpawnInstall = defaultSpawnInstall,
): { started: boolean; reason?: 'already-running' } {
  if (installState.running) return { started: false, reason: 'already-running' }
  const mirror = opts.mirror !== false
  const plan = buildInstallPlan(mirror ? [] : ['--no-mirror'])
  installState = { running: true, startedAt: Date.now(), mirror, log: [] }
  const proc = spawnInstall(plan)
  proc.onLine(line => {
    installState.log.push(line)
    if (installState.log.length > LOG_TAIL_LINES) installState.log.splice(0, installState.log.length - LOG_TAIL_LINES)
  })
  proc.onExit((code, err) => {
    installState = {
      ...installState,
      running: false,
      finishedAt: Date.now(),
      exitCode: err ? 1 : (code ?? 1),
      // 启动就失败（没有 npx / PATH 里找不到）和"下载失败"是两码事，前者重试无用。
      error: err ? `安装启动失败：${err.message}（确认已安装 Node/npm 且 npx 可用）` : undefined,
    }
  })
  return { started: true }
}

/** @internal 测试用：读当前安装状态。 */
export function getBrowserInstallState(): BrowserInstallState {
  return installState
}

export function buildBrowserRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /browser/readiness': withAuth(async () => {
      const probe = await probeChromium()
      return {
        status: 200,
        body: {
          ...probe,
          // module-missing 装浏览器解决不了（是依赖残缺）——UI 靠这个字段决定给不给安装按钮。
          installable: probe.state === 'browser-missing',
          banner: formatBrowserMissingBanner(probe),
          install: installState,
        },
      }
    }, apiToken),

    'POST /browser/install': withAuth(async (body) => {
      const { mirror } = (body ?? {}) as { mirror?: unknown }
      const probe = await probeChromium()
      if (probe.installed) {
        return { status: 200, body: { started: false, reason: 'already-installed', ...probe } }
      }
      if (probe.state === 'module-missing') {
        // 拦在这里而不是白跑一遍安装：playwright-core 缺失时下浏览器也用不上。
        return { status: 409, body: { error: 'playwright-core 模块缺失，装浏览器无法解决', ...probe } }
      }
      const started = startBrowserInstall({ mirror: mirror === false ? false : true })
      if (!started.started) {
        return { status: 409, body: { error: '安装已在进行中', install: installState } }
      }
      return { status: 202, body: { started: true, install: installState } }
    }, apiToken),
  }
}
