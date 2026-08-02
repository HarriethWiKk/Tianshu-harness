import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createScriptIterationDetectorHook } from '../script-iteration-detector.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'
import type { PheromoneDeposit } from '../../../context/stigmergy.js'

function makeCtx(): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn: 1, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function editScript(file: string, success = true): RuntimeToolEvent {
  return {
    name: 'edit_file', success,
    input: { file_path: file }, target: file,
  } as unknown as RuntimeToolEvent
}

function bashRun(cmd: string, resultContent: string, success = true): RuntimeToolEvent {
  return {
    name: 'bash', success,
    input: { command: cmd }, target: cmd,
    resultContent,
  } as unknown as RuntimeToolEvent
}

function readFile(file: string): RuntimeToolEvent {
  return {
    name: 'read_file', success: true,
    input: { file_path: file }, target: file,
  } as unknown as RuntimeToolEvent
}

function grep(pattern: string): RuntimeToolEvent {
  return {
    name: 'grep', success: true,
    input: { pattern }, target: pattern,
  } as unknown as RuntimeToolEvent
}

function harness() {
  const submitted: AdvisoryEntry[] = []
  const deposits: PheromoneDeposit[] = []
  const hook = createScriptIterationDetectorHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    deposit: async (d: PheromoneDeposit) => { deposits.push(d) },
  })
  return { submitted, deposits, hook }
}

const TRUNC = '[output truncated: last 20 of 300 lines shown'

describe('script-iteration-detector', () => {
  it('单次 edit→bash 不触发（未达阈值 3）', async () => {
    const { submitted, hook } = harness()
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    assert.equal(submitted.length, 0)
  })

  it('三次 edit→bash 迭代 + 截断 → 在第三次 bash 时触发 advisory', async () => {
    const { submitted, deposits, hook } = harness()
    // 迭代计数在 bash 完成时结算：edit 只标记 editPending，bash 结算 iterations++
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))              // iterations=1
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py | head -70', TRUNC))   // iterations=2
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python3 sim.py', TRUNC))             // iterations=3 → fire
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'script-iteration-stall')
    assert.equal(submitted[0]!.category, 'dead_end')
    assert.match(submitted[0]!.content, /sim\.py/)
    assert.match(submitted[0]!.content, /3 次/)
    assert.equal(deposits.length, 1)
    assert.equal(deposits[0]!.path, 'sim.py')
    assert.equal(deposits[0]!.signal, 'dead-end')
  })

  it('无截断不触发（bash 输出完整 → 不计入迭代）', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(), editScript('sim.py'))
      await hook.run(makeCtx(), bashRun('python sim.py', '[python sim.py] exit=0 time=1.2s lines=10 — output complete'))
    }
    // 3 对 edit→bash 但无截断标记 → 每次 bash 只清 editPending 不计迭代（实现已对齐设计）
    assert.equal(submitted.length, 0)
  })

  it('迭代间有诊断工具（read_file）→ 计数器清空，重新积累 2 次不触发', async () => {
    const { submitted, hook } = harness()
    // 先积累 1 次迭代
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    // 诊断工具清空所有状态
    await hook.run(makeCtx(), readFile('sim.py'))
    // 重新积累 2 次迭代（< 3，不触发）
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    assert.equal(submitted.length, 0)
  })

  it('迭代间有诊断工具（grep）→ 计数器清空，重新积累 2 次不触发', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 2; i++) {
      await hook.run(makeCtx(), editScript('sim.py'))
      await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    }
    await hook.run(makeCtx(), grep('LDR reads'))
    // 重新积累 2 次（< 3）
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    assert.equal(submitted.length, 0)
  })

  it('不同脚本文件独立跟踪', async () => {
    const { submitted, hook } = harness()
    // sim.py 3 次迭代 → 触发
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(), editScript('sim.py'))
      await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    }
    assert.equal(submitted.length, 1)
    // sim.py 已 fired，不再触发
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    assert.equal(submitted.length, 1)
    // tool.sh 独立跟踪，3 次 → 触发第二个 advisory
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(), editScript('tool.sh'))
      await hook.run(makeCtx(), bashRun('bash tool.sh', TRUNC))
    }
    assert.equal(submitted.length, 2)
    assert.match(submitted[1]!.content, /tool\.sh/)
  })

  it('bash 命令不包含脚本路径 → 不计入迭代', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(), editScript('sim.py'))
      // bash 运行的脚本路径与跟踪文件不匹配
      await hook.run(makeCtx(), bashRun('python other.py', TRUNC))
    }
    assert.equal(submitted.length, 0)
  })

  it('dedup：同文件只触发一次（fired 后不再发射）', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(), editScript('sim.py'))
      await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    }
    assert.equal(submitted.length, 1)
    // 继续迭代，fired=true 阻挡
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    assert.equal(submitted.length, 1)
  })

  it('跨 turn 状态持久（hook 闭包内 Map 不因 turn 边界丢失）', async () => {
    const { submitted, hook } = harness()
    // turn 1: 1 次迭代
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    // turn 2: 继续 2 次迭代，触发
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    await hook.run(makeCtx(), editScript('sim.py'))
    await hook.run(makeCtx(), bashRun('python sim.py', TRUNC))
    assert.equal(submitted.length, 1)
  })
})
