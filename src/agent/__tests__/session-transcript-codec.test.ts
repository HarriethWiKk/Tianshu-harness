import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeBatch,
  decodeTranscriptText,
  scanZstdFrames,
  ZSTD_MAGIC_LE,
} from '../session-transcript-codec.js'

const sampleLines = [
  '{"role":"user","content":"hello"}|a1b2c3d4',
  '{"role":"assistant","content":"世界".repeat(500)}|e5f6a7b8',
  '{"role":"tool","content":"ok"}|deadbeef',
].join('\n')

test('roundtrip: encode one batch then decode returns identical text', () => {
  const frame = encodeBatch(sampleLines)
  assert.ok(frame.length > 0)
  assert.equal(frame.readUInt32LE(0), ZSTD_MAGIC_LE, 'frame starts with zstd magic')
  const text = decodeTranscriptText(frame)
  assert.equal(text, sampleLines)
})

test('multi-frame stream: concatenated frames decode in order', () => {
  const part1 = 'line-a|aaaa\nline-b|bbbb\n'
  const part2 = 'line-c|cccc\n'
  const concat = Buffer.concat([encodeBatch(part1), encodeBatch(part2)])
  assert.equal(decodeTranscriptText(concat), part1 + part2)
})

test('torn tail frame is dropped, complete frames survive', () => {
  const full1 = encodeBatch('survives|1111\n')
  const full2 = encodeBatch('also-survives|2222\n')
  const torn = encodeBatch('torn-content|3333\n')
  // Cut the final frame mid-way (keep magic + part of the frame).
  const cut = torn.subarray(0, Math.max(5, Math.floor(torn.length / 2)))
  assert.ok(cut.length < torn.length, 'probe setup: truncated frame is shorter')
  const concat = Buffer.concat([full1, full2, cut])
  assert.equal(decodeTranscriptText(concat), 'survives|1111\nalso-survives|2222\n')
})

test('corrupt magic after a valid frame throws', () => {
  const full = encodeBatch('ok|1111\n')
  const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
  const concat = Buffer.concat([full, garbage])
  assert.throws(() => decodeTranscriptText(concat), /corrupt|magic|frame/i)
})

test('legacy plain text passes through unchanged', () => {
  const legacy = Buffer.from(sampleLines, 'utf-8')
  assert.equal(decodeTranscriptText(legacy), sampleLines)
})

test('empty buffer decodes to empty string', () => {
  assert.equal(decodeTranscriptText(Buffer.alloc(0)), '')
})

test('encodeBatch of empty text returns empty buffer', () => {
  assert.equal(encodeBatch('').length, 0)
})

test('single line larger than 100KB roundtrips', () => {
  const big = '{"role":"tool","content":"' + 'x'.repeat(120_000) + '"}|cafebabe'
  const frame = encodeBatch(big)
  assert.equal(decodeTranscriptText(frame), big)
})

test('frame checksum: flipping trailing checksum bytes makes decompression fail', () => {
  const frame = encodeBatch(sampleLines)
  const scan = scanZstdFrames(frame)
  assert.equal(scan.frames.length, 1)
  assert.equal(scan.tornStart, undefined)
  // ChecksumFlag=1 appends a 4-byte content checksum at the frame end.
  const corrupted = Buffer.from(frame)
  const end = scan.frames[0]!.end
  corrupted[end - 1] = corrupted[end - 1]! ^ 0xff
  assert.throws(() => decodeTranscriptText(corrupted), /zstd|decompress|checksum/i)
})

test('scanZstdFrames reports tornStart for a header-only prefix', () => {
  const frame = encodeBatch('content|aaaa\n')
  const prefix = frame.subarray(0, 5) // magic + 1 descriptor byte
  const scan = scanZstdFrames(prefix)
  assert.equal(scan.frames.length, 0)
  assert.equal(scan.tornStart, 0)
})
