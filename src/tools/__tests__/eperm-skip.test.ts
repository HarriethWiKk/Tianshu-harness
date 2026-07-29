import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectFiles } from '../ast-shared.js'
import { GLOB_TOOL } from '../glob.js'
import { GREP_TOOL } from '../grep.js'
import { buildImportGraph } from '../../agent/import-graph.js'
import type { ToolCallParams } from '../types.js'

/**
 * Integration test: verify that directory traversal silently skips restricted
 * system directories (EPERM/EACCES) while still surfacing errors on the root
 * path and on non-restricted permission-denied directories.
 *
 * Uses real filesystem + chmod 000 to trigger genuine EACCES. The restricted
 * directory is named `.Spotlight-V100` to match the macOS pattern in
 * restricted-paths.ts (no drive-letter prefix needed, works in tmpdir).
 *
 * Platform notes:
 * - Windows: skipped (chmod 000 semantics differ; Windows path matching is
 *   covered by restricted-paths.test.ts unit tests).
 * - Root user: skipped (chmod 000 is ineffective for root).
 */

const isWindows = process.platform === 'win32'
const isRoot = process.getuid?.() === 0
const shouldSkip = isWindows || isRoot

/**
 * 脚手架落在 OS 临时目录，**不要**落在 `process.cwd()`。
 *
 * 原先建在 cwd 下（`.eperm-skip-test`），理由是"沙箱 tmpdir 可能挡 mkdtemp"。那个
 * 顾虑 runner 已经统一处理了：`scripts/run-node-tests.ts::resolveTestTmp` 先探测
 * tmpdir 可写性，不行才回退到仓库内 `.test-tmp`，并把 TMPDIR/TMP/TEMP 指过去
 * （两处引用的都是同一个 EPERM 起因 7cc487b2）。在这里再自己绕一遍，只会把残骸写进
 * 仓库：本文件造的 chmod 000 目录在进程被硬杀时删不掉（afterEach 根本不执行），
 * 曾在一个 vsw 快照里留下 `.eperm-skip-test/AppData/Local/Packages`，把 du / rm /
 * 同步公开仓的 rsync 全卡住。
 */
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

/**
 * 递归恢复目录权限，让 chmod 000 的目录可被删除。
 * 不用固定子目录清单——以后新增受限目录时清单必漏，残骸又会留下。
 */
function restorePermissions(dir: string): void {
  try { chmodSync(dir, 0o755) } catch { return }
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isDirectory()) restorePermissions(join(dir, entry.name))
  }
}

