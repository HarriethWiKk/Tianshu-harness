/**
 * Session transcript codec: concatenated Zstandard frames with torn-tail
 * recovery, plus legacy plain-text passthrough.
 *
 * Format: a session transcript file is either
 *   - a legacy plain-text JSONL file (one checksummed JSON object per line), or
 *   - a concatenation of independently decodable zstd frames, each holding a
 *     batch of JSONL text (same line format inside the frame).
 *
 * Frames are self-describing via the zstd frame magic, so no container header
 * is needed. The final frame may be truncated by a crash (torn tail); readers
 * drop it — equivalent to the pre-existing lossy-window + orphan-repair
 * recovery semantics for plain lines.
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** zstd frame magic as read by UInt32LE (0x28 0xB5 0x2F 0xFD big-endian). */
export const ZSTD_MAGIC_LE = 0xfd2fb528

const CHECKSUM_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number
}

/**
 * Locate complete frames without decompressing their blocks (RFC 8878 frame
 * header walk). Invalid complete structure rejects; EOF inside the final
 * frame returns its start so callers can drop it.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC_LE) {
      throw new Error(`corrupt session transcript: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt session transcript: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt session transcript: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return { frames }
}

/** Detect a zstd frame stream by its leading magic bytes. */
export function isZstdFrameStream(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC_LE
}

/**
 * Compress one batch of JSONL text into a single checksummed, independently
 * decodable frame. Empty text yields an empty buffer (callers skip the write).
 */
export function encodeBatch(text: string): Buffer {
  if (text.length === 0) return Buffer.alloc(0)
  return zstdCompressSync(Buffer.from(text, 'utf-8'), CHECKSUM_OPTIONS)
}

/**
 * Decode a transcript file's bytes back to JSONL text. Zstd frame streams are
 * scanned structurally (torn final frame dropped, corruption throws); legacy
 * plain text passes through unchanged.
 */
export function decodeTranscriptText(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  if (!isZstdFrameStream(buffer)) return buffer.toString('utf-8')
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) return ''
  const parts: string[] = []
  for (const frame of frames) {
    const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    parts.push(plain.toString('utf-8'))
  }
  return parts.join('')
}
