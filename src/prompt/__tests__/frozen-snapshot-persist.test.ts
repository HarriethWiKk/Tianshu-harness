import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { parseFrozenSnapshotData, type FrozenSnapshotData } from '../frozen-snapshot.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * resume 缓存继承（FrozenSnapshotData 盘存形态）——与 /cd 的活引擎继承同语义：
 * 快照经 JSON 落盘往返后水合的新引擎，必须与活引擎继承产出**字节相同**的请求
 * （服务商前缀缓存 TTL 内 resume 只断尾，不再 byte-0 全 miss）。
 * 坏文件/旧版本静默降级为无继承（旧的全量重建行为）。
 */

function mkEngine(cwd: string, marker: string, inheritFrozenFrom?: PromptEngine | FrozenSnapshotData): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd, rivetMd: `# ${marker}` },
    habituationThreshold: 0,
    inheritFrozenFrom,
  })
}

/** Rendered content of the user message whose trailer text is `userText`. */
function renderedUser(messages: readonly OaiMessage[], userText: string): string {
  const msg = messages.find(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.includes(`\n---\n${userText}`),
  )
  assert.ok(msg && typeof msg.content === 'string', `expected rendered user message for "${userText}"`)
  return msg.content
}

const CONVERSATION: OaiMessage[] = [
  { role: 'user', content: 'm1' },
  { role: 'assistant', content: 'r1' },
  { role: 'user', content: 'm2' },
]

describe('FrozenSnapshotData 盘存继承（resume 缓存继承）', () => {
  it('export → JSON 往返 → data 继承，与活引擎继承产出字节相同的请求', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    a.buildOaiRequest(CONVERSATION)

    // 模拟落盘：export 后经 JSON 序列化/解析（readFrozenSnapshot 的输入形态）。
    const diskData = parseFrozenSnapshotData(JSON.parse(JSON.stringify(a.exportFrozenSnapshot())))
    assert.ok(diskData, 'export 的快照必须通过形状校验')

    const fromDisk = mkEngine('/new/project', 'NEW_PROJECT', diskData)
    const fromLive = mkEngine('/new/project', 'NEW_PROJECT', a)
    const diskReq = fromDisk.buildOaiRequest(CONVERSATION)
    const liveReq = fromLive.buildOaiRequest(CONVERSATION)

    assert.deepEqual(diskReq.messages, liveReq.messages, '盘存继承与活引擎继承的请求必须逐字节一致')
    assert.ok(renderedUser(diskReq.messages, 'm1').includes('OLD_PROJECT'), '历史消息恢复旧字节（缓存命中）')
    assert.ok(renderedUser(diskReq.messages, 'm2').includes('NEW_PROJECT'), '活跃边界用新 volatile（诚实上下文）')
  })

  it('export 深拷贝：后续引擎演化不回写已导出的快照', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    const snap = a.exportFrozenSnapshot()
    const before = JSON.stringify(snap)
    a.buildOaiRequest(CONVERSATION) // 推进引擎（commit m1、积累 pending）
    assert.equal(JSON.stringify(snap), before, '已导出快照不得被引擎后续状态污染')
  })

  it('坏形状/旧版本快照静默降级为无继承', () => {
    assert.equal(parseFrozenSnapshotData(null), undefined)
    assert.equal(parseFrozenSnapshotData('junk'), undefined)
    assert.equal(parseFrozenSnapshotData({ v: 2, frozenUserMerged: [], frozenPendingMerged: [], firstUserKey: null, collapseWatermark: 0, collapseTokenStep: -1 }), undefined)
    assert.equal(parseFrozenSnapshotData({ v: 1, frozenUserMerged: 'x', frozenPendingMerged: [], firstUserKey: null, collapseWatermark: 0, collapseTokenStep: -1 }), undefined)

    const garbage = { v: 2 } as unknown as FrozenSnapshotData
    const b = mkEngine('/new/project', 'NEW_PROJECT', garbage)
    const req = b.buildOaiRequest(CONVERSATION)
    assert.ok(
      renderedUser(req.messages, 'm1').includes('NEW_PROJECT'),
      '坏快照必须按无继承处理（旧行为：当前 volatile 重建）',
    )
  })

  it('onFrozenSnapshotCommit 钩子在 user 边界固化时触发，异常被吞', () => {
    const a = mkEngine('/old/project', 'OLD_PROJECT')
    let fired = 0
    a.setOnFrozenSnapshotCommit(() => { fired++ })
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    assert.equal(fired, 0, '首个 user 消息尚无历史可固化')
    a.buildOaiRequest(CONVERSATION) // m2 到达 → m1 成为历史并固化
    assert.equal(fired, 1, '边界固化应恰好触发一次')

    a.setOnFrozenSnapshotCommit(() => { throw new Error('listener bug') })
    a.buildOaiRequest([
      ...CONVERSATION,
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'm3' },
    ])
    // 不抛即通过——hook 异常绝不影响请求构建
  })

  it('写侧组合（= wireFrozenSnapshotPersist）：引擎 hook → SessionPersist 落盘可读回', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { SessionPersist } = await import('../../agent/session-persist.js')
    const dir = mkdtempSync(join(tmpdir(), 'rivet-frozen-wire-'))
    process.env.RIVET_SESSION_DIR = dir
    try {
      const persist = new SessionPersist('wire-frozen-001', dir)
      const a = mkEngine('/old/project', 'OLD_PROJECT')
      // 与 bootstrap.wireFrozenSnapshotPersist 相同的接线组合
      a.setOnFrozenSnapshotCommit(() => persist.writeFrozenSnapshot(a.exportFrozenSnapshot()))
      a.buildOaiRequest([{ role: 'user', content: 'm1' }])
      assert.equal(persist.readFrozenSnapshot(), undefined, '首个 user 消息前不落盘')
      a.buildOaiRequest(CONVERSATION) // 边界固化 m1 → 落盘
      const snap = persist.readFrozenSnapshot()
      assert.ok(snap, '边界后快照应已落盘')
      assert.equal(snap.firstUserKey, 'm1')
      assert.ok(snap.frozenUserMerged.some(([k]) => k === 'm1'), '落盘数据含 m1 锚点')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.RIVET_SESSION_DIR
    }
  })
})
