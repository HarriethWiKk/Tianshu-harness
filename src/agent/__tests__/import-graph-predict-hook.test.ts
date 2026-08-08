import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createImportGraphPredictHook, type ImportGraphPredictionBatch } from '../hooks/import-graph-predict-hook.js'
import { MeridianDb } from '../../repo/meridian-db.js'
import type { MeridianIndexer } from '../../repo/meridian-indexer.js'

function makeWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'import-graph-predict-'))
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'a.ts'), "import { b } from './b'\nimport { c } from './c'\n")
  writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 1\n')
  return cwd
}

function makeCtx(cwd: string, turn: number) {
  return createRuntimeHookContext({
    cwd,
    turn,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

/** 最小 MeridianIndexer 桩：只暴露 hook 需要的 getDb()。 */
function makeIndexerStub(db: MeridianDb): MeridianIndexer {
  return { getDb: () => db } as unknown as MeridianIndexer
}

function seedImports(db: MeridianDb): void {
  db.upsertFile({
    filePath: 'src/a.ts',
    contentHash: 'ha',
    symbols: [{ id: 'src/a.ts:A:1', name: 'A', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'ha' }],
    edges: [],
    imports: ['src/b.ts', 'src/c.ts'],
    calls: [],
  })
}

describe('import-graph predict hook (P2-2)', () => {
  it('read_file 成功 → 出边 top-5 经 onPredictions 上抛', () => {
    const cwd = makeWorkspace()
    const dir = mkdtempSync(join(tmpdir(), 'import-graph-db-'))
    try {
      const db = new MeridianDb(dir)
      seedImports(db)
      const batches: ImportGraphPredictionBatch[] = []
      const hook = createImportGraphPredictHook({
        getIndexer: () => makeIndexerStub(db),
        onPredictions: batch => { batches.push(batch) },
      })

      hook.run(makeCtx(cwd, 1), { name: 'read_file', success: true, target: 'read_file', input: { file_path: 'src/a.ts' } })

      assert.equal(batches.length, 1)
      assert.equal(batches[0]?.afterToolName, 'read_file')
      assert.deepEqual(
        batches[0]?.predictions.map(p => p.file).sort(),
        ['src/b.ts', 'src/c.ts'],
      )
      assert.ok(batches[0]!.predictions.every(p => p.score > 0), 'score 必须为正（weight 上抛）')
      db.close()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('绝对路径入参 → 归一化后查出边（与 P2-1 同形口径）', () => {
    const cwd = makeWorkspace()
    const dir = mkdtempSync(join(tmpdir(), 'import-graph-db2-'))
    try {
      const db = new MeridianDb(dir)
      seedImports(db)
      const batches: ImportGraphPredictionBatch[] = []
      const hook = createImportGraphPredictHook({
        getIndexer: () => makeIndexerStub(db),
        onPredictions: batch => { batches.push(batch) },
      })

      hook.run(makeCtx(cwd, 1), { name: 'read_file', success: true, target: 'read_file', input: { file_path: join(cwd, 'src', 'a.ts') } })

      assert.equal(batches.length, 1, '绝对路径必须归一化为仓库相对形后命中图键')
      db.close()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败/非 read_file/无 indexer/无出边 → 不触发 onPredictions', () => {
    const cwd = makeWorkspace()
    const dir = mkdtempSync(join(tmpdir(), 'import-graph-db3-'))
    try {
      const db = new MeridianDb(dir)
      seedImports(db)
      let calls = 0
      const hook = createImportGraphPredictHook({
        getIndexer: () => makeIndexerStub(db),
        onPredictions: () => { calls++ },
      })

      hook.run(makeCtx(cwd, 1), { name: 'read_file', success: false, target: 'read_file', input: { file_path: 'src/a.ts' } })
      hook.run(makeCtx(cwd, 2), { name: 'grep', success: true, target: 'grep', input: { path: 'src' } })
      hook.run(makeCtx(cwd, 3), { name: 'read_file', success: true, target: 'read_file', input: { file_path: 'src/no-edges.ts' } })
      assert.equal(calls, 0, '失败/非 read_file/无出边一律不触发')

      const noIndexer = createImportGraphPredictHook({
        getIndexer: () => null,
        onPredictions: () => { calls++ },
      })
      noIndexer.run(makeCtx(cwd, 4), { name: 'read_file', success: true, target: 'read_file', input: { file_path: 'src/a.ts' } })
      assert.equal(calls, 0, 'indexer 缺席（lean 会话）不触发')
      db.close()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
