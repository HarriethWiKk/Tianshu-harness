import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compactDescription, applyDescriptionMode, COMPACT_MIN_CHARS } from '../description-compact.js'
import { PLAN_TOOL } from '../plan.js'
import { TODO_TOOL } from '../todo.js'
import { HASH_EDIT_TOOL } from '../hash-edit.js'

function longDescription(body: string): string {
  // 撑过阈值，让压缩真正生效
  const filler = Array.from({ length: 40 }, (_, i) => `举例 ${i}：这是一段可以丢弃的展开说明文字。`).join('\n')
  return `${body}\n\n${filler}`
}

describe('compactDescription', () => {
  it('leaves short descriptions untouched', () => {
    const short = '读取文件内容。'
    assert.equal(compactDescription(short), short)
    assert.ok(short.length < COMPACT_MIN_CHARS)
  })

  it('keeps the leading summary paragraph', () => {
    const desc = longDescription('这个工具做 X。\n第二行仍属首段。')
    const out = compactDescription(desc)
    assert.ok(out.includes('这个工具做 X。'))
    assert.ok(out.includes('第二行仍属首段。'))
    assert.ok(out.length < desc.length)
  })

  it('keeps every hard-gate line', () => {
    // 这是本函数最重要的性质：描述里混着防误用门禁，砍掉就是让模型踩坑。
    const desc = longDescription([
      '工具总述。',
      '',
      '## 用法',
      '绝不要把指针当作内容传入。',
      '普通的展开说明，可以丢。',
      '路径必须是绝对路径。',
      '不要在这里传 null。',
    ].join('\n'))
    const out = compactDescription(desc)
    assert.ok(out.includes('绝不要把指针当作内容传入。'))
    assert.ok(out.includes('路径必须是绝对路径。'))
    assert.ok(out.includes('不要在这里传 null。'))
    assert.ok(!out.includes('普通的展开说明'))
  })

  it('drops fenced code blocks whole, leaving no orphan fence', () => {
    const desc = longDescription([
      '工具总述。',
      '',
      '## 例子',
      '必须保留这行。',
      '```json',
      '{ "a": 1 }',
      '```',
    ].join('\n'))
    const out = compactDescription(desc)
    assert.ok(!out.includes('{ "a": 1 }'))
    assert.equal((out.match(/```/g) ?? []).length, 0, 'orphan fence would swallow the rest of the text')
  })

  it('keeps each heading together with its first body line', () => {
    // 标题定义工具的动作词汇表；只留标题是空壳，连标题一起删等于该 action
    // 从契约里消失（曾让 plan 的 exit_mode 整个不见）。
    const desc = longDescription([
      '工具总述。',
      '',
      '### Action: alpha',
      'alpha 的定义句。',
      '可丢的展开说明。',
      '### Action: beta',
      'beta 的定义句。',
    ].join('\n'))
    const out = compactDescription(desc)
    for (const token of ['### Action: alpha', 'alpha 的定义句。', '### Action: beta', 'beta 的定义句。']) {
      assert.ok(out.includes(token), `must keep "${token}"`)
    }
    assert.ok(!out.includes('可丢的展开说明。'))
  })

  it('drops a heading that has no body at all', () => {
    const desc = longDescription([
      '工具总述。',
      '',
      '## 空壳',
      '## 有内容',
      '定义句。',
    ].join('\n'))
    const out = compactDescription(desc)
    assert.ok(!out.includes('## 空壳'))
    assert.ok(out.includes('## 有内容'))
  })

  it('collapses blank runs left behind by dropped lines', () => {
    const desc = longDescription('工具总述。\n\n## A\n必须保留。')
    assert.doesNotMatch(compactDescription(desc), /\n\n\n/)
  })

  it('returns the original when compaction would not save bytes', () => {
    // 全是门禁行 → 一行都丢不掉 → 不能因为「压缩过了」反而变长
    const allGates = Array.from({ length: 120 }, (_, i) => `第 ${i} 条：必须遵守此项约束。`).join('\n')
    const desc = `总述。\n\n${allGates}`
    assert.ok(desc.length > COMPACT_MIN_CHARS)
    assert.equal(compactDescription(desc), desc)
  })

  it('is idempotent', () => {
    const desc = longDescription('工具总述。\n\n## A\n必须保留。\n可丢的说明。')
    const once = compactDescription(desc)
    assert.equal(compactDescription(once), once)
  })
})

describe('applyDescriptionMode', () => {
  const defs = [
    { name: 'a', description: longDescription('A 总述。\n\n## X\n必须保留。\n可丢说明。') },
    { name: 'b', description: '短描述' },
  ]

  it('is a no-op under full', () => {
    const out = applyDescriptionMode(defs, 'full')
    assert.deepEqual(out, defs)
  })

  it('is a no-op when the mode is unset', () => {
    assert.deepEqual(applyDescriptionMode(defs, undefined), defs)
  })

  it('compacts only the oversized entries', () => {
    const out = applyDescriptionMode(defs, 'compact')
    assert.ok(out[0]!.description.length < defs[0]!.description.length)
    assert.equal(out[1]!.description, '短描述')
  })

  it('does not mutate the input', () => {
    const before = defs[0]!.description
    applyDescriptionMode(defs, 'compact')
    assert.equal(defs[0]!.description, before)
  })

  it('tolerates entries without a description', () => {
    const out = applyDescriptionMode([{ name: 'x' }], 'compact')
    assert.deepEqual(out, [{ name: 'x' }])
  })
})

describe('compact keeps real tools usable', () => {
  // 人工抽查对象：三个最大的工具描述。压缩后仍要能独立指导正确调用。
  const cases = [
    { tool: PLAN_TOOL, mustKeep: ['submit', 'close', 'enter_mode', 'exit_mode', '[plan persisted to'] },
    { tool: TODO_TOOL, mustKeep: [] },
    { tool: HASH_EDIT_TOOL, mustKeep: [] },
  ]

  for (const { tool, mustKeep } of cases) {
    it(`${tool.definition.name}: shrinks while keeping its action vocabulary`, () => {
      const original = tool.definition.description
      const out = compactDescription(original)
      assert.ok(out.length <= original.length)
      for (const token of mustKeep) {
        assert.ok(out.includes(token), `compact ${tool.definition.name} must keep "${token}"`)
      }
    })
  }
})
