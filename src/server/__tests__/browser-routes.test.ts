/**
 * /browser/* routes — chromium 就绪探测 + 安装任务状态机。
 *
 * 安装真跑会下 150MB，所以状态机用注入的 spawn 替身测；路由层只断言形状与鉴权，
 * 因为 readiness 反映的是真实宿主（有没有装 chromium 因机器而异）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import {
  buildBrowserRoutes,
  startBrowserInstall,
  getBrowserInstallState,
  __resetBrowserInstallState,
  type SpawnInstall,
} from '../browser-routes.js'

const TOKEN = 'browser-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** spawn 替身：手动推行与退出，测试完全掌握时序。 */
function fakeSpawn(): { spawn: SpawnInstall; line: (s: string) => void; exit: (code: number | null, err?: Error) => void } {
  let lineCb: ((line: string) => void) | undefined
  let exitCb: ((code: number | null, err?: Error) => void) | undefined
  return {
    spawn: () => ({
      onLine: cb => { lineCb = cb },
      onExit: cb => { exitCb = cb },
    }),
    line: s => lineCb?.(s),
    exit: (code, err) => exitCb?.(code, err),
  }
}

describe('browser install state machine', () => {
  beforeEach(() => { __resetBrowserInstallState() })

  it('marks running on start and captures output lines', () => {
    const fake = fakeSpawn()
    const res = startBrowserInstall({}, fake.spawn)
    assert.equal(res.started, true)
    assert.equal(getBrowserInstallState().running, true)
    assert.equal(getBrowserInstallState().mirror, true, '默认走国内镜像')
    fake.line('Downloading chromium 50%')
    assert.deepEqual(getBrowserInstallState().log, ['Downloading chromium 50%'])
  })

  it('refuses a second concurrent install (两个 playwright install 会互写同一份缓存)', () => {
    const fake = fakeSpawn()
    startBrowserInstall({}, fake.spawn)
    const second = startBrowserInstall({}, fake.spawn)
    assert.equal(second.started, false)
    assert.equal(second.reason, 'already-running')
  })

  it('clears running and records exit code on completion', () => {
    const fake = fakeSpawn()
    startBrowserInstall({}, fake.spawn)
    fake.exit(0)
    const st = getBrowserInstallState()
    assert.equal(st.running, false)
    assert.equal(st.exitCode, 0)
    assert.equal(st.error, undefined)
    assert.ok(st.finishedAt)
  })

  it('a failed exit code stays reportable and lets the user retry', () => {
    const fake = fakeSpawn()
    startBrowserInstall({}, fake.spawn)
    fake.exit(1)
    assert.equal(getBrowserInstallState().exitCode, 1)
    // 失败后必须能再启动一次（否则 UI 上的"重试"按钮永远点不动）。
    const again = startBrowserInstall({}, fakeSpawn().spawn)
    assert.equal(again.started, true)
  })

  it('spawn error is distinguished from a download failure (重试无用，要修 npx)', () => {
    const fake = fakeSpawn()
    startBrowserInstall({}, fake.spawn)
    fake.exit(null, new Error('spawn npx ENOENT'))
    const st = getBrowserInstallState()
    assert.equal(st.running, false)
    assert.equal(st.exitCode, 1)
    assert.match(st.error ?? '', /npx/)
  })

  it('mirror:false opts into the official source', () => {
    startBrowserInstall({ mirror: false }, fakeSpawn().spawn)
    assert.equal(getBrowserInstallState().mirror, false)
  })

  it('trims the log tail so a chatty installer cannot grow unbounded', () => {
    const fake = fakeSpawn()
    startBrowserInstall({}, fake.spawn)
    for (let i = 0; i < 100; i++) fake.line(`line ${i}`)
    const log = getBrowserInstallState().log
    assert.equal(log.length, 40)
    assert.equal(log.at(-1), 'line 99', '保留的是最新的尾部')
  })
})

describe('GET /browser/readiness', () => {
  const router = createRouter(buildBrowserRoutes(TOKEN))
  beforeEach(() => { __resetBrowserInstallState() })

  it('returns the probe shape plus install state', async () => {
    const res = await router('GET', '/browser/readiness', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as {
      state: string
      installed: boolean
      installable: boolean
      banner: string
      install: { running: boolean; log: string[] }
    }
    assert.ok(['ready', 'browser-missing', 'module-missing'].includes(body.state))
    assert.equal(typeof body.installed, 'boolean')
    assert.equal(typeof body.installable, 'boolean')
    // installable 只在"浏览器没下载"时为真——module-missing 装浏览器解决不了。
    assert.equal(body.installable, body.state === 'browser-missing')
    assert.equal(typeof body.banner, 'string')
    assert.equal(body.install.running, false)
  })

  it('ready 时 banner 为空（横幅只在缺失时出现）', async () => {
    const res = await router('GET', '/browser/readiness', {}, AUTH)
    const body = res.body as { installed: boolean; banner: string }
    if (body.installed) assert.equal(body.banner, '')
    else assert.ok(body.banner.length > 0)
  })

  it('rejects unauthorized requests', async () => {
    const res = await router('GET', '/browser/readiness', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('POST /browser/install', () => {
  const router = createRouter(buildBrowserRoutes(TOKEN))

  it('rejects unauthorized requests', async () => {
    const res = await router('POST', '/browser/install', {}, {})
    assert.equal(res.status, 401)
  })

  it('is a no-op when chromium is already installed', async () => {
    const probe = await router('GET', '/browser/readiness', {}, AUTH)
    const installed = (probe.body as { installed: boolean }).installed
    if (!installed) return // 宿主没装 chromium，这条断言不适用（不真跑安装）
    const res = await router('POST', '/browser/install', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual((res.body as { started: boolean }).started, false)
  })
})