describe('EPERM silent-skip integration', { skip: shouldSkip && 'skipped: Windows or root' }, () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = makeTempDir('eperm-skip-test')
  })

  afterEach(() => {
    // chmod 000 的目录删不掉，必须先恢复权限再删。
    restorePermissions(tmpRoot)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('脚手架必须落在 TMPDIR 指向的位置，不能硬编码 cwd', () => {
    // 断言的是"尊重 TMPDIR"，不是"不在仓库里"——沙箱环境下 runner 的回退目录
    // `<cwd>/.test-tmp` 本身就在仓库内，那是有意的降级（见 resolveTestTmp）。
    // 硬编码 cwd 才是问题：本文件造的 chmod 000 目录在进程被硬杀时删不掉，
    // 会永久留在 git 工作树里。
    assert.ok(tmpRoot.startsWith(tmpdir()), `脚手架应在 ${tmpdir()} 下，实得 ${tmpRoot}`)
  })

  /** Restricted dir that traversals actually descend into: `.Spotlight-V100` is
   *  dot-prefixed and some walkers skip hidden dirs, so tools that filter by
   *  name use `AppData/Local/Packages` (matches the Windows pattern by path
   *  segment, works on POSIX, not dot-prefixed). */
  function makeRestrictedAppData(): string {
    const restricted = join(tmpRoot, 'AppData', 'Local', 'Packages')
    mkdirSync(restricted, { recursive: true })
    writeFileSync(join(restricted, 'hidden.ts'), 'const hidden = 1\n')
    chmodSync(restricted, 0o000)
    return restricted
  }

  it('collectFiles silently skips restricted subdir (.Spotlight-V100 + chmod 000)', async () => {
    // Layout: <tmp>/src/hit.ts, <tmp>/.Spotlight-V100/ (chmod 000)
    mkdirSync(join(tmpRoot, 'src'), { recursive: true })
    writeFileSync(join(tmpRoot, 'src', 'hit.ts'), 'const x = 1\n')
    mkdirSync(join(tmpRoot, '.Spotlight-V100'))
    writeFileSync(join(tmpRoot, '.Spotlight-V100', 'index.ts'), 'dummy\n')
    chmodSync(join(tmpRoot, '.Spotlight-V100'), 0o000)

    const files = await collectFiles(tmpRoot)
    assert.ok(files.some(f => f.includes('hit.ts')), 'should find src/hit.ts')
    assert.ok(!files.some(f => f.includes('.Spotlight-V100')), 'should not include restricted dir files')
  })

  it('collectFiles surfaces error on root path that is restricted', async () => {
    // Root dir itself is restricted (depth === 0) → must reject, not return empty
    const restricted = join(tmpRoot, '.Spotlight-V100')
    mkdirSync(restricted)
    chmodSync(restricted, 0o000)

    await assert.rejects(
      collectFiles(restricted),
      (err: NodeJS.ErrnoException) => err.code === 'EACCES' || err.code === 'EPERM',
      'collectFiles on restricted root must reject with EACCES/EPERM',
    )
  })

  it('collectFiles surfaces error on non-restricted permission-denied subdir', async () => {
    // user-denied/ is chmod 000 but NOT in the restricted patterns → must reject
    mkdirSync(join(tmpRoot, 'src'), { recursive: true })
    writeFileSync(join(tmpRoot, 'src', 'real.ts'), 'const x = 1\n')
    mkdirSync(join(tmpRoot, 'user-denied'))
    writeFileSync(join(tmpRoot, 'user-denied', 'secret.ts'), 'secret\n')
    chmodSync(join(tmpRoot, 'user-denied'), 0o000)

    await assert.rejects(
      collectFiles(tmpRoot),
      (err: NodeJS.ErrnoException) => err.code === 'EACCES' || err.code === 'EPERM',
      'collectFiles with non-restricted denied subdir must reject',
    )
  })

  it('glob surfaces error on root path that is restricted', async () => {
    // Root dir itself is restricted → must return isError, not empty result
    const restricted = join(tmpRoot, '.Spotlight-V100')
    mkdirSync(restricted)
    chmodSync(restricted, 0o000)

    const result = await GLOB_TOOL.execute({
      input: { pattern: '*', path: restricted },
      toolUseId: 'test',
      cwd: restricted,
    } as unknown as ToolCallParams)
    assert.equal(result.isError, true, 'glob on restricted root must return isError')
  })

  it('glob silently skips restricted subdir and still returns other matches', async () => {
    mkdirSync(join(tmpRoot, 'src'), { recursive: true })
    writeFileSync(join(tmpRoot, 'src', 'a.ts'), 'const a = 1\n')
    makeRestrictedAppData()

    const result = await GLOB_TOOL.execute({
      input: { pattern: '**/*.ts', path: '.' },
      toolUseId: 'test',
      cwd: tmpRoot,
    } as unknown as ToolCallParams)

    assert.ok(!result.isError, `glob must not error, got: ${result.content}`)
    assert.ok(result.content.includes('a.ts'), 'should find src/a.ts')
    assert.ok(!/EACCES|EPERM/.test(result.content), 'no permission noise in output')
  })

  // ── grep native fallback ──────────────────────────────────────
  // Empty PATH alone is no longer enough to force nativeSearch: tryRipgrep
  // uses getResolvedEnv, which restores a login-shell PATH that usually has
  // rg. Restricted dirs still make rg exit non-zero → native path (where
  // EPERM silent-skip lives). Dedicated "rg unavailable → prefix" coverage
  // lives in grep.test.ts (env.resolve:false + empty PATH).
  describe('grep (native fallback via rg failure)', () => {
    let savedPath: string | undefined

    beforeEach(() => {
      savedPath = process.env.PATH
      process.env.PATH = join(tmpRoot, 'no-binaries-here')
    })

    afterEach(() => {
      process.env.PATH = savedPath
    })

    const grep = (pattern: string, path: string) => GREP_TOOL.execute({
      input: { pattern, path },
      toolUseId: 'test',
      cwd: tmpRoot,
    } as unknown as ToolCallParams)

    it('silently skips restricted subdir during recursion', async () => {
      mkdirSync(join(tmpRoot, 'src'), { recursive: true })
      writeFileSync(join(tmpRoot, 'src', 'hit.ts'), 'const needle = 1\n')
      makeRestrictedAppData()

      const result = await grep('needle', '.')
      assert.ok(!result.isError, `grep must not error, got: ${result.content}`)
      assert.ok(result.content.includes('hit.ts'), 'should find the match in src/hit.ts')
      assert.ok(!/EACCES|EPERM/.test(result.content), 'no permission noise in output')
    })

    it('surfaces error when the search root itself is restricted', async () => {
      makeRestrictedAppData()

      const result = await grep('anything', 'AppData/Local/Packages')
      assert.equal(result.isError, true, 'restricted root must be isError, not "No matches found."')
      assert.ok(!result.content.includes('No matches found'), 'must not report empty result')
    })

    it('surfaces error on non-restricted permission-denied subdir', async () => {
      mkdirSync(join(tmpRoot, 'src'), { recursive: true })
      writeFileSync(join(tmpRoot, 'src', 'real.ts'), 'const needle = 1\n')
      mkdirSync(join(tmpRoot, 'user-denied'))
      chmodSync(join(tmpRoot, 'user-denied'), 0o000)

      const result = await grep('needle', '.')
      assert.equal(result.isError, true, 'non-restricted denied subdir must propagate as isError')
    })
  })

  it('buildImportGraph tolerates a restricted non-dot subdir (best-effort, no throw)', () => {
    writeFileSync(join(tmpRoot, 'main.ts'), `import { util } from './util'\n`)
    writeFileSync(join(tmpRoot, 'util.ts'), 'export const util = 1\n')
    makeRestrictedAppData()

    // Must not throw despite EACCES inside AppData/Local/Packages, and must
    // still index the readable files.
    const graph = buildImportGraph(tmpRoot)
    assert.ok(graph !== null, 'graph should build')
    assert.ok(
      [...graph!.forward.keys()].some(f => f.endsWith('main.ts')),
      'readable files still indexed',
    )
  })
})
