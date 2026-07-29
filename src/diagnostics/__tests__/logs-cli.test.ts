import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runLogsCLI } from '../logs-cli.js'
import { projectSlug } from '../../config/paths.js'

const dirs: string[] = []
let savedHome: string | undefined

beforeEach(() => { savedHome = process.env['RIVET_HOME'] })

afterEach(() => {
  if (savedHome === undefined) delete process.env['RIVET_HOME']
  else process.env['RIVET_HOME'] = savedHome
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `rivet-logscli-${prefix}-`))
  dirs.push(d)
  return d
}

/** 造一个带真实 transcript 的会话树，让「最近会话」有东西可挑。 */
function seedSession(home: string, cwd: string, id: string): string {
  const dir = join(home, 'sessions', projectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n', 'utf-8')
  return dir
}

describe('rivet logs', () => {
  it('无参时自动挑最近会话，输出里带上它的 id', () => {
    const home = temp('home'); const cwd = temp('proj')
    process.env['RIVET_HOME'] = home
    seedSession(home, cwd, 'sess-latest')

    const r = runLogsCLI([], { cwd })

    assert.equal(r.exitCode, 0)
    assert.ok(r.output.includes('sess-latest'), '没挑到最近会话，用户还得自己 ls -t')
    assert.ok(r.output.includes(home), '必须打印真实数据根')
  })

  it('--session 显式指定优先于最近会话', () => {
    const home = temp('home'); const cwd = temp('proj')
    process.env['RIVET_HOME'] = home
    seedSession(home, cwd, 'sess-latest')

    const r = runLogsCLI(['--session', 'sess-chosen'], { cwd })

    assert.ok(r.output.includes('sess-chosen'))
    assert.ok(!r.output.includes('sess-latest'), '显式指定时不该混入别的会话 id')
  })

  it('--json 输出可被机器消费，且含落点数组与门控字段', () => {
    const home = temp('home'); const cwd = temp('proj')
    process.env['RIVET_HOME'] = home
    seedSession(home, cwd, 'sess-json')

    const r = runLogsCLI(['--json'], { cwd })

    const parsed = JSON.parse(r.output) as {
      rivetHome: string
      sessionId?: string
      locations: Array<{ id: string; path: string; exists: boolean; gate?: string }>
    }
    assert.equal(parsed.rivetHome, home)
    assert.equal(parsed.sessionId, 'sess-json')
    const sensorium = parsed.locations.find(l => l.id === 'sensorium')
    assert.ok(sensorium, 'JSON 里必须有六维落点——上报 issue 就靠它')
    assert.match(sensorium.gate ?? '', /RIVET_DEBUG_TELEMETRY/)
    assert.equal(typeof sensorium.exists, 'boolean')
  })

  it('没有任何会话时不报错，如实说没有并仍打印数据根', () => {
    const home = temp('home'); const cwd = temp('proj')
    process.env['RIVET_HOME'] = home

    const r = runLogsCLI([], { cwd })

    assert.equal(r.exitCode, 0, '空会话树不是错误——新装用户第一次跑就是这个状态')
    assert.ok(r.output.includes(home))
  })

  it('open 走注入的 opener，目标是会话目录', () => {
    const home = temp('home'); const cwd = temp('proj')
    process.env['RIVET_HOME'] = home
    const expected = seedSession(home, cwd, 'sess-open')
    const opened: string[] = []

    const r = runLogsCLI(['open'], { cwd, openPath: (p) => opened.push(p) })

    assert.equal(r.exitCode, 0)
    assert.deepEqual(opened, [expected])
  })

  it('open desktop 打开 sidecar 日志目录，而不是会话目录', () => {
    const home = temp('home'); const cwd = temp('proj')
    process.env['RIVET_HOME'] = home
    const opened: string[] = []

    runLogsCLI(['open', 'desktop'], { cwd, openPath: (p) => opened.push(p) })

    assert.deepEqual(opened, [join(home, 'logs')])
  })

  it('未知参数给用法并以非零退出 —— 静默忽略会让人以为生效了', () => {
    const r = runLogsCLI(['--nope'], { cwd: temp('proj') })
    assert.equal(r.exitCode, 1)
    assert.ok(r.output.includes('--json'), '用法里要列出真实支持的参数')
  })

  it('--session 缺值时报错而不是把下一个参数当会话 id', () => {
    const r = runLogsCLI(['--session'], { cwd: temp('proj') })
    assert.equal(r.exitCode, 1)
  })
})
