import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { extractGoalFromMessages, type GoalSourceMessage } from '../../pro/spark/goal.js'

/**
 * Goal anchor 端到端测试（计划 Wave 3 任务 11——真实管道，无 mock 中间层）。
 *
 * 数据流：SessionContext.addUserMessage（真实实现）→ 注入的 goalExtractor
 * （真实 extractGoalFromMessages）→ 变更回调 → promptEngine.setGoalAnchor
 * （真实 PromptEngine）→ buildOaiRequest 的 dynamic appendix 含 <current-goal>。
 *
 * 覆盖：实质指令更新目标、延续指令不更新、未注册 extractor 零行为（回归清单项）。
 */

const CONTEXT_WINDOW = 200_000

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    appendixDelta: true,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/test/project',
      rivetMd: '# Test Project',
    },
  })
}

describe('goal anchor e2e (真实管道)', () => {
  it('实质指令 → 目标更新 → appendix 可见 <current-goal>', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const metaWrites: Array<string | null> = []

    // 注入目标跟踪（模拟 bootstrap/serve-agent 装配）
    session.setGoalTracking(
      (msgs) => extractGoalFromMessages(msgs as unknown as GoalSourceMessage[]),
      (next) => {
        engine.setGoalAnchor(next)
        metaWrites.push(next)
      },
    )

    session.addUserMessage('看一下左侧的侧边栏的默认尺寸是多少px')
    assert.equal(session.getGoalAnchor(), '看一下左侧的侧边栏的默认尺寸是多少px')
    assert.deepEqual(metaWrites, ['看一下左侧的侧边栏的默认尺寸是多少px'], '首次实质指令触发一次回调')

    // 真实 PromptEngine 渲染链路：请求 appendix 含 current-goal
    const req = engine.buildOaiRequest(session.getMessages(), undefined, CONTEXT_WINDOW)
    const appendix = req.messages.at(-1)!.content as string
    assert.ok(appendix.includes('<current-goal'), 'appendix 应渲染 current-goal')
    assert.ok(appendix.includes('看一下左侧的侧边栏的默认尺寸是多少px'), 'appendix 含目标文本')
  })

  it('延续指令不更新目标（继续/可以执行了）', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const metaWrites: Array<string | null> = []

    session.setGoalTracking(
      (msgs) => extractGoalFromMessages(msgs as unknown as GoalSourceMessage[]),
      (next) => {
        engine.setGoalAnchor(next)
        metaWrites.push(next)
      },
    )

    session.addUserMessage('修复侧边栏宽度，避免一行重叠成两行')
    session.addUserMessage('继续')
    session.addUserMessage('可以执行了')

    assert.equal(session.getGoalAnchor(), '修复侧边栏宽度，避免一行重叠成两行')
    assert.equal(metaWrites.length, 1, '延续指令不触发新回调')
  })

  it('目标切换：新实质指令替换旧目标（一次回调）', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const metaWrites: Array<string | null> = []

    session.setGoalTracking(
      (msgs) => extractGoalFromMessages(msgs as unknown as GoalSourceMessage[]),
      (next) => {
        engine.setGoalAnchor(next)
        metaWrites.push(next)
      },
    )

    session.addUserMessage('修复侧边栏宽度')
    session.addUserMessage('悬浮位置放错，移动到输入框外面')
    session.addUserMessage('继续')

    assert.equal(session.getGoalAnchor(), '悬浮位置放错，移动到输入框外面')
    assert.deepEqual(metaWrites, ['修复侧边栏宽度', '悬浮位置放错，移动到输入框外面'], '两次实质变更各一次回调')
  })

  it('未注入 extractor：addUserMessage 零额外行为（回归清单项）', () => {
    const session = new SessionContext()
    session.addUserMessage('没有任何跟踪的普通消息')
    session.addUserMessage('继续')
    // 无 extractor → getGoalAnchor 恒 null，不抛错
    assert.equal(session.getGoalAnchor(), null)
  })

  it('首启装配路径：空历史注入（基线 null）→ 首条消息建立目标（审查 HIGH-1 回归）', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const metaWrites: Array<string | null> = []

    // 模拟 serve-agent 修复后的装配：空历史也注入 setGoalTracking（基线 null）
    session.setGoalTracking(
      (msgs) => extractGoalFromMessages(msgs as unknown as GoalSourceMessage[]),
      (next) => {
        engine.setGoalAnchor(next)
        metaWrites.push(next)
      },
      null, // 首启：无 meta 固化、无历史 → 基线 null
    )

    // 装配时无历史 → 不触发初始回调（HIGH-1 修复前注入被跳过；修复后注入但无内容）
    assert.equal(metaWrites.length, 0, '空历史装配不触发初始回调')

    // 第一条实质指令进入 → 增量提取建立目标
    session.addUserMessage('检查侧边栏默认宽度，修复重叠问题')
    assert.equal(session.getGoalAnchor(), '检查侧边栏默认宽度，修复重叠问题')
    assert.deepEqual(metaWrites, ['检查侧边栏默认宽度，修复重叠问题'])
  })

  it('frozen 基线优先：初始提取不得覆盖已固化目标（审查 HIGH-2 回归）', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const metaWrites: Array<string | null> = []

    // 装配前已有历史（resume 场景），meta 已固化 frozen 目标
    session.addUserMessage('旧任务：检查日志输出')
    session.setGoalTracking(
      (msgs) => extractGoalFromMessages(msgs as unknown as GoalSourceMessage[]),
      (next) => {
        engine.setGoalAnchor(next)
        metaWrites.push(next)
      },
      '旧任务：检查日志输出', // frozen 值——即使历史提取一致，也走基线而非初始提取
    )

    // 初始提取与 frozen 相同 → 不重复回调
    assert.equal(metaWrites.length, 0, 'frozen 基线存在时初始提取不回调')
    assert.equal(session.getGoalAnchor(), '旧任务：检查日志输出')

    // 新实质指令 → 正常增量更新
    session.addUserMessage('换成检查缓存命中率')
    assert.equal(session.getGoalAnchor(), '换成检查缓存命中率')
    assert.deepEqual(metaWrites, ['换成检查缓存命中率'])
  })
})
