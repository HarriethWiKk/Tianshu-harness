import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shapeSearchHits } from '../semantic-search.js'
import { LOW_CONFIDENCE_MARKER } from '../../repo/surgical-shaper.js'

interface Hit { file: string; startLine: number; endLine: number; text: string; score: number }

function hit(file: string, startLine: number, score: number, text = 'const x = 1\n'): Hit {
  return { file, startLine, endLine: startLine + 5, text, score }
}

describe('semantic_search surgical shaping（wave4 T8 接线）', () => {
  it('单文件垄断被 per-file cap 裁剪，其他文件的命中保留', () => {
    // limit=10 → per-file cap = max(5, ceil(10*0.2)) = 5
    const hits: Hit[] = [
      ...Array.from({ length: 8 }, (_, i) => hit('src/big.ts', i * 10 + 1, 0.9 - i * 0.01)),
      hit('src/other.ts', 1, 0.5),
      hit('src/second.ts', 1, 0.4),
    ]
    const { formatted } = shapeSearchHits(hits, 'big module', 10)
    const bigCount = formatted.filter(f => f.startsWith('src/big.ts:')).length
    assert.equal(bigCount, 5, 'big.ts 应被 per-file cap 限到 5')
    assert.ok(formatted.some(f => f.startsWith('src/other.ts:')), 'other.ts 命中应保留')
    assert.ok(formatted.some(f => f.startsWith('src/second.ts:')), 'second.ts 命中应保留')
  })

  it('非测试查询时测试文件被降权限额（≤ max(3, 15%)）', () => {
    // limit=10 → test cap = max(3, ceil(10*0.15)) = 3
    const hits: Hit[] = [
      ...Array.from({ length: 6 }, (_, i) => hit(`src/__tests__/t${i}.test.ts`, 1, 0.9 - i * 0.01)),
      ...Array.from({ length: 4 }, (_, i) => hit(`src/mod${i}.ts`, 1, 0.5 - i * 0.01)),
    ]
    const { formatted } = shapeSearchHits(hits, 'session cache', 10)
    const testCount = formatted.filter(f => f.includes('__tests__/')).length
    assert.equal(testCount, 3, '非测试查询下测试块应限到 3')
    const srcCount = formatted.filter(f => /^src\/mod\d/.test(f)).length
    assert.equal(srcCount, 4, '非测试文件命中应全部保留')
  })

  it('测试相关查询跳过测试文件降权', () => {
    const hits: Hit[] = Array.from({ length: 6 }, (_, i) => hit(`src/__tests__/t${i}.test.ts`, 1, 0.9 - i * 0.01))
    const { formatted } = shapeSearchHits(hits, 'test coverage for session', 10)
    assert.equal(formatted.length, 6, '测试查询不应降权测试文件')
  })

  it('多词泛化查询无强佐证 → 低置信标注；命中路径与词项吻合 → 无标注', () => {
    const vague = shapeSearchHits(
      [hit('src/a.ts', 1, 0.3), hit('src/b.ts', 1, 0.2)],
      'persistence handling logic',
      10,
    )
    assert.ok(vague.note, '泛化查询应产生低置信标注')
    assert.ok(vague.note.includes(LOW_CONFIDENCE_MARKER))

    const precise = shapeSearchHits(
      [hit('src/search/semantic-index.ts', 1, 0.9)],
      'semantic search',
      10,
    )
    assert.equal(precise.note, null, '路径与词项双重吻合不应标低置信')
  })

  it('保持 file:start-end (score x.xxx) 输出形状与分数降序', () => {
    const hits: Hit[] = [hit('src/a.ts', 3, 0.9), hit('src/b.ts', 7, 0.5)]
    const { formatted } = shapeSearchHits(hits, 'anything', 10)
    assert.match(formatted[0]!, /^src\/a\.ts:3-8 \(score 0\.900\)\n/)
    assert.match(formatted[1]!, /^src\/b\.ts:7-12 \(score 0\.500\)\n/)
  })

  it('单块超长内容被截到 300 字符并带截断标记', () => {
    const long = 'x'.repeat(500)
    const { formatted } = shapeSearchHits([hit('src/a.ts', 1, 0.9, long)], 'anything', 10)
    assert.ok(formatted[0]!.includes('... (truncated) ...'), '应有截断标记')
    // 头行 + 300 字符 + 截断后缀以内
    assert.ok(formatted[0]!.length < 400, `格式化块应被截断（实际 ${formatted[0]!.length}）`)
  })

  it('空命中返回空数组且无标注（no-matches 语义归调用方）', () => {
    const { formatted, note } = shapeSearchHits([], 'anything', 10)
    assert.deepEqual(formatted, [])
    assert.equal(note, null)
  })
})
