import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackFileRestore, renderRecoveryStack, evictOldBackups, trackFileChange } from '../recovery-stack.js'
import { readUnacknowledged } from '../recovery-journal.js'

/** 造 N 个数字命名的备份目录（名字 = Date.now() 格式的时间戳，越早越旧）。 */
function seedBackupDirs(backupsDir: string, count: number, startTs: number): void {
  for (let i = 0; i < count; i++) {
    mkdirSync(join(backupsDir, String(startTs + i)), { recursive: true })
  }
}

describe('recovery-stack', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-recovery-'))

  it('tracks file restore events in journal', () => {
    trackFileRestore(cwd, 'src/a.ts', 'undo tool restore', 5)
    const entries = readUnacknowledged(cwd)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.file, 'src/a.ts')
    assert.match(renderRecoveryStack(cwd), /src\/a.ts/)
  })

  it('evictOldBackups keeps the newest 100 numeric dirs and leaves foreign dirs alone', () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    seedBackupDirs(backupsDir, 105, 1_700_000_000_000)
    mkdirSync(join(backupsDir, 'not-a-timestamp'), { recursive: true })

    evictOldBackups(cwd)

    const remaining = readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    // 105 数字目录 → 保留最新 100（时间戳 1_700_000_000_005 … 1_700_000_000_104）
    const numeric = remaining.filter(n => /^\d+$/.test(n))
    assert.equal(numeric.length, 100, `expected 100 numeric dirs, got ${numeric.length}: ${numeric.join(',')}`)
    assert.equal(numeric[0], '1700000000005', 'oldest numeric dirs must be evicted')
    assert.ok(remaining.includes('not-a-timestamp'), 'non-numeric dir must never be touched')
  })

  it('trackFileChange triggers eviction past the cap', () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    // 清掉上一个用例的残留，重新造 101 个旧目录
    rmSync(backupsDir, { recursive: true, force: true })
    seedBackupDirs(backupsDir, 101, 1_700_000_000_000)
    const target = join(cwd, 'src', 'x.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'v1', 'utf-8')

    trackFileChange(cwd, { filePath: 'src/x.ts', action: 'write', toolCallId: 't1' })

    const numeric = readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
    assert.equal(numeric.length, 100, `expected 100 numeric dirs after eviction, got ${numeric.length}`)
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })
})
