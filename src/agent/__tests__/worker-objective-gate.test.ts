import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileWithObjective, type ObjectiveContext } from '../worker-objective-gate.js'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'

function order(over: Partial<ObjectiveContext> = {}): ObjectiveContext {
  return { objective: '审查缓存边界的字节稳定性', kind: 'review', scope: {}, ...over }
}

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'batch:0',
    status: 'passed',
    summary: '看过 request-freezer，边界处字节稳定',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...over,
  }
}

function transcript(over: Partial<WorkerTranscript> = {}): WorkerTranscript {
  return { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0, ...over }
}

describe('目标对账 — 盖章', () => {
  test('把派发侧的 objective 盖到结果上', () => {
    const out = reconcileWithObjective(order({ objective: '定位 /tasks 的渲染函数' }), result())
    assert.equal(out.objective, '定位 /tasks 的渲染函数')
  })

  test('worker 自报的 objective 被派发侧覆盖', () => {
    // 对账的两边必须有一边来自派发侧，否则 worker 可以把目标和交付写成自洽的一对。
    const forged = { ...result(), objective: '我干的这件事就是我的目标' } as WorkerResult
    const out = reconcileWithObjective(order({ objective: '真实派发目标' }), forged)
    assert.equal(out.objective, '真实派发目标')
  })

  test('不改动入参', () => {
    const input = result()
    const before = JSON.stringify(input)
    reconcileWithObjective(order(), input)
    assert.equal(JSON.stringify(input), before)
  })

  test('已如实报告失败的结果不再被二次质疑', () => {
    const out = reconcileWithObjective(order(), result({ status: 'blocked', summary: '', findings: [] }))
    assert.equal(out.status, 'blocked')
    assert.deepEqual(out.risks, [], '不给一个已经诚实认输的结果再加噪音')
    assert.equal(out.objective, '审查缓存边界的字节稳定性', '但仍要盖章')
  })
})

describe('目标对账 — 硬判据：空壳', () => {
  test('报 passed 却什么都没交 → 改判 blocked', () => {
    const out = reconcileWithObjective(order(), result({
      summary: '(no summary provided by worker)',
    }))
    assert.equal(out.status, 'blocked')
    assert.match(out.risks.join('\n'), /空壳/)
  })

  test('summary 空白同样算空壳', () => {
    const out = reconcileWithObjective(order(), result({ summary: '   ' }))
    assert.equal(out.status, 'blocked')
  })

  test('summary 短但有内容 → 放行（不设长度阈值）', () => {
    // 一句 20 字的中文结论是合格交付；按长度卡会把它误杀。
    const out = reconcileWithObjective(order(), result({ summary: '该函数无任何调用点，可安全删除' }))
    assert.equal(out.status, 'passed')
    assert.deepEqual(out.risks, [])
  })

  test('summary 是占位串但有 findings → 放行', () => {
    const out = reconcileWithObjective(order(), result({
      summary: '(no summary provided by worker)',
      findings: [{ claim: 'request-freezer 在边界处重排了 key', evidence: 'src/api/request-freezer.ts:88', confidence: 'high' }],
    }))
    assert.equal(out.status, 'passed')
  })
})

describe('目标对账 — 硬判据：verify 工没验证', () => {
  const verifyOrder = order({ kind: 'verify', objective: '确认 rewind 的回归测试全绿' })

  test('无 verification 元数据且 transcript 无验证痕迹 → 改判 blocked', () => {
    const out = reconcileWithObjective(verifyOrder, result({ summary: '看起来没问题' }), transcript({ toolUses: ['read_file', 'grep'] }))
    assert.equal(out.status, 'blocked')
    assert.match(out.risks.join('\n'), /未执行受派的验证/)
  })

  test('跑过 run_tests → 放行', () => {
    const out = reconcileWithObjective(verifyOrder, result({ summary: '全部通过' }), transcript({ toolUses: ['run_tests'] }))
    assert.equal(out.status, 'passed')
  })

  test('跑过验证形状的 bash → 放行', () => {
    const out = reconcileWithObjective(verifyOrder, result({ summary: '全部通过' }), transcript({ toolUses: ['bash'], bashCommands: ['npm test'] }))
    assert.equal(out.status, 'passed')
  })

  test('有 verification 元数据 → 放行，不看 transcript', () => {
    const out = reconcileWithObjective(verifyOrder, result({
      verification: { status: 'passed' } as WorkerResult['verification'],
    }), transcript())
    assert.equal(out.status, 'passed')
  })

  test('无 transcript → 只加 risk，不硬拦（fail-open）', () => {
    const out = reconcileWithObjective(verifyOrder, result())
    assert.equal(out.status, 'passed', '没有证据说明它做错了，就不能当它做错了')
    assert.match(out.risks.join('\n'), /未硬拦/)
  })

  test('非 verify 的 kind 不受此判据约束', () => {
    const out = reconcileWithObjective(order({ kind: 'code_search' }), result(), transcript({ toolUses: ['grep'] }))
    assert.equal(out.status, 'passed')
    assert.deepEqual(out.risks, [])
  })
})

