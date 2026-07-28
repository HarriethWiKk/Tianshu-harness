/**
 * Overlay 期间主屏 commit 守卫测试。
 *
 * Bug：choice-panel（计划审批卡）等 overlay 激活期间，agent 收尾流/工具卡片/
 * 通知经 commitAbove 直写 stdout 落进 alt screen，擦花/顶滚动面板；而
 * OverlayEngine 的行级 diff 缓存（lastFrame，76da3ee4 引入）对此无感知，
 * 之后每次方向键只重绘光标变化行——「审批卡按一下方向键才出来一行」。
 *
 * 契约：
 * 1. overlay 激活期间 commitAbove 一个字节都不写 stdout（写入排队）；
 * 2. 退出 alt screen 时排队 commit FIFO 回放，且回放在 ALT_SCREEN_OFF 之后；
 * 3. 排队期间的方向键 diff 帧不夹带主屏文本。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'

test('overlay 激活期间 commitStatic 不写 stdout（排队）', () => {
  const { app, out } = makeApp()
  app.registerOverlays({})
  app.activateOverlay('choice-panel')
  out.clear()

  app.commitStatic('POLLUTION_MARKER_ONE')
  assert.ok(
    !out.chunks.join('').includes('POLLUTION_MARKER_ONE'),
    'overlay 激活期间主屏 commit 不得写 stdout',
  )
})

test('退出 overlay 时排队 commit FIFO 回放，且在 ALT_SCREEN_OFF 之后', () => {
  const { app, out } = makeApp()
  app.registerOverlays({})
  app.activateOverlay('choice-panel')
  app.commitStatic('QUEUED_A')
  app.commitStatic('QUEUED_B')
  out.clear()

  app.deactivateOverlay()
  const text = out.chunks.join('')
  const ia = text.indexOf('QUEUED_A')
  const ib = text.indexOf('QUEUED_B')
  assert.ok(ia >= 0 && ib >= 0, 'deactivate 后排队内容应落 scrollback')
  assert.ok(ia < ib, 'FIFO 顺序回放')
  assert.ok(text.indexOf('\x1B[?1049l') >= 0 && text.indexOf('\x1B[?1049l') < ia, '回放发生在退出 alt screen 之后')
})

test('overlay 激活 → 外来 commit → 方向键 rerender：diff 帧不夹带主屏文本', () => {
  const { app, out, stdin } = makeApp()
  app.registerOverlays({
    choicePanelData: () => ({
      title: '计划审批 / Plan Approval',
      choices: [
        { id: 'approve', label: '批准并执行', recommended: true },
        { id: 'reject', label: '驳回修订' },
      ],
      selectedIndex: 0,
    }),
  })
  app.activateOverlay('choice-panel')
  app.commitStatic('SNEAKY_MAIN_TEXT')
  out.clear()

  stdin.dataHandler!('\x1B[B') // ↓ 移动光标 → overlay.rerender() 走行级 diff
  const frame = out.chunks.join('')
  assert.ok(
    !frame.includes('SNEAKY_MAIN_TEXT'),
    'diff 帧不得夹带主屏文本（修复前会经 commitAbove 泄漏进 alt screen）',
  )
  assert.ok(frame.includes('驳回修订'), '光标目标行照常重绘')
})
