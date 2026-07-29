/**
 * VSW 快照的 owner marker 契约。
 *
 * 事故：`.rivet/vsw/` 积到 33 个快照工作树、1.9 GB，最老的存活三周。回收器
 * `reapOrphanSnapshots` 每次会话启动都跑，但 `createWorktreeAt` / `createWorktreeAtAsync`
 * —— VSW 真正走的创建路径 —— 从不写 owner marker；回收器读不到 marker 就走
 * 「无法证明所有者已死 → 保留」的 fail-safe 分支，于是结构上永远不可能回收任何一个
 * VSW 快照。
 *
 * 为什么一直没被发现：回收器的既有测试用 `plantVsw` 自己手写 marker，伪造了生产
 * 从不写入的文件。fail-safe 那一侧有测试，「生产真的会留下 marker」这一侧没有。
 * 本文件补的就是后者。
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { createWorktreeAt, createWorktreeAtAsync } from '../worktree.js'
import { reapOrphanSnapshots } from '../verification-snapshot-manager.js'

const OWNER_FILE = '.vsw-owner.json'
const dirs: string[] = []

after(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-vsw-marker-'))
  dirs.push(dir)
  const git = (args: string): void => {
    execSync(`git ${args}`, { cwd: dir, stdio: 'ignore' })
  }
  git('init -b main')
  git('config user.email test@test.com')
  git('config user.name Test')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf-8')
  git('add a.ts')
  git('commit -m base')
  return dir
}

function readMarker(wtPath: string): { pid?: unknown; sessionId?: unknown } {
  return JSON.parse(readFileSync(join(wtPath, OWNER_FILE), 'utf-8')) as { pid?: unknown; sessionId?: unknown }
}

describe('VSW 创建路径必须留下 owner marker', () => {
  it('createWorktreeAtAsync 写下 marker，含本进程 pid 与 sessionId', async () => {
    const repo = makeRepo()
    const wtPath = join(repo, '.rivet', 'vsw', 'sess-async')

    await createWorktreeAtAsync(repo, wtPath, 'HEAD', 'sess-async')

    assert.ok(existsSync(join(wtPath, OWNER_FILE)), '缺 marker → 回收器永远不会回收这个快照')
    const marker = readMarker(wtPath)
    assert.equal(marker.pid, process.pid, 'pid 必须可用于判活')
    assert.equal(marker.sessionId, 'sess-async')
  })

  it('createWorktreeAt（同步版）同样写下 marker', () => {
    const repo = makeRepo()
    const wtPath = join(repo, '.rivet', 'vsw', 'sess-sync')

    createWorktreeAt(repo, wtPath, 'HEAD', 'sess-sync')

    assert.ok(existsSync(join(wtPath, OWNER_FILE)), '同步路径同样会漏')
    assert.equal(readMarker(wtPath).pid, process.pid)
  })

  it('不传 sessionId 时不写 marker —— 调用方未声明归属就不该被自动回收', async () => {
    const repo = makeRepo()
    const wtPath = join(repo, '.rivet', 'vsw', 'sess-anon')

    await createWorktreeAtAsync(repo, wtPath, 'HEAD')

    assert.equal(existsSync(join(wtPath, OWNER_FILE)), false)
  })

  it('闭环：真实创建路径产出的快照，在所有者死后能被回收器收走', async () => {
    const repo = makeRepo()
    const wtPath = join(repo, '.rivet', 'vsw', 'sess-dead')
    await createWorktreeAtAsync(repo, wtPath, 'HEAD', 'sess-dead')

    // 所有者已死 → 应被回收。这是 33 个快照本该走却从未走到的那条路径。
    const result = reapOrphanSnapshots({ baseCwd: repo, isAlive: () => false })

    assert.deepEqual(result.reaped, ['sess-dead'], `实得 reaped=${JSON.stringify(result.reaped)} kept=${JSON.stringify(result.kept)}`)
    assert.equal(existsSync(wtPath), false, '目录应被清掉')
  })
})
