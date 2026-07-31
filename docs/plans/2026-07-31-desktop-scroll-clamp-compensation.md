---
title: 桌面端滚动"收缩钳位上移"修复——virtual-core 补偿谓词落地
type: plan
status: active
date: 2026-07-31
related: [../known-issues/2026-07-31-desktop-scroll-row-height-clamp.md, ../research/2026-07-31-chat-scroll-bottom-pinning-competitor-survey.md, ../known-issues/2026-07-24-desktop-scroll-four-symptoms.md]
---

# 桌面端滚动"收缩钳位上移"修复——virtual-core 补偿谓词落地（2026-07-31）

> 用 virtual-core 3.17.1 自带的 `shouldAdjustScrollPositionOnItemSizeChange` 谓词实现候选 2（钳位补偿）：跟随态下任何行高修正同步补偿 scrollTop，让"实测 < 估值 → scrollHeight 收缩 → 浏览器钳位上移"不再产生视觉跳动。

## 目标

- 钉底态（gap≈0）下行高收缩修正不再使视口上移：step8 构造收缩实验从"scrollTop 上移 937px"变为"gap 保持 0"
- 阅读态（上翻中）行为与现状逐字节一致：补偿语义逐字复刻库默认，前 7 轮修复的路径零变化
- 修复经自动化复现链（playwright）取证，不再依赖纯手工验收

## 非目标

- 不动 `estimateSize: 80`（候选 3 按 block 类型估值——可选后续，非必需）
- 不启用 `anchorTo:'end'` / `followOnAppend`（3.17.1 在官方修复串 3.17.2–3.17.7 之前，虚拟距离判定有阈值两难；升级 ≥3.17.7 后另行评估）
- 不动 `pinToBottomPersistent` 5 拍节拍、`NEAR_BOTTOM_PX=8`、`SCROLL_COOLDOWN_MS=400`、autoscroll 签名门
- 不引入行高持久化缓存（Orbit measure-once 路线，后续可选）
- 回底纪律不变：回底写入仍只走 `scrollToTrueBottom`；禁止 `virtualizer.measure()` 全量重置

## 背景与依据

- 根因链（已浏览器实测钉死）：底部行 80px 估值占位 → 挂载实测 < 80 → `resizeItem` 收缩 → totalSize/scrollHeight 收缩 → 浏览器钳位 scrollTop 上移 = "跳上去"。见 [`known-issues/2026-07-31-desktop-scroll-row-height-clamp.md`](../known-issues/2026-07-31-desktop-scroll-row-height-clamp.md)
- 库机制（`desktop/node_modules/@tanstack/virtual-core/dist/esm/index.js:818-873`）：`resizeItem` 默认仅补偿视口上方行（`itemStart < scrollOffset + scrollAdjustments`）；钉底时视口内行多在 scrollTop 之下 → 无补偿 → 钳位。自定义谓词时每次 `resizeItem` 同步回调，返回 true 即 `applyScrollAdjustment(delta)` 同步写 scrollTop
- 竞品验证（[`research/2026-07-31-chat-scroll-bottom-pinning-competitor-survey.md`](../research/2026-07-31-chat-scroll-bottom-pinning-competitor-survey.md)）：VS Code 同任务重钉 / Roo 收缩即时 re-pin / Chatbox maxScrollTop 指纹 / virtuoso SIZE_DECREASED 归类 / Orbit 手势门禁谓词——同帧补偿 + 意图区分是行业共识形态
- 关键代码位：`desktop/src/surfaces/ThreadView.tsx:662-690`（useVirtualizer 配置）、`:729-751`（sweepRowHeights）、`:922-949`（scrollToTrueBottom / pinToBottomPersistent）、`:1063-1136`（onScroll + isSyntheticClamp + lastShrinkTsRef）、`desktop/src/surfaces/use-scroll-intent.ts`

## 技术方案要点

在 `useVirtualizer` 增加谓词（改动集中在 `ThreadView.tsx` 一处）：

```ts
shouldAdjustScrollPositionOnItemSizeChange: (item, delta, instance) => {
  // 跟随态且确在底部：任何行高修正都同步补偿——收缩帧把 scrollTop 钉回新底部，
  // 浏览器钳位不再有机会上屏（2026-07-31 收缩钳位根修）
  if (!scrolledUpRef.current && !scrollIntent.userIntentUpRef.current) {
    const el = msgRef.current
    if (el) {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      if (gap <= NEAR_BOTTOM_PX) {
        scrollDebugLog('clamp-compensate', { index: item.index, delta: Math.round(delta), gap })
        return true
      }
    }
  }
  // 其余（阅读态/离底）：逐字复刻 virtual-core 3.17.7 默认语义，行为零变化
  // （实施时抽纯为 scroll-clamp.ts::shouldCompensateOnResize，含 itemSize 参数）
  const fold = instance.getScrollOffset() + instance.scrollAdjustments
  if (!instance.itemSizeCache.has(item.key)) return item.start < fold
  return item.start + item.size <= fold && instance.scrollDirection !== 'backward'
}
```

> 实施注记：该钩子在 virtual-core 不是 option 而是 d.ts 声明的可写实例字段，最终形态为
> `virtualizer.shouldAdjustScrollPositionOnItemSizeChange = …`（useVirtualizer 创建后幂等赋值）；
> 另加 `localStorage.rivetClampCompensate='0'` A/B 与应急开关。

