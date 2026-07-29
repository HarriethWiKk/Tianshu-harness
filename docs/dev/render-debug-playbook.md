# 桌面端渲染问题调试 Playbook

> 沉淀桌面端"会话打开慢 / 骨架屏不消失 / 行重叠 / 流式卡顿"等渲染问题的诊断流程。
> 每个调试点都已在代码里留了 instrumentation，复用时按本文开启即可，不用从零加日志。

## 总原则：分层计时

渲染问题最忌"在 backend 找 frontend 的 bug"。先分层计时，定位延迟在**哪一段**，再去那段深挖：

```
用户点击 → 前端 fetch 发出 → 后端路由进入 → 后端处理 → 后端响应头 flush → 前端 fetch 返回 → React 状态更新 → DOM 渲染
```

任何一段卡住都会表现为"UI 慢"，但根因可能跨前后端。下面的 instrumentation 覆盖关键节点。

## 调试 instrumentation（已埋点，复用即可）

### 后端（sidecar）—— `RIVET_DEBUG_RENDER=1` 门控

| 位置 | 日志 | 说明 |
|---|---|---|
| `src/server/session-routes.ts` `POST /sessions` | `[createSession] +Xms id=... cwd=...` | 会话创建耗时。慢的话查 `loadConfig`、`createWorktree` |
| `src/server/session-routes.ts` `GET /sessions/:id/stream` | `[stream] getEventsAsync +Xms events=N id=...` | 历史日志读取耗时。大日志会话会慢 |

**开启方式**：sidecar 启动时设环境变量。dev 模式：

```bash
# 在仓库根
RIVET_DEBUG_RENDER=1 RIVET_ACTIVATION_DEV_BYPASS=1 npm --prefix desktop run tauri:dev
```

生产打包版（已安装的 app）：sidecar 由 Rust spawn，环境变量要由 Rust 注入——临时改 `desktop/src-tauri/src/lib.rs` 的 `spawn_from_spec` 加一行 `cmd.env("RIVET_DEBUG_RENDER", "1")`，重打包。日志在 `<rivet-home>/logs/sidecar-*.log`。

### 前端（webview）—— vite dev 模式自动开

| 位置 | 日志 | 说明 |
|---|---|---|
| `desktop/src/runtime/sse.ts` `streamSession` | `[sse] fetch start` / `[sse] fetch returned +Xms status=N` | fetch 往返耗时。区分"fetch 慢"（网络/响应头）vs"onOpen 没调" |

**开启方式**：仅 vite dev 模式（`import.meta.env.DEV`）自动开。生产构建被 minify 剥离。dev 模式下打开 webview devtools（F12）看 console。

> 想在生产构建看前端计时，临时把 `__dbg` 判定改成 `true` 重打包（minify 不会删 console.log 里引用的变量，但会删未被引用的——所以计时变量要被 console 用到才会保留）。

## 常见症状 → 诊断路径

### 症状 1：骨架屏长时间不消失（>1 秒）

**先确认是哪种骨架**：三块灰色占位条 = `skeleton-msg-block`（连接中），不是欢迎页。

**诊断步骤**：

1. 开 dev 模式 + `RIVET_DEBUG_RENDER=1`，开 webview devtools
2. 开新会话，看两路日志的时间：
   - 后端 `[stream] getEventsAsync +Xms` —— 后端处理耗时
   - 前端 `[sse] fetch returned +Xms` —— fetch 往返耗时
3. **判断**：
   - 后端 X 大（秒级）→ 后端读历史/创建会话阻塞 event loop，查 `loadConfig` / `getEventsAsync`
   - 后端 X 小但前端 fetch X 大 → **响应头没 flush**（经典坑，见下方"已踩过的坑"）
   - 两边都小但骨架仍不消失 → React 状态没更新，查 `useSyncExternalStore` 的 snapshot 引用、`onOpen` 是否被调

### 症状 2：会话打开慢（点新会话到可用）

1. 看 `[createSession] +Xms` —— 创建会话本身耗时
2. 看 `[stream] getEventsAsync +Xms` —— 首次历史读取
3. 大日志会话（几千事件）的历史读取慢是正常的（已用 `getEventsAsync` 异步化 + 时间片回放，但仍受 IO/解析限制）

### 症状 3：流式输出时行重叠 / 高度跳变

这是 virtualizer 的 `measureElement` 节流问题，不是网络。

- 流式期间活跃行高度走 100ms 节流缓存（`MEASURE_THROTTLE_MS`）
- 收尾依赖 ResizeObserver 再触发落定精确高度
- WebView2 下 ResizeObserver 触发可能不到 → 陈旧短高度让后续行重叠

**修法已在** `ThreadView.tsx` 的 `prevStatusRef` effect：`status` 从 `running` 沉降时清缓存 + `virtualizer.measure()` 全量复测。

