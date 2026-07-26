import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyInitCommit, formatInitApplyReport, renderInitSkillMarkdown, type InitCommit, type InitHookSpec, type InitSkillSpec } from '../init-scaffold.js'
import { probeInitFlowInput, suggestInitHooks, suggestInitSkills, type InitFlowInput } from '../../tui/init-flow.js'
import { parseSkillMarkdown } from '../../skills/skill-loader.js'

const NODE_INPUT: InitFlowInput = {
  fingerprint: {
    language: 'typescript',
    testCommand: 'npx vitest run',
    buildCommand: 'npm run build',
    typecheckCommand: 'tsc --noEmit',
    lintCommand: 'npx eslint .',
    hasTestInfra: true,
  },
  installedSkillCount: 0,
  releaseScript: 'release',
}

function makeNodeProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: { test: 'vitest run', build: 'tsc', release: 'np' },
    devDependencies: { eslint: '^9' },
  }))
}

function fullCommit(input: InitFlowInput = NODE_INPUT): InitCommit {
  return { verify: true, skills: suggestInitSkills(input), hooks: suggestInitHooks(input) }
}

function readJson(dir: string, rel: string): any {
  return JSON.parse(readFileSync(join(dir, rel), 'utf-8'))
}

describe('init-scaffold (applyInitCommit)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-scaffold-'))
    makeNodeProject(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates verify declaration, skills and hooks for a fresh project', () => {
    const report = applyInitCommit(dir, fullCommit())

    // verify 支路：.rivet-config.json + .rivet.md ## Stack
    assert.equal(readJson(dir, '.rivet-config.json').verify.test, 'npx vitest run')
    assert.match(readFileSync(join(dir, '.rivet.md'), 'utf-8'), /## Stack/)

    // skills 支路：3 个模板落盘且均可被 parseSkillMarkdown 解析。
    for (const slug of ['run-tests', 'lint-fix', 'release']) {
      const content = readFileSync(join(dir, '.rivet', 'skills', `${slug}.md`), 'utf-8')
      const parsed = parseSkillMarkdown(content, `${slug}.md`)
      assert.equal(parsed.name, slug)
      assert.ok(parsed.description.length > 0)
      assert.ok(parsed.triggers.length > 0)
    }

    // hooks 支路：hooks.json 合并 + 脚本文件（+x）。
    const hooksJson = readJson(dir, join('.rivet', 'hooks.json'))
    assert.deepEqual(
      hooksJson.hooks.map((h: any) => [h.event, h.script]),
      [
        ['postTool', '.rivet/hooks/posttool-typecheck.sh'],
        ['postSession', '.rivet/hooks/postsession-check-tests.sh'],
      ],
    )
    const typecheckHook = hooksJson.hooks[0]
    // 后台化模板不带 timeoutMs（脚本立即返回，无 60s 同步阻塞）。
    assert.equal(typecheckHook.timeoutMs, undefined)
    const scriptPath = join(dir, '.rivet', 'hooks', 'posttool-typecheck.sh')
    const script = readFileSync(scriptPath, 'utf-8')
    assert.match(script, /RIVET_TOOL_NAME/)
    // 后台化纪律：typecheck 输出重定向到日志文件并 & 后台执行（不阻塞工具循环）。
    assert.match(script, /> \.rivet\/hooks\/last-typecheck\.log 2>&1 \) &/)
    if (process.platform !== 'win32') {
      assert.ok((statSync(scriptPath).mode & 0o111) !== 0, 'script should be executable')
    }

    // 报告逐项覆盖。
    const paths = report.items.map(i => i.path)
    for (const p of ['.rivet-config.json', '.rivet.md', '.rivet/skills/run-tests.md', '.rivet/hooks.json', '.rivet/hooks/posttool-typecheck.sh']) {
      assert.ok(paths.includes(p), `report should mention ${p}`)
    }
    assert.ok(report.items.every(i => i.action === 'created' || i.action === 'updated'))
    assert.match(formatInitApplyReport(report), /完成：/)
  })

  it('is idempotent: repeated runs create nothing twice and reach a fixed point', () => {
    const commit = fullCommit()
    applyInitCommit(dir, commit)
    const skillBefore = readFileSync(join(dir, '.rivet', 'skills', 'run-tests.md'), 'utf-8')

    const second = applyInitCommit(dir, commit)
    // 连跑两次：hooks.json 条目不重复、skill 文件不重写、verify key 不覆盖。
    const hooksJson = readJson(dir, join('.rivet', 'hooks.json'))
    assert.equal(hooksJson.hooks.length, 2)
    assert.equal(readFileSync(join(dir, '.rivet', 'skills', 'run-tests.md'), 'utf-8'), skillBefore)
    assert.equal(second.items.find(i => i.path === '.rivet/skills/run-tests.md')?.action, 'skipped')
    assert.equal(second.items.find(i => i.path === '.rivet-config.json')?.action, 'skipped')
    // upsertStackSection 会把 Stack 段尾部规整为 '\n\n'（与 /init verify 直执行同语义），
    // 因此第二次运行可能重写一次 .rivet.md；第三次起达到不动点，全部 skipped。
    const third = applyInitCommit(dir, commit)
    assert.ok(third.items.every(i => i.action === 'skipped'), `third run should be all-skipped: ${JSON.stringify(third.items)}`)
  })

  it('merges hooks.json arrays without clobbering existing entries', () => {
    mkdirSync(join(dir, '.rivet'), { recursive: true })
    writeFileSync(join(dir, '.rivet', 'hooks.json'), JSON.stringify({
      hooks: [{ event: 'preTurn', script: '.rivet/hooks/mine.sh' }],
    }))
    const minePath = join(dir, '.rivet', 'hooks', 'mine.sh')
    mkdirSync(join(dir, '.rivet', 'hooks'), { recursive: true })
    writeFileSync(minePath, '#!/bin/sh\necho mine\n')

    applyInitCommit(dir, { verify: false, skills: [], hooks: suggestInitHooks(NODE_INPUT) })
    const hooksJson = readJson(dir, join('.rivet', 'hooks.json'))
    assert.equal(hooksJson.hooks.length, 3)
    assert.deepEqual(hooksJson.hooks[0], { event: 'preTurn', script: '.rivet/hooks/mine.sh' })
    assert.equal(readFileSync(minePath, 'utf-8'), '#!/bin/sh\necho mine\n')
  })

  it('does not clobber a malformed hooks.json', () => {
    mkdirSync(join(dir, '.rivet'), { recursive: true })
    writeFileSync(join(dir, '.rivet', 'hooks.json'), '{broken')
    const report = applyInitCommit(dir, { verify: false, skills: [], hooks: suggestInitHooks(NODE_INPUT) })
    assert.equal(readFileSync(join(dir, '.rivet', 'hooks.json'), 'utf-8'), '{broken')
    const item = report.items.find(i => i.path === '.rivet/hooks.json')
    assert.equal(item?.action, 'error')
  })

  it('never overwrites existing verify keys (hand-edits win)', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ verify: { test: 'make check' } }))
    applyInitCommit(dir, { verify: true, skills: [], hooks: [] })
    const verify = readJson(dir, '.rivet-config.json').verify
    assert.equal(verify.test, 'make check') // preserved
    assert.equal(verify.build, 'npm run build') // filled
  })

  it('skips skills beyond RECOMMENDED_MAX_SKILLS and never clobbers same-name files', () => {
    const skillsDir = join(dir, '.rivet', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    // 已装 4 个（含 run-tests 同名 sentinel）→ run-tests 走「同名跳过」，
    // lint-fix 成为第 5 个落盘，release 触发上限跳过。
    for (const slug of ['a', 'b', 'c']) writeFileSync(join(skillsDir, `${slug}.md`), '---\nname: x\n---\n')
    writeFileSync(join(skillsDir, 'run-tests.md'), 'sentinel')

    const specs = suggestInitSkills(NODE_INPUT)
    assert.equal(specs.length, 3)
    const report = applyInitCommit(dir, { verify: false, skills: specs, hooks: [] })

    assert.equal(readFileSync(join(skillsDir, 'run-tests.md'), 'utf-8'), 'sentinel')
    const byPath = new Map(report.items.map(i => [i.path, i]))
    assert.equal(byPath.get('.rivet/skills/run-tests.md')?.action, 'skipped')
    assert.match(byPath.get('.rivet/skills/run-tests.md')?.detail ?? '', /同名/)
    assert.equal(byPath.get('.rivet/skills/lint-fix.md')?.action, 'created')
    assert.equal(byPath.get('.rivet/skills/release.md')?.action, 'skipped')
    assert.match(byPath.get('.rivet/skills/release.md')?.detail ?? '', /上限/)
  })

  it('renderInitSkillMarkdown round-trips through parseSkillMarkdown', () => {
    const spec: InitSkillSpec = {
      slug: 'demo',
      description: 'demo skill',
      triggers: ['foo', 'bar'],
      body: '# demo\n\nbody line',
    }
    const parsed = parseSkillMarkdown(renderInitSkillMarkdown(spec), 'demo.md')
    assert.equal(parsed.name, 'demo')
    assert.equal(parsed.description, 'demo skill')
    assert.equal(parsed.triggers.length, 2)
    assert.match(parsed.body, /body line/)
  })

  it('probeInitFlowInput derives the wizard input from on-disk facts', () => {
    // TUI openInitFlow 用的工厂：指纹 + 已装技能数 + 发版脚本探测。
    const input = probeInitFlowInput(dir)
    assert.equal(input.fingerprint.language, 'typescript')
    assert.equal(input.installedSkillCount, 0)
    assert.equal(input.releaseScript, 'release')
    // 装上 2 个 skill 后再探测，数量随之变化。
    const skillsDir = join(dir, '.rivet', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'a.md'), '---\nname: a\n---\n')
    writeFileSync(join(skillsDir, 'b.md'), '---\nname: b\n---\n')
    assert.equal(probeInitFlowInput(dir).installedSkillCount, 2)
  })

  it('hook scripts run: postTool typecheck hook exits 0 for non-write tools', () => {
    if (process.platform === 'win32') return
    const hook: InitHookSpec = suggestInitHooks(NODE_INPUT)[0]!
    applyInitCommit(dir, { verify: false, skills: [], hooks: [hook] })
    const scriptPath = join(dir, '.rivet', 'hooks', hook.name)
    chmodSync(scriptPath, 0o755)
    const res = spawnSync(scriptPath, [], { env: { ...process.env, RIVET_TOOL_NAME: 'read_file' }, encoding: 'utf-8', timeout: 10_000 })
    assert.equal(res.status, 0, `non-write tool should no-op: ${res.stderr}`)
  })

  it('hook scripts run: write tool returns immediately and lands the log async', async () => {
    if (process.platform === 'win32') return
    const hook: InitHookSpec = suggestInitHooks(NODE_INPUT)[0]!
    applyInitCommit(dir, { verify: false, skills: [], hooks: [hook] })
    const scriptPath = join(dir, '.rivet', 'hooks', hook.name)
    chmodSync(scriptPath, 0o755)
    const started = Date.now()
    const res = spawnSync(scriptPath, [], { cwd: dir, env: { ...process.env, RIVET_TOOL_NAME: 'edit_file' }, encoding: 'utf-8', timeout: 10_000 })
    const elapsed = Date.now() - started
    assert.equal(res.status, 0, `write tool should still exit 0: ${res.stderr}`)
    assert.ok(elapsed < 3000, `must return immediately (background), took ${elapsed}ms`)
    // 后台 typecheck 落日志（命令不存在也会建文件——重定向先于 exec）。
    const logPath = join(dir, '.rivet', 'hooks', 'last-typecheck.log')
    const deadline = Date.now() + 5000
    while (!existsSync(logPath) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(existsSync(logPath), 'background typecheck should land .rivet/hooks/last-typecheck.log')
  })
})
