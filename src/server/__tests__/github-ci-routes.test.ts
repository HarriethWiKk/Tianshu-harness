import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { Config } from '../../config/schema.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  run(_p: string, cb: AgentCallbacks) { this.callbacks = cb; return Promise.resolve() }
  abort() {}
  setActivePlan(_plan: { slug: string; title: string } | null) {}
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

const config = { provider: { default: 'deepseek', providers: {} } } as unknown as Config

function setup() {
  const manager = new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN, undefined, config))
  return { manager, router }
}

// ── POST /github/prs/:number/merge — validation & confirm gate ──

test('merge route rejects an invalid PR number', async () => {
  const { router } = setup()
  const res = await router('POST', '/github/prs/0/merge', { method: 'squash', confirm: true }, AUTH)
  assert.equal(res.status, 400)
})

test('merge route rejects an invalid method before any gh call', async () => {
  const { router } = setup()
  const res = await router('POST', '/github/prs/12/merge', { method: 'yeet', confirm: true }, AUTH)
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /merge method/)
})

test('merge route without confirm returns needsConfirm (no gh call)', async () => {
  const { router } = setup()
  for (const body of [{ method: 'squash' }, { method: 'merge', confirm: false }]) {
    const res = await router('POST', '/github/prs/12/merge', body, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as { needsConfirm: boolean }).needsConfirm, true)
  }
})

// ── POST /github/prs/:number/push-fix — validation & confirm gate ──

test('push-fix route validates sessionId/artifactId before anything else', async () => {
  const { router } = setup()
  const noSession = await router('POST', '/github/prs/12/push-fix', { artifactId: 'a1', confirm: true }, AUTH)
  assert.equal(noSession.status, 400)
  const noArtifact = await router('POST', '/github/prs/12/push-fix', { sessionId: 's1', confirm: true }, AUTH)
  assert.equal(noArtifact.status, 400)
})

test('push-fix route without confirm returns needsConfirm', async () => {
  const { router } = setup()
  const res = await router('POST', '/github/prs/12/push-fix', { sessionId: 's1', artifactId: 'a1' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { needsConfirm: boolean }).needsConfirm, true)
})

test('push-fix route 404s on unknown session and unknown artifact', async () => {
  const { router } = setup()
  const unknown = await router('POST', '/github/prs/12/push-fix', { sessionId: 'nope', artifactId: 'a1', confirm: true }, AUTH)
  assert.equal(unknown.status, 404)
  assert.match((unknown.body as { error: string }).error, /Session not found/)

  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const missing = await router('POST', '/github/prs/12/push-fix', { sessionId: id, artifactId: 'nope', confirm: true }, AUTH)
  assert.equal(missing.status, 404)
  assert.match((missing.body as { error: string }).error, /Artifact not found/)
})

// ── GET /github/prs/:number/checks(/:checkIndex/log) — validation ──

test('checks routes reject invalid params before any gh call', async () => {
  const { router } = setup()
  assert.equal((await router('GET', '/github/prs/abc/checks', {}, AUTH)).status, 400)
  assert.equal((await router('GET', '/github/prs/12/checks/-1/log', {}, AUTH)).status, 400)
  assert.equal((await router('GET', '/github/prs/12/checks/1.5/log', {}, AUTH)).status, 400)
})

// ── auth gate ──

test('new github routes require auth', async () => {
  const { router } = setup()
  assert.equal((await router('GET', '/github/prs/12/checks', {}, {})).status, 401)
  assert.equal((await router('POST', '/github/prs/12/merge', { method: 'squash' }, {})).status, 401)
  assert.equal((await router('POST', '/github/prs/12/push-fix', {}, {})).status, 401)
})