### 症状 4：流式输出时鼠标滚轮向上被拉回底部

竞态：wheel 触发的 `setScrolledUp(true)` 异步，与流式 token batch 的 auto-scroll effect 在同一帧时，effect 读到旧 `scrolledUp=false`，把视图拽回底部。

**修法已在** `use-scroll-intent.ts`（独立 hook，wheel/键盘/滚动条三路同步 intent ref）。

### 症状 5：点设置页 / 新建会话，几秒纯空白（不是骨架屏，是什么都没有）

**先分清运行方式**——dev 与打包态是两回事：

- **dev 模式**：已解决。覆盖层是懒加载的，Vite 要在点击那一刻现场转译整棵子树（设置页 92 个本地模块 + 15 个三方包），而当时 `<Suspense fallback={null}>` 在 chunk 到位前一个像素都不渲染。修法是空闲预热（`lib/lazy-view.ts` 的 `usePrefetchOnIdle`）+ 可见占位（`OverlayFallback` / `PaneSkeleton`）。**新增覆盖层时照此办理，别再用 `fallback={null}`**（有 `eager-bundle-guard` 守着分组页不被并回主 chunk）
- **打包态**：**仍未解释**。后端（52ms）、chunk 体积、混淆器运行时开销均已排除。下一步是在打包应用内开 devtools 录 Performance 时间线，而不是继续推演；Tauri 自定义协议的资源加载开销是当前最靠前的未验证嫌疑

详见 [`docs/analysis/2026-07-29-桌面端加载延迟归因.md`](../analysis/2026-07-29-桌面端加载延迟归因.md)。

## 已踩过的坑（高价值案例）

### 坑 1：SSE 响应头没 flush，新会话骨架屏卡 6 秒（2026-07-19）

**现象**：dev 模式开新会话，骨架屏显示约 6 秒才消失。后端日志显示 `getEventsAsync +0ms`（毫秒级），前端 fetch 报 `+6000ms` 才返回。

**根因**：`SseStream` 构造函数 `res.writeHead(200, ...)` 后没有 `res.flushHeaders()`。Node 默认缓冲响应头，直到第一次 `res.write()` 才发出。但新会话 `events=0`，没有 replay 数据要写，响应头一直待在缓冲区，前端 `await fetch` 等不到响应头。

**之前为什么"看起来 work"**：有一个 6 秒的 `skeletonExpired` 兜底超时，超时后强行显示欢迎页。所以用户看到的是"6 秒后骨架消失"，掩盖了响应头延迟。

**修法**：`sse-stream.ts` 构造函数末尾加 `res.flushHeaders()`。

**教训**：
- 后端处理快 ≠ 前端拿到响应快，响应头 flush 是独立的一步
- SSE 这种"响应头先发、body 流式"的场景，必须主动 flushHeaders
- 兜底超时掩盖了真问题——"能用但有延迟"的兜底要警惕，可能藏着真正的 bug

### 坑 2：`Start-Process -LiteralPath` 参数名根本不存在（2026-07-19）

**现象**：Windows 文件浏览器右键"打开"永远失败。测试断言的是错误命令，测试绿但功能坏。

**根因**：`Start-Process` 没有 `-LiteralPath` 参数（那是 `Get-Item`/`Remove-Item` 等 Item cmdlet 的参数）。PowerShell 报"找不到与参数名称 LiteralPath 匹配的参数"。

**修法**：Windows 上 `reveal=false` 直接 spawn `explorer.exe [路径]`，绕过 PowerShell。

**教训**：测试如果只断言"生成的命令字符串"，不验证"命令实际能跑"，会放过这种 bug。涉及平台命令的工具，测试里应该实际 exec 一遍（或至少 `--help` 验证参数存在）。

### 坑 3：UpdateBanner 无条件渲染，check() 返回 null 也显示横幅（2026-07-19）

**现象**：装 2.19.5 后仍提示"新版本可用"，且不显示版本号。

**根因**：`UpdateBanner` 组件只在 `dismissed` 时 `return null`，没处理 `!update && !error` 的情况。即使 `check()` 返回 null（没有更新），横幅 div 照样渲染，走 else 分支显示"新版本 [空版本号] 可用"。

**修法**：`if (!update && !error) return null`。

**教训**：横幅类 UI 组件必须有"无内容时不渲染"的早返回。只靠内部 state 控制内容分支不够——空 state 也要 return null，否则会显示空壳。

### 坑 4：tauri.windows.conf.json overlay 改了不生效（2026-07-19）

**现象**：Windows 窗口原生标题栏（天枢图标 + 最小化/最大化/关闭按钮）一直显示，跟自定义 chrome 形成两层标题栏。`tauri.windows.conf.json` 已设 `decorations: false`、`transparent: false`，重启 dev 不生效。

