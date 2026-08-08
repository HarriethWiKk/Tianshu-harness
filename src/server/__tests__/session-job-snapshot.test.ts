import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
} from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { JobSnapshot } from '../../tools/job-store.js'
import type { ServerResponse } from 'node:http'

/**
 * H2 — 后台任务建连快照（job_snapshot 合成事件）：
 *  - /stream 回放在 replay_window 之后、回放主体之前发出 job_snapshot
 *  - 内容为服务端注册表当前 running 任务全集（终态被过滤）
 *  - 注册表为空也发（jobs: []）——那是 sidecar 重启后「全部悬挂」的清场信号
 * 桌面端 hub 拦截该 seq=0 事件做 upsert + 摘除对账（见 session-event-hub）。
 */

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function mockRes() {
  const writes: string[] = []
  let corked = false
  let corkBuffer: string[] = []
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(chunk: string) {
      if (corked) corkBuffer.push(chunk)
      else writes.push(chunk)
      return true
    },
    end() {},
    cork() { corked = true },
    uncork() {
      corked = false
      if (corkBuffer.length > 0) {
        writes.push(corkBuffer.join(''))
        corkBuffer = []
      }
    },
    on() {},
    writableEnded: false,
  }
  return { res: res as unknown as ServerResponse, writes }
}

/** 拆分 SSE 帧为 { event, payload } 列表（忽略 keepalive 注释帧）。 */
function parseFrames(writes: string[]): Array<{ event: string; payload: { seq: number; type: string; data: Record<string, unknown> } }> {
  return writes
    .join('')
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('event: '))
    .map((f) => ({
      event: f.slice(7, f.indexOf('\n')),
      payload: JSON.parse(f.slice(f.indexOf('data: ') + 6)) as { seq: number; type: string; data: Record<string, unknown> },
    }))
}

test('GET /stream：注册表为空也发 job_snapshot（jobs: [] 清场信号），帧序在回放主体之前', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  await routes['GET /sessions/:id/stream']!({}, { id, since: '0' }, AUTH, res)

  const frames = parseFrames(writes)
  assert.equal(frames[0]?.event, 'replay_window', '首帧仍是 replay_window')
  assert.equal(frames[1]?.event, 'job_snapshot', '次帧是 job_snapshot')
  assert.equal(frames[1]!.payload.seq, 0, '合成事件 seq 恒为 0（不进 fold 幂等账本）')
  assert.deepEqual(frames[1]!.payload.data, { jobs: [] }, '空注册表 = 空快照（重启悬挂对账信号）')
  // 该会话无任何领域事件——快照之后不应再有别的帧。
  assert.equal(frames.length, 2)
})

test('GET /stream：job_snapshot 只携带 running 任务（终态过滤），字段完整', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  // 不起真实子进程——直接在 manager 上桩住 listJobs（注册表内容本身由
  // SessionJobs 的实现保证，这里锁的是路由的筛选与透传）。
  const snapshots: JobSnapshot[] = [
    { id: 'j-run', command: 'npm run dev', status: 'running', startedAt: 1000, lastLine: 'compiled', pid: 42 },
    { id: 'j-done', command: 'echo hi', status: 'exited', exitCode: 0, startedAt: 500, endedAt: 900, lastLine: 'hi' },
    { id: 'j-killed', command: 'sleep 9', status: 'killed', exitCode: 143, startedAt: 600, endedAt: 950, lastLine: '' },
  ]
  ;(mgr as unknown as { listJobs: (sessionId: string) => JobSnapshot[] }).listJobs = () => snapshots

  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  await routes['GET /sessions/:id/stream']!({}, { id, since: '0' }, AUTH, res)

  const frames = parseFrames(writes)
  const snap = frames.find((f) => f.event === 'job_snapshot')
  assert.ok(snap, '必须发出 job_snapshot 帧')
  const jobs = snap!.payload.data.jobs as JobSnapshot[]
  assert.equal(jobs.length, 1, '只携带 running 任务')
  assert.deepEqual(jobs[0], snapshots[0], '字段逐字透传（id/command/status/startedAt/lastLine/pid）')
})
