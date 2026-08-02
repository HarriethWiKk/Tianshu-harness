import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImageRegistry, parseImageDataUrl } from '../image-registry.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('parseImageDataUrl parses mime + payload, rejects junk', () => {
  const ok = parseImageDataUrl(PNG)
  assert.equal(ok?.mime, 'image/png')
  assert.ok(ok?.base64.length)
  assert.equal(parseImageDataUrl('not a data url'), null)
  assert.equal(parseImageDataUrl('data:text/plain;base64,YWJj'), null)
})

test('register returns short ids in order and skips malformed', () => {
  const reg = new ImageRegistry()
  const ids = reg.register([PNG, 'garbage', PNG])
  assert.equal(ids.length, 2)
  assert.match(ids[0]!, /^img_\d+$/)
  assert.notEqual(ids[0], ids[1])
  assert.equal(reg.size, 2)
})

test('get by id, and get() without id returns most recent', () => {
  const reg = new ImageRegistry()
  reg.register([PNG])
  const [b] = reg.register([PNG])
  // no-id get returns the most-recently-touched (b, freshly registered)
  assert.equal(reg.get()?.id, b)
  assert.equal(reg.get('img_nonexistent'), undefined)
})

test('description cache round-trips per (id, key)', () => {
  const reg = new ImageRegistry()
  const [id] = reg.register([PNG])
  assert.equal(reg.getCachedDescription(id!, 'general'), undefined)
  reg.cacheDescription(id!, 'general', '一张测试图')
  assert.equal(reg.getCachedDescription(id!, 'general'), '一张测试图')
  // different key = independent slot
  assert.equal(reg.getCachedDescription(id!, 'ocr'), undefined)
})

test('LRU evicts oldest-touched beyond maxImages', () => {
  const reg = new ImageRegistry({ maxImages: 2 })
  const [a] = reg.register([PNG])
  const [b] = reg.register([PNG])
  // touch a so b becomes the LRU victim
  reg.get(a)
  const [c] = reg.register([PNG])
  assert.equal(reg.size, 2)
  assert.ok(reg.get(a), 'recently-touched a survives')
  assert.ok(reg.get(c), 'newest c survives')
  assert.equal(reg.get(b), undefined, 'untouched b evicted')
})

test('byte budget evicts until under maxBytes', () => {
  const reg = new ImageRegistry({ maxImages: 100, maxBytes: 1 })
  reg.register([PNG, PNG, PNG])
  // each PNG is > 1 byte, so budget of 1 keeps at most the newest single image
  assert.ok(reg.size <= 1)
})

// 返回的 id 必须都能查到：提示文本里写着 img_N，ask_image 却报"没有这张图"是
// 最难查的那种不一致——调用方无从知道自己拿到的是个已被驱逐的引用。
test('register only returns ids that survived this round of eviction', () => {
  const reg = new ImageRegistry({ maxImages: 100, maxBytes: 1 })
  const ids = reg.register([PNG, PNG, PNG])
  assert.equal(ids.length, reg.size)
  for (const id of ids) assert.ok(reg.get(id), `${id} 必须可查`)
})

test('register returns nothing when a single image blows the whole budget', () => {
  const reg = new ImageRegistry({ maxImages: 4, maxBytes: 1 })
  assert.deepEqual(reg.register([PNG]), [])
  assert.equal(reg.size, 0)
})

test('clear empties the registry', () => {
  const reg = new ImageRegistry()
  reg.register([PNG, PNG])
  reg.clear()
  assert.equal(reg.size, 0)
  assert.equal(reg.get(), undefined)
})

test('list returns newest-first', () => {
  const reg = new ImageRegistry()
  const [a] = reg.register([PNG])
  const [b] = reg.register([PNG])
  const listed = reg.list().map(i => i.id)
  assert.deepEqual(listed, [b, a])
})
