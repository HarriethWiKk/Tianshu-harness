---
title: 右栏文件树开合卡顿优化——首开常挂载保活
type: plan
status: active
date: 2026-07-31
related: [../known-issues/2026-07-31-desktop-scroll-row-height-clamp.md]
---

# 右栏文件树开合卡顿优化——首开常挂载保活（2026-07-31）

> 症状：右侧文件管理树（ReviewPanel「文件」页签内 FileExplorer）打开/关闭都有明显卡顿。
> 本计划最值得记录的方法论：**先量后改**——基线测量推翻了动手前的假设，方案随之转向。

## 基线测量与假设证伪（`.tmp/repro-clamp/data/panel-anim-baseline.json`）

动手前假设：卡顿 = 动画期逐帧成本（flex-grow 布局过渡 / 会话区 rewrap / 宽度 RO 每帧 sweep / backdrop-filter 重绘）四处叠加。

实测（playwright + rAF 逐帧 + longtask，长会话钉底，开合 5 循环）：

- p50/p95 全程贴 vsync（16.7/17.7ms）——**逐帧成本假设不成立**
- 尖峰集中在 open 窗口：max 中位 50.9ms、峰值 83.4ms，70-79ms 长任务只出现在 open——**主因是开时 ReviewPanel + FileExplorer 全量重挂载**（`usePresence` 关毕卸载）
- close 轻（中位 max 33.4ms）；宽度 RO sweep 每窗口 3-6 次、每次 8-11 行，不推 p95

**决策转向**：原方案 F1（sweep 去抖）/F2（钉会话区宽度）/F3（动画期停 blur）全部放弃（无数据支撑），改做 F4（挂载成本）。

## 方案：首开常挂载 + 空闲预挂载

- `WorkspaceSurface.tsx`：`reviewEverMounted` 闩锁——开过一次后 ReviewPanel 不再卸载；关毕只做 visibility 隐藏（`.review-keepalive.hidden`，`display:contents` 包装不改变布局；收起扫尾期 presence.mounted 仍 true 保持可见，动画不闪空）
- 空闲预挂载：既有 chunk 预热 `.then` 里 latch——预热只解决加载，预挂载解决挂载，第一次打开也免尖峰
- 安全性核实：ReviewPanel 无轮询/订阅/interval（仅 props 驱动的 effects 与条件 keydown 监听），隐藏期零后台活动；chrome 簇文件钮 active 态、browserPanelInView 等都有 `reviewVisible` 门控，预挂载不误亮
- 附带 UX 收益：文件树展开状态、打开的文件跨开合保留

## 任务分解

- [x] 1. 基线测量（假设证伪，见上）
- [x] 2. WorkspaceSurface 常挂载 + 空闲预挂载
- [x] 3. `.review-keepalive` 样式 + ReviewPanel 过期注释（seenTabRev 卸载假设）更新
- [x] 4. typecheck + desktop 全量 node:test
- [x] 5. 复测对比（`.tmp/repro-clamp/data/panel-anim-after-run2.json`）：重挂载尖峰消除（67-83ms 峰值与 70-79ms 长任务消失）；功能 4/4（关闭不可见不可点 / 树状态保留 / 动画不闪空 / active 态正确）
- [ ] 6. 安静机器复跑一轮确认残留差（复测期间本机被系统进程高负载抢占，min-of-N 隔离后 open 侧仍残留 ~16ms 单帧 style 重算/首绘——p50/p95 无感；如需再压可评估 content-visibility）

## 风险与遗留

- 隐藏期 ReviewPanel 仍随 props（artifacts/todos）重渲——非逐 token 频率，量级小；若后续 profiling 显示可省，再加可见性门控
- 残留 ~16ms open 侧单帧成本（visibility 恢复后的子树 style 重算 + 首绘）——肉眼无卡，暂不处理
- F1/F2/F3（动画期逐帧优化）留作后备：基线显示不是瓶颈，若实机仍有动画期卡顿再启用（原分析见会话计划稿 vision-gorgon-hal-jordan）