**根因（两层）**：

1. **tauri-build 缓存 bug（[Issue #10963](https://github.com/tauri-apps/tauri/issues/10963)）**：只改 overlay 文件不会触发重新合并，必须 touch 主 `tauri.conf.json` 或清 `target/debug/build/{tianshu-desktop,tauri-build}-*`。touch 主 conf 有时也不够，清缓存目录才稳。
2. **decorations 字段本身的 bug（[Issue #11296](https://github.com/tauri-apps/tauri/issues/11296) / [#14859](https://github.com/tauri-apps/tauri/issues/14859)）**：即使 overlay 正确合并（其他字段如 title 生效了），`decorations: false` 在某些 Tauri 2 版本仍不生效——原生标题栏照显示。`shadow: true` 会加剧这个 bug，但 `shadow: false` 也不一定解。

**诊断技巧**：临时把 overlay 里某个**显眼的字段**（如 `title`）改成测试值（`=== TEST OVERLAY ===`），看窗口标题变没变。
- 变了 → overlay 合并生效，问题在那个字段本身（如 decorations 的 bug）
- 没变 → overlay 根本没读，清 tauri-build 缓存

**修法**：`setup` 块加运行时强制调用：
```rust
#[cfg(target_os = "windows")]
if let Some(window) = app.get_webview_window("main") {
    let _ = window.set_decorations(false);
}
```
配置里的 `decorations: false` 保留（未来 Tauri 修复后会自然生效）。

**教训**：
- Tauri 2 的配置层有 bug，涉及原生窗口装饰时优先用**运行时 API**（`set_decorations`、`set_transparent` 等）兜底
- 改 `tauri.*.conf.json` 后必须清 `target/debug/build/{tianshu-desktop,tauri-build}-*`，否则可能用缓存的旧合并结果

### 坑 5：`/health` 的 `loopLagMaxMs` 是启动残留，别拿它归因当前操作（2026-07-29）

**现象**：最大会话（43,717 事件）冷读 972ms，同时 `/health` 报 `loopLagMaxMs ≈ 950`。数值贴得极近，看着就是「历史解析堵死了事件循环」。

**根因**：`loopLagMaxMs` 是**进程存活以来的最大值**，不是当前操作的。在 uptime 4 秒、一个会话都还没读过的 sidecar 上它就已经是 950——那是启动期的开销。真去测冷读期间的滞后，最大只有 1.5–16ms：parse 早就卸载到了 cpuPool，主线程一直是通的。

**真问题在另一处**：worker 把全量 43,717 条解析结果搬回主线程，调用方随即按内存环容量截到 5,000 条。structured clone 的成本与条数成正比（全量 139ms vs 尾部 14ms），九成搬运纯属浪费。修法是把截断挪进 worker（`parseEventsTailRaw`），只让尾部过线程边界。

**教训**：
- 累计型指标（max/total）不能用来归因单次操作。要测某段区间就在那段区间内自己采样
- 两个数字接近不等于同一个因果。这次 950 与 972 的贴合纯属巧合，差点据此改错地方
- worker 卸载的收益要算两笔账：**CPU 不占主线程**是一笔，**结果搬回来**是另一笔。凡是 worker 返回大数组的地方都值得复查后者

详见 [`docs/analysis/2026-07-29-桌面端加载延迟归因.md`](../analysis/2026-07-29-桌面端加载延迟归因.md)。

## 调试时常用的命令片段

```bash
# 杀掉所有 dev 进程,再起一个干净的（避免多实例端口冲突）
powershell -Command "Get-Process -Name tianshu-desktop,node -ErrorAction SilentlyContinue | Stop-Process -Force"
sleep 2
cd /d/dev/revit/desktop && RIVET_ACTIVATION_DEV_BYPASS=1 npm run tauri:dev

# 改了 tauri.*.conf.json overlay 后必须清 tauri-build 缓存,否则用旧合并结果
rm -rf desktop/src-tauri/target/debug/build/tianshu-desktop-*
rm -rf desktop/src-tauri/target/debug/build/tauri-build-*

# 看最新 sidecar 日志
LATEST=$(ls -t "D:/Program Files (x86)/Tianshu/TianshuData/.rivet/logs/"sidecar-*.log | head -1)
cat "$LATEST"

# 手动起 sidecar 测试 (绕过 Rust spawn, 拿到 token 直接测)
RIVET_HOME="D:/Program Files (x86)/Tianshu/TianshuData/.rivet" RIVET_SERVER_TOKEN=testtoken \
  "D:/Program Files (x86)/Tianshu/node-runtime/win-x64/node.exe" \
  "D:/Program Files (x86)/Tianshu/rivet-runtime/main.js" serve --port 19999
curl -s -H "Authorization: Bearer testtoken" http://127.0.0.1:19999/health
```