设计要点：

1. **双保险判定跟随态**：`scrolledUpRef`（提交态）+ `userIntentUpRef`（同步意图 ref，wheel 当帧即 true，无一帧对抢窗）+ DOM gap ≤ 8px（排除"跟随态标签下实际在中部"的恢复/切会话路径——tab 切换恢复到中部锚点时 gap 数千 px，走默认语义不被拽）
2. **补偿与测量同帧**：谓词在 `resizeItem` 内同步执行，RO（measureElement）与 sweep 两条修正路径同源覆盖——覆盖所有收缩来源，无竞态窗口（对竞标品的"同任务"纪律）
3. **与既有取证/防护体系兼容**：补偿写入触发的 scroll 事件（scrollTop 降 + scrollHeight 缩）命中既有 `isSyntheticClamp` 指纹 + 120ms `lastShrinkTsRef` 分帧容错，不误置 intent、不打点冷却窗；新增 `clamp-compensate` debug 事件接入现有 `rivetScrollDebug` ring
4. **回退成本**：单文件单 option，git revert 即恢复原状

## 任务分解

- [x] 1. `desktop/src/surfaces/ThreadView.tsx` useVirtualizer 接入谓词 + `clamp-compensate` debug 事件（实施时发现：该钩子在 virtual-core 不是 option 而是实例字段，改为创建后幂等赋值；ref/常量声明已前移）
- [x] 2. 谓词逻辑抽纯函数 `desktop/src/lib/scroll-clamp.ts::shouldCompensateOnResize` + node:test 单测（仓库用 node:test 非 vitest；另补 `isSyntheticClamp` 5 例）
- [x] 3. 重建 playwright 复现链（探针与数据沉淀 `.tmp/repro-clamp/`）
- [x] 4. 验证 step8 构造收缩——**一轮（3.17.1）未达标**：A/B 两组逐帧相同、终态 gap 均 52；归因：补偿写入与 notify 分帧 + scrollAdjustments 累计错位（等同上游 #1209/#1227 修复点），单有谓词到不了终点
- [x] 5. 验证 step7 真实路径 + 二轮（3.17.7）step8 复测：**达标**——B 组终态 gap=3、锚点 +4px（A 组 52 / +53px）；clamp-compensate 4 条、无误置 intent
- [x] 6. 回归矩阵：① 阅读态上翻 + 修正并发——通过（上翻 600px 后 3s 零漂移）② 切会话恢复——谓词 DOM gap 双保险 + 单测覆盖（中部锚点 gap 数千 px 走默认语义）③ 历史回填 prepend 锚定——加载更早 ×8 流程反复经过，锚定无漂移 ④ 窗口 resize follow-snap——走同一谓词路径 ⑤ typecheck + 616 单测全过
- [ ] 7. 实机验收：macOS（WKWebView）+ Windows（WebView2）"长会话拉到底 + 流式会话拉到底"（流式路径需 API key）——**待用户实机**
- [x] 8. 收尾文档：known-issues 标注修复记录 + 本计划更新；`npm run docs:index` 重建索引

## 执行偏差记录

- **依赖升级（用户 2026-07-31 批准）**：react-virtual 3.14.3→3.14.9（virtual-core→3.17.7）。原计划「不升级库」的非目标在一轮验证判据未达成后由用户拍板变更；升级后谓词复刻的默认语义已同步对齐 3.17.7（重测需整行在折叠线上方 + 非 backward，#1218），单测同步更新。
- **候选 3 追加（用户 2026-07-31 批准）**：原计划列为非目标的「按 block 类型估值」同日追加实施——`estimateRowSize`（timeline 26 / user·steer 72 / assistant textLen 三档 90·270·700，实测分布依据 `.tmp/repro-clamp/data/row-heights-report.json`）；自然路径修正量 490px→0。压测暴露的收起高行误置 intent（候选 2 补偿写入与指纹的时序边界）一并修复（谓词预置 `lastShrinkTsRef`）；详见 known-issues 文档「展开/收起压测暴露与处置」。

## 风险与依赖

- **过度补偿**（跟随态误判把阅读位置拖动）→ DOM gap 双保险（≤8px 才补偿）+ 阅读态逐字复刻默认语义；回归任务 6-①② 专测
- **补偿写入与指纹体系交互**（scrollTop 降被误置 intent 冻结跟随）→ 既有 `isSyntheticClamp` + 120ms 分帧窗已覆盖该时序；验证任务 5 检查 `__rivetScrollLog()` 无 `intent-set`
- **流式中补偿与 autoscroll 双写**→ 两者同向（都指向真底）收敛；delta>0 的增长修正同步跟随反而减抖动，但需任务 7 实机确认无叠加抖动
- **库升级漂移**：谓词 API 是 virtual-core 长期稳定选项（非 3.17 新造），但 3.17.5+ 改了默认补偿内部实现——升级 react-virtual 时重读 `resizeItem` 源码核对谓词调用点；lockfile 现钉 react-virtual 3.14.3 → virtual-core 3.17.1
- **依赖条件**：playwright 复现链需本机 Chromium + sidecar/vite 双进程；流式实机验证需有效 API key
