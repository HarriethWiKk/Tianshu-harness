import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createPhysarumFileAccessHook, canonicalizePhysarumFileTarget, relativizePhysarumFileTarget } from '../hooks/physarum-file-access-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

function makeWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'physarum-file-access-'))
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 1\n')
  writeFileSync(join(cwd, 'src', 'notes.md'), '# notes\n')
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

describe('physarum file access hook', () => {
  it('canonicalizes only existing in-project indexable files', () => {
    const cwd = makeWorkspace()
    try {
      assert.equal(canonicalizePhysarumFileTarget(cwd, 'src/a.ts'), 'src/a.ts')
      assert.equal(canonicalizePhysarumFileTarget(cwd, join(cwd, 'src', 'b.ts')), 'src/b.ts')
      assert.equal(canonicalizePhysarumFileTarget(cwd, 'src'), null)
      assert.equal(canonicalizePhysarumFileTarget(cwd, 'src/notes.md'), null)
      assert.equal(canonicalizePhysarumFileTarget(cwd, '../outside.ts'), null)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('relativizes non-existing indexable targets without stat (P2-1 enqueue-side)', () => {
    const cwd = makeWorkspace()
    try {
      // 入队侧不要求文件存在——预测可能指向尚未读取/尚未创建的文件
      assert.equal(relativizePhysarumFileTarget(cwd, 'src/ghost.ts'), 'src/ghost.ts')
      assert.equal(relativizePhysarumFileTarget(cwd, join(cwd, 'src', 'ghost.ts')), 'src/ghost.ts')
      // 同一过滤面：目录（无扩展名）、非索引、逃逸一律拒绝
      assert.equal(relativizePhysarumFileTarget(cwd, 'src'), null)
      assert.equal(relativizePhysarumFileTarget(cwd, 'src/notes.md'), null)
      assert.equal(relativizePhysarumFileTarget(cwd, '../outside.ts'), null)
      assert.equal(relativizePhysarumFileTarget(cwd, undefined), null)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('learns successful file-to-file sequences without tool-name nodes', () => {
    const cwd = makeWorkspace()
    try {
      const engine = new PhysarumEngine(undefined)
      const hook = createPhysarumFileAccessHook({ getPhysarum: () => engine })

      hook.run(makeCtx(cwd, 1), {
        name: 'read_file',
        success: true,
        target: 'read_file',
        input: { file_path: 'src/b.ts' },
      })
      hook.run(makeCtx(cwd, 1), {
        name: 'edit_file',
        success: true,
        target: 'edit_file',
        input: { file_path: join(cwd, 'src', 'a.ts') },
      })

      const edge = engine.getEdge('src/a.ts', 'src/b.ts')
      assert.ok(edge)
      assert.ok(edge.direction < 0, 'b.ts→a.ts should be encoded as a negative lexicographic edge direction')
      assert.equal(engine.getEdge('read_file', 'src/b.ts'), undefined)
      assert.equal(engine.predictNext('src/b.ts')[0]?.file, 'src/a.ts')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('ignores grep paths, failed tools, directories, non-indexable targets, and display fallbacks', () => {
    const cwd = makeWorkspace()
    try {
      const engine = new PhysarumEngine(undefined)
      const hook = createPhysarumFileAccessHook({ getPhysarum: () => engine })

      hook.run(makeCtx(cwd, 1), { name: 'read_file', success: true, target: 'read_file' })
      hook.run(makeCtx(cwd, 2), { name: 'read_file', success: true, target: 'read_file', input: { file_path: 'src/a.ts' } })
      hook.run(makeCtx(cwd, 3), { name: 'grep', success: true, target: 'src', input: { path: 'src' } })
      hook.run(makeCtx(cwd, 4), { name: 'edit_file', success: false, target: 'edit_file', input: { file_path: 'src/b.ts' } })
      hook.run(makeCtx(cwd, 5), { name: 'read_file', success: true, target: 'read_file', input: { file_path: 'src/notes.md' } })
      hook.run(makeCtx(cwd, 6), { name: 'hash_edit', success: true, target: 'hash_edit', input: { file_path: 'src' } })

      assert.equal(engine.edgeCount(), 0)

      hook.run(makeCtx(cwd, 7), { name: 'hash_edit', success: true, target: 'hash_edit', input: { file_path: 'src/b.ts' } })
      assert.ok(engine.getEdge('src/a.ts', 'src/b.ts'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
