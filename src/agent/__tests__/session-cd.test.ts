import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateSessionFiles } from '../session-cd.js'
import { getSessionDir } from '../session-persist.js'

/**
 * /cd session migration — files move from the old cwd's slug dir to the new
 * one's (RIVET_HOME redirected so each fake cwd gets its own slug dir).
 * Claims files deliberately stay behind (live ContextClaimStore closures).
 */

describe('migrateSessionFiles (/cd 会话迁移)', () => {
  let home: string
  let oldCwd: string
  let newCwd: string
  let prevHome: string | undefined
  let prevSessionDir: string | undefined

  const sid = 'sess1234-abcd'

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-cd-home-'))
    oldCwd = mkdtempSync(join(tmpdir(), 'rivet-cd-old-'))
    newCwd = mkdtempSync(join(tmpdir(), 'rivet-cd-new-'))
    prevHome = process.env.RIVET_HOME
    prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_HOME = home
    // RIVET_SESSION_DIR 会压过 slug 派生（所有 cwd 共用一个目录）——本测试
    // 验证的正是跨 slug 迁移，必须确保它未设置。
    delete process.env.RIVET_SESSION_DIR
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(home, { recursive: true, force: true })
    rmSync(oldCwd, { recursive: true, force: true })
    rmSync(newCwd, { recursive: true, force: true })
  })

  function seedOldSession(): { oldDir: string; newDir: string } {
    const oldDir = getSessionDir(oldCwd)
    const newDir = getSessionDir(newCwd)
    assert.notEqual(oldDir, newDir, 'different cwds must produce different slug dirs')
    mkdirSync(join(oldDir, sid, 'backups'), { recursive: true })
    writeFileSync(join(oldDir, `${sid}.jsonl`), '{"role":"user"}\n')
    writeFileSync(join(oldDir, `${sid}.meta.json`), JSON.stringify({ cwd: oldCwd }))
    writeFileSync(join(oldDir, `${sid}.memory.json`), '{}')
    writeFileSync(join(oldDir, `${sid}.handoff.md`), '# handoff')
    writeFileSync(join(oldDir, `${sid}.goal.json`), '{"state":"paused"}')
    writeFileSync(join(oldDir, `${sid}.frozen.json`), '{"v":1}')
    writeFileSync(join(oldDir, `${sid}.claims.jsonl`), '{"type":"claim_proposed"}\n')
    writeFileSync(join(oldDir, sid, 'cache-log.jsonl'), '{}\n')
    writeFileSync(join(oldDir, sid, 'backups', 'b1.jsonl'), '{}\n')
    return { oldDir, newDir }
  }

  it('moves conversation/meta/memory/handoff and the per-session subdir to the new slug dir', () => {
    const { oldDir, newDir } = seedOldSession()
    const res = migrateSessionFiles(sid, oldCwd, newCwd)

    assert.deepEqual([...res.moved].sort(), [
      `${sid}.frozen.json`,
      `${sid}.goal.json`,
      `${sid}.handoff.md`,
      `${sid}.jsonl`,
      `${sid}.memory.json`,
      `${sid}.meta.json`,
      `${sid}/`,
    ].sort())

    for (const name of [`${sid}.jsonl`, `${sid}.meta.json`, `${sid}.memory.json`, `${sid}.handoff.md`, `${sid}.goal.json`, `${sid}.frozen.json`]) {
      assert.ok(!existsSync(join(oldDir, name)), `${name} must leave the old dir`)
      assert.ok(existsSync(join(newDir, name)), `${name} must land in the new dir`)
    }
    assert.ok(existsSync(join(newDir, sid, 'cache-log.jsonl')), 'subdir contents move with it')
    assert.ok(existsSync(join(newDir, sid, 'backups', 'b1.jsonl')))
    assert.ok(!existsSync(join(oldDir, sid)), 'old subdir must be gone')
    // 内容不损坏
    assert.equal(readFileSync(join(newDir, `${sid}.jsonl`), 'utf-8'), '{"role":"user"}\n')
  })

  it('leaves claims files in the old dir (live claimStore closures keep writing there)', () => {
    const { oldDir, newDir } = seedOldSession()
    migrateSessionFiles(sid, oldCwd, newCwd)
    assert.ok(existsSync(join(oldDir, `${sid}.claims.jsonl`)), 'claims stay with the live store')
    assert.ok(!existsSync(join(newDir, `${sid}.claims.jsonl`)))
  })

  it('no-op when both cwds resolve to the same session dir', () => {
    const { oldDir } = seedOldSession()
    const res = migrateSessionFiles(sid, oldCwd, oldCwd)
    assert.deepEqual(res.moved, [])
    assert.ok(existsSync(join(oldDir, `${sid}.jsonl`)), 'files untouched')
  })

  it('skips missing files and still creates the new dir', () => {
    const oldDir = getSessionDir(oldCwd)
    const newDir = getSessionDir(newCwd)
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, `${sid}.jsonl`), '{"role":"user"}\n')
    const res = migrateSessionFiles(sid, oldCwd, newCwd)
    assert.deepEqual(res.moved, [`${sid}.jsonl`])
    assert.ok(existsSync(join(newDir, `${sid}.jsonl`)))
  })
})