describe('目标对账 — 软判据', () => {
  test('patch_proposal 没交出补丁 → 只加 risk，不改 status', () => {
    // 「查完认为无需改动」是合法结论，机械上与「什么都没做」无从区分。
    const out = reconcileWithObjective(
      order({ kind: 'patch_proposal' }),
      result({ summary: '查完认为现有实现已正确，无需改动' }),
    )
    assert.equal(out.status, 'passed')
    assert.match(out.risks.join('\n'), /patch_proposal/)
  })

  test('patch_proposal 交了 patchSummary → 无 risk', () => {
    const out = reconcileWithObjective(
      order({ kind: 'patch_proposal' }),
      result({ patchSummary: '把 contract 改为覆盖写入' }),
    )
    assert.deepEqual(out.risks, [])
  })

  test('派了范围却去了别处 → 加 risk', () => {
    const out = reconcileWithObjective(
      order({ scope: { files: ['src/cache/request-freezer.ts'] } }),
      result({ examinedFiles: ['src/tui/engine/app.ts'] }),
    )
    assert.equal(out.status, 'passed')
    assert.match(out.risks.join('\n'), /无交集/)
  })

  test('范围命中（路径写法不同也算命中）→ 无 risk', () => {
    const out = reconcileWithObjective(
      order({ scope: { files: ['src/cache/request-freezer.ts'] } }),
      result({ examinedFiles: ['/abs/repo/src/cache/request-freezer.ts'] }),
    )
    assert.deepEqual(out.risks, [], '绝对路径与相对路径指的是同一个文件')
  })

  test('examinedFiles 为空时不判跑偏', () => {
    // 没报告看过哪些文件，只说明它没报告，不说明它没看。
    const out = reconcileWithObjective(
      order({ scope: { files: ['src/cache/request-freezer.ts'] } }),
      result({ examinedFiles: [] }),
    )
    assert.deepEqual(out.risks, [])
  })

  test('changedFiles 命中范围也算去过', () => {
    const out = reconcileWithObjective(
      order({ kind: 'patch_proposal', scope: { files: ['src/cache/request-freezer.ts'] } }),
      result({ changedFiles: ['src/cache/request-freezer.ts'], patchSummary: '改了序列化顺序' }),
    )
    assert.deepEqual(out.risks, [])
  })

  describe('目标对账 — samePath 路径边界', () => {
    test('Windows 反斜杠：scope 用正斜杠，examinedFiles 用反斜杠 → 命中', () => {
      // samePath 用 replace(/\\/g, '/') 归一化反斜杠
      const out = reconcileWithObjective(
        order({ scope: { files: ['src/cache/request-freezer.ts'] } }),
        result({ examinedFiles: ['src\\cache\\request-freezer.ts'] }),
      )
      assert.deepEqual(out.risks, [], '反斜杠归一化后应视为同一文件')
    })

    test('./ 前缀：scope 带 ./，examinedFiles 不带 → 命中', () => {
      // samePath 用 replace(/^\.\//, '') 剥掉 ./ 前缀
      const out = reconcileWithObjective(
        order({ scope: { files: ['./src/cache/request-freezer.ts'] } }),
        result({ examinedFiles: ['src/cache/request-freezer.ts'] }),
      )
      assert.deepEqual(out.risks, [], '剥掉 ./ 后应视为同一文件')
    })

    test('空字符串：scope 含空串时 endsWith 逻辑不会误匹配', () => {
      // norm('') = ''，两端都不会 endsWith('/' + '')，不会产生假阳性
      const out = reconcileWithObjective(
        order({ scope: { files: [''] } }),
        result({ examinedFiles: ['src/cache/request-freezer.ts'] }),
      )
      assert.match(out.risks.join('\n'), /无交集/, '空串不与任何路径匹配')
    })

    test('仅文件名匹配：scope 只有文件名，examinedFiles 含完整路径 → 命中', () => {
      // samePath 的 endsWith 逻辑：完整路径应以 '/' + 文件名 结尾
      const out = reconcileWithObjective(
        order({ scope: { files: ['request-freezer.ts'] } }),
        result({ examinedFiles: ['src/cache/request-freezer.ts'] }),
      )
      assert.deepEqual(out.risks, [], 'endsWith 能将裸文件名与完整路径后缀匹配')
    })

    test('多余双斜杠：scope 含 //，当前 samePath 不做归一化 → 不命中（已知限制）', () => {
      // samePath 只做 \\→/ 和 ./→'' 两步归一化，不处理 // → /
      // 这是当前实现的已知限制，测试用于记录行为快照
      const out = reconcileWithObjective(
        order({ scope: { files: ['src//cache/request-freezer.ts'] } }),
        result({ examinedFiles: ['src/cache/request-freezer.ts'] }),
      )
      assert.match(out.risks.join('\n'), /无交集/, '双斜杠路径应不被匹配——如要支持需另加 // → / 归一化')
    })
  })
})
