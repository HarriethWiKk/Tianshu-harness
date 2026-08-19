import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  WRITE_DEFAULT_MAX_TURNS,
  SHAPE_MAX_TURNS_CEIL,
  SHAPE_TIMEOUT_CEIL_MS,
  shapeBudgetEnabled,
  shapeWriteBudget,
  shapeWriteBudgetForProfile,
  mergeBudgetOverride,
  historyBudgetEnabled,
  historyBudgetFloor,
  parseWorkerActualRows,
} from '../budget-shape.js'

describe('shapeWriteBudget（纯函数核心）', () => {
  it('files 缺席/单文件 = 纯默认（行为零变化）', () => {
    assert.deepEqual(shapeWriteBudget({ files: undefined, baseTimeoutMs: 600_000 }), { maxTurns: 48, timeoutMs: 600_000 })
    assert.deepEqual(shapeWriteBudget({ files: [], baseTimeoutMs: 600_000 }), { maxTurns: 48, timeoutMs: 600_000 })
    assert.deepEqual(shapeWriteBudget({ files: ['a.ts'], baseTimeoutMs: 600_000 }), { maxTurns: 48, timeoutMs: 600_000 })
  })

  it('每多一个文件 +6 轮 / +45s', () => {
    const b = shapeWriteBudget({ files: ['a.ts', 'b.ts', 'c.ts'], baseTimeoutMs: 600_000 })
    assert.equal(b.maxTurns, 48 + 6 * 2)
    assert.equal(b.timeoutMs, 600_000 + 45_000 * 2)
  })

  it('双帽：turns ≤ 100（runtimeFactory clamp 天花板），timeout ≤ 30min', () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`)
    const b = shapeWriteBudget({ files: many, baseTimeoutMs: 600_000 })
    assert.equal(b.maxTurns, SHAPE_MAX_TURNS_CEIL)
    assert.equal(b.maxTurns, 100)
    // 600s + 45s×19 = 1455s，未到 30min 帽——帽在更大基数时生效
    assert.equal(b.timeoutMs, 600_000 + 45_000 * 19)
    const huge = shapeWriteBudget({ files: many, baseTimeoutMs: 1_700_000 })
    assert.equal(huge.timeoutMs, SHAPE_TIMEOUT_CEIL_MS)
  })

  it('只涨不降：基数自定义（如模型显式基础）不会被 files 缩小', () => {
    const b = shapeWriteBudget({ files: ['a.ts'], baseMaxTurns: 80, baseTimeoutMs: 900_000 })
    assert.equal(b.maxTurns, 80)
    assert.equal(b.timeoutMs, 900_000)
  })
})

describe('shapeWriteBudgetForProfile（profile 解析）', () => {
  const prev = process.env.RIVET_WORKER_BUDGET_SHAPE
  afterEach(() => {
    if (prev === undefined) delete process.env.RIVET_WORKER_BUDGET_SHAPE
    else process.env.RIVET_WORKER_BUDGET_SHAPE = prev
  })

  it('写工 profile（patcher）按 files 定价', () => {
    const b = shapeWriteBudgetForProfile(['a.ts', 'b.ts'], 'patcher')
    assert.ok(b)
    assert.equal(b!.maxTurns, 54)
    assert.equal(b!.timeoutMs, 600_000 + 45_000)
  })

  it('读工 profile 返回 undefined（行为零变化）', () => {
    assert.equal(shapeWriteBudgetForProfile(['a.ts', 'b.ts'], 'code_scout'), undefined)
  })

  it('files ≤ 1 不发声——兜底基数不得顶掉无 defaultTimeoutMs profile 的渐进阶梯', () => {
    assert.equal(shapeWriteBudgetForProfile(undefined, 'patcher'), undefined)
    assert.equal(shapeWriteBudgetForProfile(['a.ts'], 'patcher'), undefined)
    assert.equal(shapeWriteBudgetForProfile(['a.ts'], 'verifier'), undefined)
  })

  it('闸门 RIVET_WORKER_BUDGET_SHAPE=0 全关', () => {
    process.env.RIVET_WORKER_BUDGET_SHAPE = '0'
    assert.equal(shapeBudgetEnabled(), false)
    assert.equal(shapeWriteBudgetForProfile(['a.ts', 'b.ts'], 'patcher'), undefined)
  })
})

describe('mergeBudgetOverride（显式 > shape）', () => {
  const shape = { maxTurns: 66, timeoutMs: 735_000 }

  it('显式缺席 → shape 全接管', () => {
    assert.deepEqual(mergeBudgetOverride(undefined, shape), shape)
  })

  it('显式逐字段全胜：只给 timeoutMs 时 maxTurns 落 shape', () => {
    assert.deepEqual(
      mergeBudgetOverride({ timeoutMs: 300_000 }, shape),
      { maxTurns: 66, timeoutMs: 300_000 },
    )
  })

  it('显式全给 → shape 完全不参与', () => {
    assert.deepEqual(
      mergeBudgetOverride({ maxTurns: 10, timeoutMs: 60_000 }, shape),
      { maxTurns: 10, timeoutMs: 60_000 },
    )
  })

  it('shape 缺席 → 原样透传显式', () => {
    assert.deepEqual(mergeBudgetOverride({ maxTurns: 24 }, undefined), { maxTurns: 24 })
    assert.equal(mergeBudgetOverride(undefined, undefined), undefined)
  })
})

describe('常量交叉验证', () => {
  it('WRITE_DEFAULT_MAX_TURNS 与 work-order 写工默认一致', async () => {
    const workOrder = await import('../work-order.js')
    const order = workOrder.createWriteWorkOrder({
      id: 'wo_shape_check', parentTurnId: 't', kind: 'patch_proposal', objective: 'o', scope: {},
    })
    assert.equal(order.budget.maxTurns, WRITE_DEFAULT_MAX_TURNS)
  })
})

// ── 历史实际用量回馈（预算发准第三刀）──────────────────────────────────────

describe('historyBudgetFloor（纯函数估计器）', () => {
  const current = { maxTurns: 48, timeoutMs: 600_000 }

  it('耗尽样本触发：toolUses 与 durationMs × 系数上地板', () => {
    const floor = historyBudgetFloor(
      [{ toolUses: 40, durationMs: 590_000, exhausted: true, budget: { maxTurns: 48, timeoutMs: 600_000 } }],
      current,
    )
    assert.ok(floor)
    assert.equal(floor!.maxTurns, Math.ceil(40 * 1.15 * 1.3))
    assert.equal(floor!.timeoutMs, Math.ceil(590_000 * 1.3))
  })

  it('near-miss（toolUses ≥ 0.8×当次预算轮数）同样触发', () => {
    const floor = historyBudgetFloor([{ toolUses: 39, durationMs: 100_000, budget: { maxTurns: 48, timeoutMs: 600_000 } }], current)
    assert.ok(floor, '39 ≥ 0.8×48 应触发')
  })

  it('轻松完成的样本不触发——没挨过墙的任务不涨预算', () => {
    assert.equal(historyBudgetFloor([{ toolUses: 10, durationMs: 90_000 }], current), undefined)
  })

  it('只做地板：估值低于 current 时不干预', () => {
    assert.equal(historyBudgetFloor([{ toolUses: 5, durationMs: 60_000, exhausted: true }], current), undefined)
  })

  it('双重帽：3× current 与绝对帽取小', () => {
    const floor = historyBudgetFloor(
      [{ toolUses: 500, durationMs: 5_000_000, exhausted: true }],
      current,
    )
    assert.ok(floor)
    assert.equal(floor!.maxTurns, 100)                 // 绝对帽
    assert.equal(floor!.timeoutMs, 1_800_000)          // 绝对帽 < 3×600s=1800s 相等取小
    const small = historyBudgetFloor([{ toolUses: 90, durationMs: 900_000, exhausted: true }], current)
    assert.equal(small!.maxTurns, Math.min(100, Math.ceil(90 * 1.15 * 1.3), 48 * 3))
  })

  it('空/全零样本返回 undefined', () => {
    assert.equal(historyBudgetFloor([], current), undefined)
    assert.equal(historyBudgetFloor([{ toolUses: 0, durationMs: 0 }], current), undefined)
  })
})

describe('parseWorkerActualRows（坏行免疫）', () => {
  it('按 objectiveHash 前缀过滤并解析；坏 JSON / 缺字段行跳过', () => {
    const rows = [
      { kind: 'worker_actual:abc123:1', json: JSON.stringify({ toolUses: 10, durationMs: 100, exhausted: true, budget: { maxTurns: 48, timeoutMs: 600_000 } }) },
      { kind: 'worker_actual:other99:2', json: JSON.stringify({ toolUses: 99, durationMs: 999 }) },
      { kind: 'worker_actual:abc123:3', json: '{broken' },
      { kind: 'worker_actual:abc123:4', json: JSON.stringify({ nothing: true }) },
    ]
    const samples = parseWorkerActualRows(rows, 'abc123')
    assert.equal(samples.length, 1)
    assert.equal(samples[0]!.toolUses, 10)
    assert.equal(samples[0]!.exhausted, true)
  })
})

describe('historyBudgetEnabled（闸门）', () => {
  it('RIVET_WORKER_BUDGET_HISTORY=0 关闭', () => {
    const prev = process.env.RIVET_WORKER_BUDGET_HISTORY
    try {
      process.env.RIVET_WORKER_BUDGET_HISTORY = '0'
      assert.equal(historyBudgetEnabled(), false)
      delete process.env.RIVET_WORKER_BUDGET_HISTORY
      assert.equal(historyBudgetEnabled(), true)
    } finally {
      if (prev === undefined) delete process.env.RIVET_WORKER_BUDGET_HISTORY
      else process.env.RIVET_WORKER_BUDGET_HISTORY = prev
    }
  })
})

// ── coordinator 接线（budgetWithHistory 焦点单测）──────────────────────────

describe('budgetWithHistory（coordinator 接线）', () => {
  it('同 objective 的耗尽样本抬升写工预算地板；读工与闸门关闭不受影响', async () => {
    const { DelegationCoordinator } = await import('../coordinator.js')
    const { createWriteWorkOrder } = await import('../work-order.js')
    const objective = '构建 emitter 并过 spirv-val——历史耗尽场景'
    const hash = hashObjectiveOf(objective)
    const rows = [
      { kind: `worker_actual:${hash}:1`, json: JSON.stringify({ toolUses: 44, durationMs: 595_000, exhausted: true, budget: { maxTurns: 48, timeoutMs: 600_000 }, status: 'blocked' }) },
    ]
    const make = (withLoad: boolean) => new DelegationCoordinator({
      baseToolRegistry: { register: () => {}, getDefinitions: () => [] } as never,
      modelCards: [],
      maxWorkers: 1,
      runtimeFactory: (order: unknown) => ({ order }) as never,
      ...(withLoad
        ? { modelTierShadowStore: { saveBanditState: () => {}, loadBanditStatesByPrefix: (prefix: string) => prefix.startsWith(`worker_actual:${hash}`) ? rows : [] } }
        : {}),
    })
    const request = {
      parentTurnId: 'tu1',
      objective,
      kind: 'patch_proposal' as const,
      profile: 'patcher' as never,
      scope: { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
    }

    // 有历史：44 工具调用耗尽 48 轮 → floor = ceil(44×1.15×1.3) = 66 轮
    const lifted = (make(true) as unknown as { budgetWithHistory: (r: unknown) => { maxTurns?: number; timeoutMs?: number } }).budgetWithHistory(request)
    assert.ok(lifted?.maxTurns && lifted.maxTurns > 48)
    assert.equal(lifted!.maxTurns, Math.ceil(44 * 1.15 * 1.3))

    // 无 store：静默降级为 undefined（原 budget 透传）
    const bare = (make(false) as unknown as { budgetWithHistory: (r: unknown) => unknown }).budgetWithHistory(request)
    assert.equal(bare, undefined)

    // 闸门关闭：RIVET_WORKER_BUDGET_HISTORY=0 时原样透传
    process.env.RIVET_WORKER_BUDGET_HISTORY = '0'
    try {
      const gated = (make(true) as unknown as { budgetWithHistory: (r: unknown) => unknown }).budgetWithHistory(request)
      assert.equal(gated, undefined)
    } finally {
      delete process.env.RIVET_WORKER_BUDGET_HISTORY
    }

    // 旁证：current 的 cap 语义——显式 budget 不被 floor 覆盖
    const explicit = (make(true) as unknown as { budgetWithHistory: (r: unknown) => unknown }).budgetWithHistory({ ...request, budget: { maxTurns: 10 } })
    assert.deepEqual(explicit, { maxTurns: 10, timeoutMs: lifted!.timeoutMs }, '显式 maxTurns 全胜，缺席 timeoutMs 落 floor')
    // 引用 work-order 避免 unused（同时锁定写工默认与 current 兜底一致）
    assert.equal(createWriteWorkOrder({ parentTurnId: 't', kind: 'patch_proposal', objective: 'x', scope: {} }).budget.maxTurns, 48)
  })
})

function hashObjectiveOf(objective: string): string {
  // 与 worker-episode.hashObjective 同式（sha256 前 12 hex）
  return createHash('sha256').update(objective).digest('hex').slice(0, 12)
}
