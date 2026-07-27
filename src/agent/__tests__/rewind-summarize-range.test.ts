/**
 * Rewind 定点摘要（Wave 1-1）。
 *
 * `/compact` 压全部；summarizeRange 只压用户在 rewind 面板圈定的一段。两个 scope
 * 的**缓存代价完全不同**，这正是它们是两个动作而不是一个带标志的动作的原因：
 *  - from：截断点之前的消息必须逐字节不变，前缀照常命中（本文件的核心断言）
 *  - to：改写靠前的字节，前缀必然重建——代价由 UI 标注给用户，引擎不阻拦
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController } from '../compaction-controller.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test' },
  })
}

function summarizingClient(text = 'RANGE SUMMARY'): StreamClient {
  return {
    stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
      callbacks.onTextDelta(text)
    },
  }
}

/** 10 条消息：user/assistant 交替，内容可辨认以便逐字节比对。 */
function makeSession(): SessionContext {
  const session = new SessionContext()
  const msgs: OaiMessage[] = []
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message-${i} ${'x'.repeat(200)}` })
  }
  session.replaceMessages(msgs)
  return session
}

function makeController(
  session: SessionContext,
  overrides: Partial<ConstructorParameters<typeof CompactionController>[0]> = {},
): CompactionController {
  return new CompactionController({
    session,
    promptEngine: makeEngine(),
    contextWindow: 128_000,
    pressureMonitor: new PressureMonitor(128_000),
    getTrajectoryEntries: () => [],
    getStreamedText: () => '',
    refreshLedger: () => {},
    primaryClient: summarizingClient(),
    ...overrides,
  })
}

describe('summarizeRange — scope "from"（压尾部）', () => {
  it('截断点之前的消息逐字节不变，选中消息本身也保留——前缀缓存不受影响', async () => {
    const session = makeSession()
    const before = session.getMessages()
    // UI 文案承诺「把此消息之后的内容压成摘要」——选中消息（idx=4）是保留锚点。
    const head = before.slice(0, 5).map(m => m.content)

    const result = await makeController(session).summarizeRange({ scope: 'from', messageIndex: 4 })

    assert.equal(result.ok, true)
    const after = session.getMessages()
    assert.deepEqual(after.slice(0, 5).map(m => m.content), head, '截断点之前 + 选中消息必须逐字节相同')
    assert.equal(after.length, 6, '尾部 5 条应压成 1 条摘要')
    assert.match(String(after[5]?.content), /rewind-summary scope="from"/)
    assert.match(String(after[5]?.content), /RANGE SUMMARY/)
  })

  it('回报替换条数与 token 变化', async () => {
    const session = makeSession()
    const result = await makeController(session).summarizeRange({ scope: 'from', messageIndex: 4 })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.replaced, 5)
    assert.ok(result.afterTokens < result.beforeTokens, '摘要后 token 必须下降')
  })
})

describe('summarizeRange — scope "to"（压头部）', () => {
  it('保留缓存锚点，压掉锚点到截断点之间，截断点之后逐字节不变', async () => {
    const session = makeSession()
    const before = session.getMessages()
    const anchors = before.slice(0, 2).map(m => m.content)
    const tail = before.slice(7).map(m => m.content)

    const result = await makeController(session).summarizeRange({ scope: 'to', messageIndex: 7 })

    assert.equal(result.ok, true)
    const after = session.getMessages()
    assert.deepEqual(after.slice(0, 2).map(m => m.content), anchors, '缓存锚点保留（与自动压缩同口径）')
    assert.match(String(after[2]?.content), /rewind-summary scope="to"/)
    assert.deepEqual(after.slice(3).map(m => m.content), tail, '截断点之后的对话原样保留')
  })
})

describe('summarizeRange — 失败路径不得改动历史', () => {
  it('模型无输出 → 拒绝且历史不变', async () => {
    const session = makeSession()
    const before = session.getMessages().map(m => m.content)
    const controller = makeController(session, {
      primaryClient: { stream: async () => { /* 一个 delta 都不发 */ } },
    })

    const result = await controller.summarizeRange({ scope: 'from', messageIndex: 4 })

    assert.equal(result.ok, false)
    assert.deepEqual(session.getMessages().map(m => m.content), before, '摘要失败不得留下半截状态')
  })

  it('范围内消息太少 → 拒绝且不发请求', async () => {
    const session = makeSession()
    let called = false
    const controller = makeController(session, {
      primaryClient: {
        stream: async (_r: OaiChatRequest, cb: StreamCallbacks) => { called = true; cb.onTextDelta('x') },
      },
    })

    const result = await controller.summarizeRange({ scope: 'from', messageIndex: 9 })

    assert.equal(result.ok, false)
    assert.equal(called, false, '范围不足时不该浪费一次请求')
  })

  it('未配置摘要客户端 → 拒绝', async () => {
    const session = makeSession()
    const controller = makeController(session, { primaryClient: undefined })

    const result = await controller.summarizeRange({ scope: 'from', messageIndex: 4 })

    assert.equal(result.ok, false)
  })
})

describe('summarizeRange — 归档与记账', () => {
  it('被压掉的原文进归档，摘要里带召回引用', async () => {
    const session = makeSession()
    const saved: string[] = []
    const controller = makeController(session, {
      archiveHistory: async (input) => { saved.push(input.rawContent); return 'compact-history:r1' },
    })

    const result = await controller.summarizeRange({ scope: 'from', messageIndex: 4 })

    assert.equal(result.ok, true)
    assert.equal(saved.length, 1, '被丢弃的区段必须可召回，不能凭空消失')
    assert.match(String(session.getMessages()[5]?.content), /compact-history:r1/)
  })

  it('记一条 compact 事件，便于事后核账', async () => {
    const session = makeSession()
    await makeController(session).summarizeRange({ scope: 'from', messageIndex: 4 })

    const events = session.getCompactEvents()
    assert.equal(events.length, 1)
    assert.match(String(events[0]?.reason), /rewind summarize-from/)
  })

  // 用户显式点的动作不该被经济性闸门否决——那个闸门是给系统自作主张的压缩用的。
  it('不受回收闸门否决：收益很小也照做', async () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ])
    let vetoed = false
    const controller = makeController(session, {
      onReclaimDecision: () => { vetoed = true },
    })

    const result = await controller.summarizeRange({ scope: 'from', messageIndex: 1 })

    assert.equal(result.ok, true, '用户显式请求必须执行')
    assert.equal(vetoed, false, '不该走回收闸门')
  })
})
