import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { rivetHome } from '../../config/paths.js'
import {
  grantPath,
  isReadGranted,
  isWriteGranted,
  writeGrantedRoots,
  listGrants,
  loadPersistedGrants,
  applyConfiguredPathGrants,
  applyDefaultDependencyReadGrants,
  isPathUnder,
  _resetGrantsForTest,
} from '../path-grants.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-grants-'))
}

describe('path-grants', () => {
  beforeEach(() => _resetGrantsForTest())

  it('grants a directory subtree (read)', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'read')
      assert.equal(isReadGranted(join(dir, 'a/b/c.txt')), true)
      assert.equal(isReadGranted(dir), true)
      // read grant does not satisfy a write check
      assert.equal(isWriteGranted(join(dir, 'a.txt')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write grant satisfies both read and write', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'write')
      assert.equal(isWriteGranted(join(dir, 'out.zip')), true)
      assert.equal(isReadGranted(join(dir, 'out.zip')), true)
      assert.deepEqual(writeGrantedRoots().length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upgrades read → write but never downgrades', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'read')
      grantPath(dir, 'write')
      assert.equal(isWriteGranted(join(dir, 'x')), true)
      assert.equal(listGrants().length, 1, 'same root deduped')
      grantPath(dir, 'read') // must not downgrade
      assert.equal(isWriteGranted(join(dir, 'x')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects path-separator boundary (no prefix bleed)', () => {
    const base = tmp()
    try {
      const granted = join(base, 'proj')
      mkdirSync(granted)
      mkdirSync(join(base, 'proj-backup'))
      grantPath(granted, 'write')
      assert.equal(isWriteGranted(join(granted, 'f.txt')), true)
      assert.equal(isWriteGranted(join(base, 'proj-backup', 'secret')), false, 'sibling with common prefix must not match')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('canonicalizes symlinks so a grant cannot be escaped or missed', () => {
    const base = tmp()
    try {
      const realDir = join(base, 'real')
      mkdirSync(realDir)
      const link = join(base, 'link')
      symlinkSync(realDir, link)
      // Grant via the symlink; a check on the real path must still match.
      grantPath(link, 'write')
      assert.equal(isWriteGranted(join(realDir, 'a.txt')), true)
      assert.equal(isWriteGranted(join(link, 'a.txt')), true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('persist round-trips per-workspace and isolates between workspaces', () => {
    const cwdA = tmp()
    const cwdB = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write', { persist: true, cwd: cwdA })
      const file = rivetHome()
      assert.ok(existsSync(file), '.rivet dir exists')

      // Fresh process simulation: reset memory, hydrate from B → nothing.
      _resetGrantsForTest()
      loadPersistedGrants(cwdB)
      assert.equal(isWriteGranted(join(target, 'x')), false, 'grant for A must not leak into B')

      // Hydrate from A → grant restored.
      _resetGrantsForTest()
      loadPersistedGrants(cwdA)
      assert.equal(isWriteGranted(join(target, 'x')), true, 'A grant restored from disk')
    } finally {
      for (const d of [cwdA, cwdB, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('session-only grants do not persist', () => {
    const cwd = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write') // no persist
      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(target, 'x')), false)
    } finally {
      for (const d of [cwd, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('applyConfiguredPathGrants: read and write dirs from config, skipping missing paths', () => {
    const readDir = tmp()
    const writeDir = tmp()
    try {
      applyConfiguredPathGrants({
        additionalReadDirs: [readDir, join(readDir, 'does-not-exist')],
        additionalWriteDirs: [writeDir, '   '],
      })
      assert.equal(isReadGranted(join(readDir, 'a.txt')), true)
      assert.equal(isWriteGranted(join(readDir, 'a.txt')), false, 'read dir must not grant write')
      assert.equal(isWriteGranted(join(writeDir, 'b.txt')), true)
      assert.equal(listGrants().length, 2, 'non-existent and blank entries skipped')
      assert.ok(listGrants().every(g => !g.persisted), 'config grants are session-scoped, never persisted')
    } finally {
      for (const d of [readDir, writeDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('applyConfiguredPathGrants tolerates undefined/empty config', () => {
    applyConfiguredPathGrants(undefined)
    applyConfiguredPathGrants({})
    assert.equal(listGrants().length, 0)
  })

  it('applyDefaultDependencyReadGrants: grants read (not write) for existing HOME caches, skips missing', () => {
    applyDefaultDependencyReadGrants()
    const grants = listGrants()
    // Every auto-granted root is read-only and session-scoped.
    assert.ok(grants.every(g => g.mode === 'read'), 'default dep grants must be read-only')
    assert.ok(grants.every(g => !g.persisted), 'default dep grants must not persist')
    // At least the HOME directory itself is readable through any granted cache
    // root that actually exists on this machine; verify each granted root is
    // both readable and NOT writable, and that a non-existent cache was skipped.
    for (const g of grants) {
      assert.equal(isReadGranted(join(g.root, 'nested', 'file.dart')), true)
      assert.equal(isWriteGranted(join(g.root, 'x')), false, 'read grant must not confer write')
      assert.ok(existsSync(g.root), 'missing dirs must be skipped, not granted')
    }
    // Sanity: the function granted something on any realistic dev machine (one
    // of .cache / .npm / .cargo / .gradle / .pub-cache … exists). CI containers
    // may have a bare HOME, so only assert when at least one candidate exists.
    const candidates = ['.cache', '.npm', '.cargo', '.gradle', '.pub-cache', '.m2', 'go']
    const anyExists = candidates.some(c => existsSync(join(homedir(), c)))
    if (anyExists) assert.ok(grants.length >= 1, 'expected at least one HOME cache to be granted')
  })
})

describe('isPathUnder (win32 case semantics)', () => {
  it('case-insensitive mode matches mixed-case drive letters and segments', () => {
    assert.equal(isPathUnder('F:\\智慧项目', 'f:\\智慧项目', true), true)
    // Note: separator boundary uses the host separator; use posix-style for portability.
    assert.equal(isPathUnder('/proj/Sub', '/proj/sub/file.ts', true), true)
    assert.equal(isPathUnder('/PROJ', '/proj', true), true)
  })

  it('case-sensitive mode (posix) does not fold case', () => {
    assert.equal(isPathUnder('/proj/Sub', '/proj/sub/file.ts', false), false)
    assert.equal(isPathUnder('/proj/sub', '/proj/sub/file.ts', false), true)
  })

  it('separator boundary holds in both modes', () => {
    assert.equal(isPathUnder('/a/b', '/a/bc/x', true), false)
    assert.equal(isPathUnder('/a/b', '/a/bc/x', false), false)
  })
})
