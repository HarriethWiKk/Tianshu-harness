import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { collectDiff, formatDiffArtifact } from '../diff-collector.js'

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

describe('diff-collector', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'rivet-diff-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'file.txt'), 'original\n')
    mkdirSync(join(repoDir, 'src'), { recursive: true })
    writeFileSync(join(repoDir, 'src', 'existing.ts'), 'export const x = 1\n')
    git(repoDir, ['add', '-A'])
    git(repoDir, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('collects unstaged modifications without requiring commit', () => {
    writeFileSync(join(repoDir, 'file.txt'), 'modified\n')

    const diff = collectDiff(repoDir, repoDir, 'main')

    assert.ok(diff.includes('modified'), diff)
  })

  it('collects untracked new files', () => {
    writeFileSync(join(repoDir, 'brand-new.ts'), 'export const y = 2\n')

    const diff = collectDiff(repoDir, repoDir, 'main')

    assert.ok(diff.includes('brand-new.ts'), diff)
    assert.ok(diff.includes('export const y = 2'), diff)
  })

  it('collects staged changes', () => {
    writeFileSync(join(repoDir, 'staged.ts'), 'staged content\n')
    git(repoDir, ['add', 'staged.ts'])

    const diff = collectDiff(repoDir, repoDir, 'main')

    assert.ok(diff.includes('staged content'), diff)
  })

  it('collects committed changes on worker branch', () => {
    git(repoDir, ['checkout', '-b', 'worker'])
    writeFileSync(join(repoDir, 'src', 'existing.ts'), 'export const x = 2\n')
    git(repoDir, ['add', '-A'])
    git(repoDir, ['commit', '-m', 'worker change'])

    const diff = collectDiff(repoDir, repoDir, 'main')

    assert.ok(diff.includes('export const x = 2'), diff)
  })

  it('collects tracked and untracked changes together', () => {
    writeFileSync(join(repoDir, 'file.txt'), 'modified\n')
    writeFileSync(join(repoDir, 'new-file.ts'), 'export const fresh = true\n')

    const diff = collectDiff(repoDir, repoDir, 'main')

    assert.ok(diff.includes('modified'), diff)
    assert.ok(diff.includes('new-file.ts'), diff)
  })

  it('returns empty string when no changes', () => {
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.equal(diff, '')
  })

  it('formats empty diffs as schema-valid artifacts', () => {
    const artifact = formatDiffArtifact('', 'patcher')
    assert.equal(artifact.kind, 'diff')
    assert.equal(artifact.title, 'Patch (empty)')
    assert.equal(artifact.content, '(empty diff)')
  })

  // Regression: CJK comments in the diff body must survive as UTF-8, not be
  // mojibake'd by a chunk-boundary GBK misjudgement. git output bytes mirror
  // the source file (modern git defaults to UTF-8), so the diff should carry
  // the original Chinese characters verbatim.
  it('keeps UTF-8 CJK comments intact in the diff body', () => {
    writeFileSync(join(repoDir, 'src', '中文注释.js'), '// 依赖 get_stock_list 获取股票列表\nconst x = 1\n')
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('// 依赖 get_stock_list 获取股票列表'), `CJK comment mojibake'd:\n${diff}`)
  })

  // Regression: non-ASCII file paths must appear verbatim (core.quotePath=false),
  // not octal-escaped, so the desktop diff parser can anchor line comments.
  it('keeps non-ASCII file paths unescaped in diff headers', () => {
    mkdirSync(join(repoDir, '策略'), { recursive: true })
    writeFileSync(join(repoDir, '策略', '涨停.js'), 'export const up = 1\n')
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('策略/涨停.js'), `non-ASCII path escaped:\n${diff}`)
  })
})
