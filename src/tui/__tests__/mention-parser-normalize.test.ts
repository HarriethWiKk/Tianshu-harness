import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMentions, normalizeMentionRefs, normalizeMentionPath } from '../mention-parser.js'

describe('normalizeMentionRefs（P3-C 提交规范化）', () => {
  it('cwd 内路径规范为相对路径', () => {
    const refs = parseMentions('fix @file:./src/../src/a.ts 与 @file:src/b.ts')
    const out = normalizeMentionRefs(refs, '/repo')
    assert.deepEqual(out.map(r => r.value), ['src/a.ts', 'src/b.ts'])
  })

  it('cwd 外路径保持原样（可识别外部引用）', () => {
    assert.equal(normalizeMentionPath('/repo', '/etc/passwd'), '/etc/passwd')
    assert.equal(normalizeMentionPath('/repo', '../outside.ts'), '../outside.ts')
  })

  it('绝对形式的 cwd 内路径转为相对', () => {
    assert.equal(normalizeMentionPath('/repo', '/repo/src/a.ts'), 'src/a.ts')
  })
})
