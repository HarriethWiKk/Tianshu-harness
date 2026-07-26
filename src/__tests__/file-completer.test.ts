import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractAtToken, getCompletions, applyCompletion } from '../tui/file-completer.js'

describe('extractAtToken', () => {
  it('extracts @-prefixed token at cursor', () => {
    assert.equal(extractAtToken('fix @src/ma', 11), 'src/ma')
    assert.equal(extractAtToken('hello @', 7), '')
    assert.equal(extractAtToken('no at here', 5), null)
  })

  it('returns null when no @ before cursor', () => {
    assert.equal(extractAtToken('plain text', 5), null)
  })
})

describe('getCompletions', () => {
  it('returns matching files from cwd', () => {
    // TUI 2.x 后 app.ts 位于 src/tui/engine/
    const results = getCompletions('src/tui/engine/app', process.cwd(), 5)
    assert.ok(results.length > 0)
    assert.ok(results[0]!.includes('src/tui/engine/app'))
  })

  it('limits results', () => {
    const results = getCompletions('src/', process.cwd(), 3)
    assert.ok(results.length <= 3)
  })

  it('returns empty array for nonexistent path', () => {
    const results = getCompletions('nonexistent-xyz-123/', process.cwd(), 5)
    assert.equal(results.length, 0)
  })
})

describe('applyCompletion', () => {
  it('replaces @token with canonical @file: mention and adds trailing space', () => {
    // 096cf2dd：补全插入规范形 @file:——mention-parser 只认该协议，
    // 裸 @path 提交后不会被解析成引用（静默断链）。
    const result = applyCompletion('fix @src/ma', 11, 'src/main.tsx')
    assert.equal(result.text, 'fix @file:src/main.tsx ')
    assert.equal(result.cursor, 'fix @file:src/main.tsx '.length)
  })

  it('quotes paths with spaces', () => {
    const result = applyCompletion('see @my', 7, 'my dir/a.ts')
    assert.equal(result.text, 'see @file:"my dir/a.ts" ')
  })
})
