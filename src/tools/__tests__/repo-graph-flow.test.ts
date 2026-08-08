import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRepoGraphTool } from '../repo-graph.js'
import { MeridianIndexer } from '../../repo/meridian-indexer.js'

// 关闭后台全量索引——工具 execute 会触发 scheduleMeridianBackfill，测试里不需要。
process.env.RIVET_MERIDIAN_BACKFILL = '0'

describe('repo_graph flow 模式（wave4 T9 工具面透出）', () => {
  let cwd: string
  let stateDir: string
  let indexer: MeridianIndexer

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'repo-graph-flow-cwd-'))
    stateDir = mkdtempSync(join(tmpdir(), 'repo-graph-flow-state-'))
    indexer = new MeridianIndexer(cwd, stateDir)
    const db = indexer.getDb()
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [
        { id: 'src/a.ts:foo:1', name: 'foo', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
        { id: 'src/a.ts:bar:5', name: 'bar', kind: 'function', filePath: 'src/a.ts', line: 5, exported: true, contentHash: 'h1' },
      ],
      edges: [{ sourceId: 'src/a.ts:foo:1', targetId: 'src/b.ts:baz:1', kind: 'calls', weight: 1.0 }],
      imports: [], calls: [],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [
        { id: 'src/b.ts:baz:1', name: 'baz', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' },
      ],
      edges: [{ sourceId: 'src/b.ts:baz:1', targetId: 'src/c.ts:qux:1', kind: 'calls', weight: 1.0 }],
      imports: [], calls: [],
    })
    db.upsertFile({
      filePath: 'src/c.ts', contentHash: 'h3',
      symbols: [
        { id: 'src/c.ts:qux:1', name: 'qux', kind: 'function', filePath: 'src/c.ts', line: 1, exported: true, contentHash: 'h3' },
      ],
      edges: [], imports: [], calls: [],
    })
    db.upsertFile({
      filePath: 'src/iso.ts', contentHash: 'h4',
      symbols: [
        { id: 'src/iso.ts:lone:1', name: 'lone', kind: 'function', filePath: 'src/iso.ts', line: 1, exported: true, contentHash: 'h4' },
      ],
      edges: [], imports: [], calls: [],
    })
  })

  afterEach(() => {
    indexer.close()
    rmSync(cwd, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  function tool() {
    return createRepoGraphTool(() => indexer)
  }

  it('schema 声明 flow 模式与 symbol 参数', () => {
    const def = tool().definition
    const props = (def.input_schema?.properties ?? {}) as Record<string, { enum?: string[] }>
    assert.ok(props.mode?.enum?.includes('flow'), 'mode enum 应含 flow')
    assert.ok(props.symbol, '应有 symbol 参数')
  })

  it('flow 模式沿 calls 边返回命名符号命中（含跳数）', async () => {
    const result = await tool().execute({
      input: { from_file: 'src/a.ts', mode: 'flow', symbol: 'foo' },
      cwd,
    } as never)
    assert.ok(!result.isError, `不应报错：${result.content}`)
    assert.ok(result.content.includes('baz'), '应命中 1 跳的 baz')
    assert.ok(result.content.includes('qux'), '应命中 2 跳的 qux')
    assert.ok(result.content.includes('src/b.ts'), '命中应带文件路径')
  })

  it('flow 缺 symbol 参数 → 报错并列出该文件可用符号', async () => {
    const result = await tool().execute({
      input: { from_file: 'src/a.ts', mode: 'flow' },
      cwd,
    } as never)
    assert.ok(result.isError, '缺 symbol 应报错')
    assert.ok(result.content.includes('foo'), '错误信息应列出可用符号 foo')
    assert.ok(result.content.includes('bar'), '错误信息应列出可用符号 bar')
  })

  it('flow symbol 不存在 → 报错并列出可用符号', async () => {
    const result = await tool().execute({
      input: { from_file: 'src/a.ts', mode: 'flow', symbol: 'nope' },
      cwd,
    } as never)
    assert.ok(result.isError, '未知 symbol 应报错')
    assert.ok(result.content.includes('foo'), '错误信息应列出可用符号')
  })

  it('孤立符号无流关联 → 友好提示而非报错', async () => {
    const result = await tool().execute({
      input: { from_file: 'src/iso.ts', mode: 'flow', symbol: 'lone' },
      cwd,
    } as never)
    assert.ok(!result.isError, '无关联不是错误')
    assert.ok(result.content.includes('lone'), '提示应回显符号名')
  })

  it('graph 默认模式不受影响', async () => {
    const result = await tool().execute({
      input: { from_file: 'src/a.ts' },
      cwd,
    } as never)
    assert.ok(!result.isError)
    assert.ok(result.content.includes('代码图'), '默认仍走 graph 模式')
  })
})
