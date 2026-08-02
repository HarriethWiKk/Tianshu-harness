import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildCacheRoutes } from '../cache-routes.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

describe('GET /cache/usage', () => {
  let sessionRoot: string
  let prevSessionDir: string | undefined

  before(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'cache-routes-'))
    const sid = join(sessionRoot, 'session-1')
    mkdirSync(sid, { recursive: true })
    const now = Date.now()
    const lines = [
      { t: now - 1000, model: 'deepseek-chat', input: 10_000, cacheRead: 9_000, cacheCreate: 100, output: 400 },
      { t: now - 2000, model: 'deepseek-chat', input: 10_000, cacheRead: 7_000, cacheCreate: 100, output: 400 },
      { event: 'side_path', kind: 'speculation', t: now - 3000, model: 'deepseek-chat', input: 2_000, cacheRead: 1_000, output: 50 },
      { event: 'reclaim_decision', t: now - 4000, action: 'trim' },
    ]
    writeFileSync(join(sid, 'cache-log.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')

    // RIVET_SESSION_DIR 覆盖 sessionsDir()，让路由扫到临时目录
    prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = sessionRoot
  })

  after(() => {
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(sessionRoot, { recursive: true, force: true })
  })

  const call = (path: string, headers: Record<string, string> = AUTH) =>
    createRouter(buildCacheRoutes({ apiToken: TOKEN, defaultCwd: () => process.cwd() }))('GET', path, {}, headers)

  it('聚合本地 cache-log：主请求命中率只算主请求行，侧路单列', async () => {
    const res = await call('/cache/usage')
    assert.equal(res.status, 200)
    const body = res.body as {
      scope: string
      windowDays: number
      days: Array<{ date: string; requests: number }>
      totals: { requests: number; sidePathRequests: number; input: number; hitRate: number | null }
      models: Array<{ model: string }>
      scannedFiles: number
    }
    assert.equal(body.scope, 'project')
    assert.equal(body.windowDays, 30)
    // days 是按天明细数组（不是标量窗口天数）
    assert.equal(body.days.length, 1)
    assert.equal(body.totals.requests, 2)
    assert.equal(body.totals.sidePathRequests, 1)
    // (9000+7000)/(10000+10000) = 80%
    assert.equal(body.totals.hitRate, 80)
    assert.equal(body.models[0]!.model, 'deepseek-chat')
    assert.equal(body.scannedFiles, 1)
  })

  it('days 参数生效并夹到上限 90', async () => {
    const res = await call('/cache/usage?days=7')
    assert.equal((res.body as { windowDays: number }).windowDays, 7)
    const capped = await call('/cache/usage?days=9999')
    assert.equal((capped.body as { windowDays: number }).windowDays, 90)
  })

  it('非法 days 报 400 而不是静默当默认值', async () => {
    for (const days of ['0', '-3', 'abc']) {
      const res = await call(`/cache/usage?days=${days}`)
      assert.equal(res.status, 400, `days=${days}`)
    }
  })

  it('scope=all 扫全部项目根目录', async () => {
    const res = await call('/cache/usage?scope=all')
    assert.equal(res.status, 200)
    assert.equal((res.body as { scope: string }).scope, 'all')
  })

  it('rejects unauthorized requests', async () => {
    const res = await call('/cache/usage', {})
    assert.equal(res.status, 401)
  })
})
