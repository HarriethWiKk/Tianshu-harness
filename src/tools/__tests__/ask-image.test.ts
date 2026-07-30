import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_IMAGE_TOOL } from '../ask-image.js'
import type { ToolCallParams, VisionAskResult } from '../types.js'

function params(input: Record<string, unknown>, visionAsk?: ToolCallParams['visionAsk']): ToolCallParams {
  return { input, toolUseId: 't1', cwd: '/tmp', visionAsk } as ToolCallParams
}

test('ask_image requires a non-empty question', async () => {
  const r = await ASK_IMAGE_TOOL.execute(params({ question: '  ' }, async () => ({ answer: 'x' })))
  assert.equal(r.isError, true)
  assert.match(r.content, /question/)
})

test('ask_image without visionAsk handle → vision unavailable', async () => {
  const r = await ASK_IMAGE_TOOL.execute(params({ question: '这是什么' }))
  assert.equal(r.isError, true)
  assert.match(r.content, /不可用/)
})

test('text-only primary → returns the bridge answer as content', async () => {
  const r = await ASK_IMAGE_TOOL.execute(params(
    { question: '第一行报错是什么' },
    async (_id, q) => ({ answer: `答：${q}` }),
  ))
  assert.equal(r.isError, undefined)
  assert.equal(r.content, '答：第一行报错是什么')
  assert.equal(r.images, undefined)
})

test('cached answer appends a cache note', async () => {
  const r = await ASK_IMAGE_TOOL.execute(params(
    { question: 'x' },
    async () => ({ answer: '缓存的答案', cached: true }),
  ))
  assert.match(r.content, /缓存/)
})

test('multimodal primary → returns forwardImage as ToolResult.images', async () => {
  const dataUrl = 'data:image/png;base64,abc'
  const r = await ASK_IMAGE_TOOL.execute(params(
    { question: '看这张图', imageId: 'img_2' },
    async () => ({ forwardImage: dataUrl }),
  ))
  assert.equal(r.isError, undefined)
  assert.deepEqual(r.images, [dataUrl])
  assert.match(r.content, /img_2/)
})

test('visionAsk error → isError with the reason', async () => {
  const r = await ASK_IMAGE_TOOL.execute(params(
    { question: 'x', imageId: 'img_9' },
    async () => ({ error: '没有 id 为 img_9 的图片' }),
  ))
  assert.equal(r.isError, true)
  assert.match(r.content, /img_9/)
})

test('imageId is forwarded to the handle; omitted → undefined', async () => {
  let seenId: string | undefined = 'sentinel'
  await ASK_IMAGE_TOOL.execute(params(
    { question: 'x' },
    async (id) => { seenId = id; return { answer: 'ok' } },
  ))
  assert.equal(seenId, undefined)

  await ASK_IMAGE_TOOL.execute(params(
    { question: 'x', imageId: 'img_3' },
    async (id) => { seenId = id; return { answer: 'ok' } },
  ))
  assert.equal(seenId, 'img_3')
})

test('empty answer + no forward → isError', async () => {
  const r = await ASK_IMAGE_TOOL.execute(params(
    { question: 'x' },
    async () => ({} as VisionAskResult),
  ))
  assert.equal(r.isError, true)
})

test('ask_image is read-only, concurrency-safe, no approval', () => {
  assert.equal(ASK_IMAGE_TOOL.requiresApproval(params({})), false)
  assert.equal(ASK_IMAGE_TOOL.isConcurrencySafe(), true)
  assert.equal(ASK_IMAGE_TOOL.isEnabled(), true)
})
