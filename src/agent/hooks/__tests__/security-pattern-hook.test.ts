import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSecurityPatternHook } from '../security-pattern-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeWriteTool(name: string, filePath: string, content: string): RuntimeToolEvent {
  if (name === 'write_file') {
    return { name, success: true, input: { file_path: filePath, content } } as unknown as RuntimeToolEvent
  }
  return {
    name, success: true,
    input: { file_path: filePath, old_string: 'x', new_string: content },
  } as unknown as RuntimeToolEvent
}

describe('createSecurityPatternHook', () => {
  it('命中危险模式时 submit 一条 advisory 并记录到 tracker', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/api.js', 'el.innerHTML = userInput\n'))

    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'security-pattern')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.ok(submitted[0]!.content.includes('【安全】'))
    assert.ok(submitted[0]!.content.includes('src/api.js'))

    const tracker = hook.getSecurityTracker()
    assert.ok(tracker.hitsByFile.get('src/api.js')!.has('innerHTML_xss'))
  })

  it('干净代码零注入、零 tracker 记录', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/math.ts', 'export const add = (a, b) => a + b\n'))

    assert.equal(submitted.length, 0)
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 0)
  })

  it('edit_file 走 new_string 通道也能命中', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('edit_file', 'a.py', 'yaml.load(open(f))\n'))
    assert.equal(submitted.length, 1)
    assert.ok(hook.getSecurityTracker().hitsByFile.get('a.py')!.has('unsafe_yaml_load'))
  })

  it('同一文件多规则命中合并进一条 advisory', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'x.js', 'eval(a)\nel.innerHTML = b\n'))

    assert.equal(submitted.length, 1)
    const ruleSet = hook.getSecurityTracker().hitsByFile.get('x.js')!
    assert.ok(ruleSet.has('eval_injection'))
    assert.ok(ruleSet.has('innerHTML_xss'))
  })

  it('tracker 跨轮累积（session-scoped,非 turn-scoped）', () => {
    const hook = createSecurityPatternHook({ advisoryBus: { submit: () => {} } })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'a.js', 'eval(x)\n'))
    hook.run(makeCtx(5), makeWriteTool('write_file', 'b.js', 'el.innerHTML = y\n'))

    const tracker = hook.getSecurityTracker()
    assert.equal(tracker.hitsByFile.size, 2)
    assert.ok(tracker.hitsByFile.get('a.js')!.has('eval_injection'))
    assert.ok(tracker.hitsByFile.get('b.js')!.has('innerHTML_xss'))
  })

  it('非写工具跳过（read_file 等）', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSecurityPatternHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), { name: 'read_file', success: true, input: { file_path: 'a.js' } } as unknown as RuntimeToolEvent)
    assert.equal(submitted.length, 0)
  })

  it('resetSecurityTracker 清空累积', () => {
    const hook = createSecurityPatternHook({ advisoryBus: { submit: () => {} } })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'a.js', 'eval(x)\n'))
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 1)
    hook.resetSecurityTracker()
    assert.equal(hook.getSecurityTracker().hitsByFile.size, 0)
  })
})
