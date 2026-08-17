import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 旧版（v1）库的最小 schema 副本——只含本测试涉及的遥测表。
 * meridian-db 的 SCHEMA 是模块内部常量，测试通过独立连接构造 user_version=1
 * 的旧库来验证 migrateToV2 的清理行为。
 */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS p3_state (
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(kind, version)
);
CREATE TABLE IF NOT EXISTS access_log (
  file_path TEXT NOT NULL,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sensorimotor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_hash TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meridian_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * 构造 user_version=1 的旧版库：
 * - p3_state：40 天前事件型（应删）/ 40 天前状态型 bandit:reasoning_effort（应保留）/ 新事件型（应保留）
 * - access_log：100 天前（应删）/ 现在（应保留）
 * - sensorimotor_log：100 天前 success=0（应删）/ 现在 success=1（应保留）
 */
function seedLegacyDb(dir: string): void {
  const Database = resolveBetterSqlite3(import.meta.url)
  const conn = new Database(join(dir, 'meridian.db'))
  conn.exec(LEGACY_SCHEMA)
  conn.pragma('user_version = 1')
  conn.prepare(`INSERT INTO p3_state (kind, version, json, updated_at) VALUES (?, 1, ?, datetime('now','-40 days'))`).run('routing_shadow:session1:1:1000', '{}')
  conn.prepare(`INSERT INTO p3_state (kind, version, json, updated_at) VALUES (?, 1, ?, datetime('now','-40 days'))`).run('bandit:reasoning_effort', '{}')
  conn.prepare(`INSERT INTO p3_state (kind, version, json, updated_at) VALUES (?, 1, ?, datetime('now'))`).run('routing_shadow:session2:1:2000', '{}')
  conn.prepare(`INSERT INTO access_log (file_path, accessed_at) VALUES (?, datetime('now','-100 days'))`).run('src/old.ts')
  conn.prepare(`INSERT INTO access_log (file_path, accessed_at) VALUES (?, datetime('now'))`).run('src/new.ts')
  conn.prepare(`INSERT INTO sensorimotor_log (context_hash, tool_name, success, duration_ms, turn, created_at) VALUES (?, 'read_file', 0, 10, 1, datetime('now','-100 days'))`).run('old-hash')
  conn.prepare(`INSERT INTO sensorimotor_log (context_hash, tool_name, success, duration_ms, turn, created_at) VALUES (?, 'read_file', 1, 10, 1, datetime('now'))`).run('new-hash')
  conn.close()
}

/** 直接对 db 文件注入一行过期事件（绕过公共 API——saveBanditState 的 updated_at 不可控）。 */
function injectExpiredEvent(dir: string, kind: string): void {
  const Database = resolveBetterSqlite3(import.meta.url)
  const conn = new Database(join(dir, 'meridian.db'))
  conn.prepare(`INSERT INTO p3_state (kind, version, json, updated_at) VALUES (?, 1, '{}', datetime('now','-40 days'))`).run(kind)
  conn.close()
}

/** 把 meridian_meta.last_cleanup_at 拨到 N 小时前，模拟"很久没清理"。 */
function backdateCleanupGate(dir: string, hoursAgo: number): void {
  const Database = resolveBetterSqlite3(import.meta.url)
  const conn = new Database(join(dir, 'meridian.db'))
  conn.prepare(`INSERT OR REPLACE INTO meridian_meta (key, value) VALUES ('last_cleanup_at', ?)`).run(String(Date.now() - hoursAgo * 3600 * 1000))
  conn.close()
}

describe('meridian cleanup', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-cleanup-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('migrateToV2 purges expired event rows, preserves state rows and fresh rows', () => {
    seedLegacyDb(dir)
    const db = new MeridianDb(dir)
    void db.available // 触发懒初始化 → migrateToV2

    // p3_state：40 天前事件型已删
    assert.equal(db.loadBanditState('routing_shadow:session1:1:1000'), null)
    // 状态型白名单保留（即使 40 天前）
    assert.ok(db.loadBanditState('bandit:reasoning_effort') !== null)
    // 新事件型保留
    assert.ok(db.loadBanditState('routing_shadow:session2:1:2000') !== null)
    // 前缀加载只剩新行
    assert.equal(db.loadBanditStatesByPrefix('routing_shadow:', 1000).length, 1)

    // access_log：100 天前删、新行留
    assert.equal(db.getAccessCount('src/old.ts'), 0)
    assert.equal(db.getAccessCount('src/new.ts'), 1)

    // sensorimotor_log：100 天前 success=0 已删 → 窗口内只有 success=1
    assert.equal(db.getToolSuccessRate('read_file', 10), 1)

    db.close()
  })

  it('migrateToV2 is idempotent across reopens', () => {
    seedLegacyDb(dir)
    let db = new MeridianDb(dir)
    void db.available
    db.close()

    db = new MeridianDb(dir)
    void db.available // 第二次 open：user_version=2 跳过迁移，不报错、不重复清理
    assert.equal(db.loadBanditState('routing_shadow:session1:1:1000'), null)
    assert.ok(db.loadBanditState('routing_shadow:session2:1:2000') !== null)
    db.close()
  })

  it('cleanupExpiredRows respects the 24h gate', () => {
    seedLegacyDb(dir)
    let db = new MeridianDb(dir)
    void db.available // 迁移 → last_cleanup_at = now

    // 注入一条过期事件行
    injectExpiredEvent(dir, 'routing_shadow:session3:1:3000')

    // 门槛内（last_cleanup_at=now）重新 open：不清理
    db.close()
    db = new MeridianDb(dir)
    void db.available
    assert.ok(db.loadBanditState('routing_shadow:session3:1:3000') !== null)
    db.close()

    // 门槛拨到 25h 前 → 重新 open：清理
    backdateCleanupGate(dir, 25)
    db = new MeridianDb(dir)
    void db.available
    assert.equal(db.loadBanditState('routing_shadow:session3:1:3000'), null)
    db.close()
  })
})
