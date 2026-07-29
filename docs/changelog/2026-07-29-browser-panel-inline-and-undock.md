---
title: 2026-07-29 浏览器面板：内联看图 + 非阻塞提示 + 全屏/独立窗
type: changelog
status: done
date: 2026-07-29
related:
  - docs/changelog/2026-07-15-browser-computer-use-workflow-loop.md
  - docs/changelog/2026-07-26-frontend-visual-verification-loop.md
  - docs/changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md
---

# 2026-07-29 浏览器面板：内联看图 + 非阻塞提示 + 全屏 / 独立窗

> 上一轮给桌面端加了「截图落地就自动展开右栏浏览器 tab」。用户在小窗口实测：**什么都没看到**。根因不是判定错了——是右栏本身就不该在那个窗口宽度下开着（默认 380px，窗口 <1200px 时被窄窗规则自动收起）。自动弹一个系统判定不该开的窄面板，等于没提示。这一轮把「怎么看到渲染结果」整条路重做。

## 做了什么

**一、截图在会话区就地看**。`browser_debug` / `computer_use` 的截图结果行默认展开，图直接画在对话流里——渲染结果是「看一眼就知道对不对」的信息，藏在折叠行后面等于没送到。同一工作组里只有**最新**那张摊开，新图到达时旧行自动收回；用户手动开合过之后两个方向都不再抢（手动状态永远赢）。

哪一行是「最新」由父级算：`lastScreenshotResultKey(blocks)` 每个虚拟行算一次（不是每个子行各算一次，否则是 O(子行×块)），按 `→ artifact` 尾巴识别而不是工具名——open / click / observe 这些非截图动作天然没有它。`PairedRow` 的 memo 比较必须带上这个 prop，漏了它「我不再是最新」就被 memo 吃掉，旧行永远收不回去，一次浏览循环下来整组都是展开的大图。

**二、自动弹面板改成非阻塞提示条**。删掉 `browser-auto-open.ts`，换成会话区一条「浏览器有新截图 / 查看渲染结果 / ×」。不用审批通道——那会真把 agent 那一轮挂住等人。提示条只在浏览器面板**不在眼前**时出现（注意不是「右栏是否展开」：右栏开在别的 tab 时提示仍然有用，一键切页），面板进入视野即自动撤掉。

提示条的去处由宿主注入（`ThreadView` 的 `onOpenBrowserPanel`）而不是自己 dispatch：pop-out 窗口里根本没有右栏，不注入就既不显示提示、也不白拉一次 artifact 查询。

**三、全屏覆盖**。面板 URL 栏上多一个「全屏」，`fixed inset-0 z-40` 把整个镜像（URL 栏、大图、时间线、抽取文本）铺满窗口——不是只把图放大，那是 lightbox 的活。`z-40` 压在 lightbox(`z-50`) 之下，全屏里点图还能再叠一层看原始尺寸。`Esc` 逐层退：先关大图，再退全屏。

**四、独立窗口（DevTools 式 undock）**。`open_browser_window` 开一扇 1180×860 的新窗，`?popout={id}&view=browser` → `PopoutBrowserRoot`。label 前缀与线程 pop-out 不同，所以线程窗与浏览器窗可以并存；同一会话重复调用只是聚焦已有窗口。窗内 `BrowserPanel` 自己订阅 SSE 并从 seq 0 重放派生状态，开在哪个时刻都是完整的；空态里「让 agent 去开个页面」的 CTA 仍可用，不是死窗。已经在 pop-out 窗里就不再显示「独立窗口」按钮（点了只会聚焦自己，看着像坏的）。

## 顺带修掉的错误路标

`browser_debug` 在打包/桌面环境下报 “Playwright chromium unavailable，请运行 `playwright install`”，把排查引向了完全错误的方向：真实成因是 `dist/node_modules/playwright-core` 是**空壳目录**（`npm run build` 清空 dist 后漏跑 `scripts/stage-runtime-deps.js`），空目录反而遮蔽了仓库根部完整的包。

- 模块解析失败与浏览器缺失分成两条文案，各自带上原始错误首行（它含解析尝试过的具体路径，是唯一直接指向成因的信息）。
- `browser-debug/driver.ts` 自己抄的那份 `loadPlaywright()` 删掉，改用 `net/playwright-driver.ts` 的 `loadPlaywrightCore()`；安装提示只挂在 `isBrowserMissingError(err)` 为真的**启动**失败上。

## 文件

| 文件 | 变化 |
|------|------|
| `desktop/src/lib/browser-shot-notice.ts`（新） | 提示判定纯函数，替代 `browser-auto-open.ts`（删） |
| `desktop/src/surfaces/PopoutBrowserRoot.tsx`（新） | 独立窗根组件（标题跟随会话、置顶开关） |
| `desktop/src/surfaces/BrowserPanel.tsx` | 全屏 / 弹出按钮、Esc 逐层退出 |
| `desktop/src/surfaces/ThreadView.tsx` | 提示条 + 把「最新截图」传给工具行 |
| `desktop/src/components/ToolGroup.tsx` | 截图行自动展开 + `lastScreenshotResultKey` |
| `desktop/src/surfaces/WorkspaceSurface.tsx` | 删自动展开 effect，改注入 `onOpenBrowserPanel` |
| `desktop/src/lib/popout.ts`、`desktop/src-tauri/src/lib.rs` | `openBrowserPopout` / `open_browser_window` |
| `desktop/src/lib/review-tabs.ts` | 抽出 `isBrowserShotArtifact`，tab 露出与提示判定同一口径 |
| `src/tools/browser-debug/driver.ts`、`src/tools/net/playwright-driver.ts` | 加载失败文案分流 |

## 验证

- `desktop/src/lib/__tests__/browser-shot-notice.test.ts`（11）—— 冷启动打开有历史截图的会话不提示、切走再切回不因存量提示、**数据未到的那一轮不写数字基线**（TanStack v5 换 key 时 data 先是 `undefined`，记成 0 就会把存量误判成新增）、面板在眼前时不打扰、右栏开在别的 tab 仍提示、批量落盘只提示一次。
- `desktop/src/components/__tests__/tool-group-screenshot.test.ts`（5）—— 只认最后一条带图的**结果**块，失败块与工具块都不顶替。
- `desktop/npx tsc --noEmit` 干净；`cargo check` 干净；`desktop` 侧 review-tabs 10 例、CLI 侧 `browser-debug` + `net` 138 例全过。

## 遗留

1. **提示条不持久**：`×` 忽略后若同会话再来新图会再提示（有意——每张新图都是新信息），但刷新页面后当前批次的提示不会重现。
2. **独立窗不记忆尺寸/位置**：每次开都是 1180×860 默认值。
3. **全屏态不跨会话保留**：切会话后回到右栏形态。
4. 内联自动展开只覆盖 `browser_debug` / `computer_use`，其他产图工具（如未来的图表工具）仍需手动展开。
