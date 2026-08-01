---
title: 桌面端滚动跟随态几何脱节修复——内容几何守望者
type: plan
status: active
date: 2026-07-31
related: [../known-issues/2026-07-31-desktop-scroll-row-height-clamp.md, 2026-07-31-desktop-scroll-clamp-compensation.md]
---

# 桌面端滚动跟随态几何脱节修复——内容几何守望者（2026-07-31）

> 修复 known-issues 异常①：跟随态标记只在 onScroll 重估，行展开/收起等 scrollHeight 变化不产生 scroll 事件，标记与几何脱节（被顶开仍"跟随"遭拽回 / 归底滞留离开态不跟底）。方案：把「对称重估」从 clientHeight 维度补到 scrollHeight 维度——`.vlist` 内容几何守望者 + 纯函数双向矫正。

## 目标

- 钉底态展开折叠工作组被顶离底部（gap>64）→ 如实登记脱扣：后续内容签名变化不再 autoscroll 拽回
- 收起归底（gap≤8）→ 跟随自愈，不滞留离开态
- 初次加载/切会话首次钉底不误脱扣；dev（StrictMode）与生产构建行为一致

## 非目标

- 不替代既有 clientHeight RO（`ThreadView.tsx` R1 对称重估）——维度不同，原样保留
- 不在 TimelineGroup toggle 行动点修（只覆盖工作组一条路径，且组件不持有滚动状态）
- 不动 autoscroll 签名门与候选 2 补偿谓词（两者与本修复正交配合）
- 不追求消除 heal 幂等重翻的事件噪音（收敛正确，记录于 known-issues 遗留）

## 背景与依据

- 根因与实测证据：[`known-issues/2026-07-31-desktop-scroll-row-height-clamp.md`](../known-issues/2026-07-31-desktop-scroll-row-height-clamp.md)「展开/收起压测暴露与处置」（`.tmp/repro-clamp/data/fix2-expand.json`：展开 47/50/54 行 gap 漂到 4278、scrolledUp 滞留 true 至终态 gap=0）
- 既有先例：clientHeight 静默变化的同构问题由 2026-07-24「对称重估」修过（容器 RO 里 `gapNow≤8 && (scrolledUp||intent)` 即 flip 回跟随）；异常①是该问题在 scrollHeight 维度的姊妹篇
- 与候选 2 的配合：脱扣后谓词回默认语义（阅读位稳定），自愈后恢复全补偿；候选 2 同步钉住跟随态的一切测量/流式变化，使「原本钉着被顶开」只剩用户展开内容一种成因——这是 prevGap 判别成立的的前提

## 技术方案要点

- `scroll-clamp.ts::followGeometryAction` 纯函数：`prevGap≤8 && gap>disengageGatePx(64) && 跟随态 && 非冷却窗 → 'disengage'`；`gap≤nearBottomPx(8) && (scrolledUp||intent) && 非冷却窗 → 'heal'`；冷却窗（用户滚动 400ms 内）两方向都不动作。prevGap≤8 前置条件是初载判别（初值 Infinity）
- `ThreadView.tsx` `.vlist` 挂 callback ref + ResizeObserver：内容高度变化 → 算 gap → 调纯函数 → disengage（`intent=true + setScrolledUp(true)`，`follow-disengage` 事件）/ heal（`intent=false + setScrolledUp(false)`，`scrolledup-flip src:'geometry-content'`）
- callback ref 自带 RO 生命周期（卸载时 React 必以 null 回调断开）；**禁止另加 useEffect 卸载清扫**——StrictMode 双调用 effect 会误杀 RO 而 ref 不重跑（dev/prod 分叉实测教训）

## 任务分解

- [x] 1. `desktop/src/lib/scroll-clamp.ts` 新增 `followGeometryAction` 纯函数
- [x] 2. `desktop/src/lib/__tests__/scroll-clamp.test.ts` 新增 8 例（heal/disengage 全分支）
- [x] 3. `ThreadView.tsx` 几何守望者接线（`prevContentGapRef` 初值 Infinity、`FOLLOW_DISENGAGE_GATE_PX=64`、callback ref RO、`.vlist` 挂 ref、`follow-disengage` 事件入事件表）
- [x] 4. typecheck + desktop 全量 node:test 通过
- [x] 5. playwright 复测（`.tmp/repro-clamp/`）：prod build 与 vite dev（StrictMode）双环境——脱扣恰好一次且脱扣后「加载更早」无 autoscroll-fire 拽底；收起归底 heal、无残留 intent；初载无误脱扣；step8 gap≈3-5、阅读态零漂移（数据 `*-geom(dev).json`）
- [x] 6. StrictMode 缺陷修复：删除冗余卸载 useEffect（见技术方案要点末条），dev 下 RO 追踪确认存活（fires=15）
- [ ] 7. 实机验收（用户）：macOS WKWebView 展开工作组读流式输出不被拽；收起后恢复跟底

## 风险与依赖

- RO 触发频率高（流式每次行高变化）——回调仅一次 gap 计算 + 分支，O(1) 无布局读写
- heal 与手势竞态——冷却窗守卫，语义与既有 onScroll near 路径一致
- 脱扣门值误判（未预见路径产生 >64px 非用户成因 gap 增长）——可经 wheel 下滚/归底恢复，`follow-disengage` 事件可查；实机观察后可调
