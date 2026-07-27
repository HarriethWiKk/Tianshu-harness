# 前端视觉验证闭环复盘（2026-07-26）——从一次性脚本到 browser_debug 内建能力

> 范围：桌面端前端改造四轮（`cbabe78c`）的验证过程复盘，以及由此暴露的工具缺口修复（`browser_debug` 视口 + 截图视觉回流）。
> 相关源码：`src/tools/browser-debug/`、`src/agent/tool-execution.ts`、`src/agent/vision-service.ts`。

## 一、这一轮实际怎么验的

改造对象是桌面端四块界面：首页空态、新建会话对话框、侧边栏、设置页（从会话区内的 surface 提升为全窗口层）。视觉改动没有"跑测试就知道对不对"的东西——CSS 改完，唯一可靠的判据是**看渲染结果**。

实际用的循环是这样的：

1. `npm run dev` 起 Vite（桌面端前端可脱离 Tauri 壳在浏览器里跑）。
2. 写一次性 Playwright 脚本丢到 `/tmp/`（`shot-settings.mjs`、`measure-settings.mjs`、`inspect-portal.mjs` 等），连系统 Chrome，导航、关弹窗、点到目标状态、截图。
3. 用 `read_file` 读回 PNG——模型看图，判断对不对。
4. 布局对不上时不靠肉眼猜，用 `page.evaluate` 取 `getBoundingClientRect()` / `elementFromPoint()` 拿数字；改完再跑一遍同一脚本做前后对照。

**只有第 4 步是能定性的**。前三步定位现象，第 4 步定根因。

## 二、这套循环抓到了什么（都是纯代码审查看不出来的）

| 问题 | 现象 | 靠什么定性 |
|---|---|---|
| 设置内容列与标题错位 | 截图上偏一点，说不清偏多少 | `getBoundingClientRect()` 量出 `.settings-content` 收缩到内容宽度而非 700px 容器——`margin-inline:auto` 在 column flex 里不撑满，补 `width:100%` |
| Select 下拉被设置窗遮住 | 点开下拉没反应 | `elementFromPoint()` 打到设置层而非下拉——portal 默认 `z-index:50` < 设置层 90 |
| 导航列底部被裁 | 860px 高度下"帮助"组看不见 | 量总高对比视口高，反推每项要压掉几 px |
| 新建对话框"创建"按钮不可见 | 按钮位置是空白 | 截图 + 取色，确认用了不存在的 token，改走 `--accent`/`--accent-fg` |
| `updatedAt` 全被刷平 | 侧边栏时间分组全挤在一组 | 这条不是浏览器抓的——是分组做出来以后看着不对，回头查 `session-manager.ts::abort()` 无条件写 status 事件 |

最后一条值得单列：**视觉验证会把后端 bug 逼出来**。时间分组是纯展示改动，但做出来一看全挤在"今天"，才发现 sidecar 每次启停都在 abort 空闲会话、把 `updatedAt` 刷成同一个值。不做这个展示，这个 bug 可以再潜伏很久。

## 三、暴露的工具缺口

整个过程是**用一次性脚本绕过工具**做完的，而不是用 `browser_debug`。绕过的两个原因就是这次要修的：

**其一，视口写死。** `driver.ts` 里 `viewport: {width:1280,height:800}` 是常量，没有任何入口能改。响应式断点问题只在特定宽度下暴露——"导航列在 860px 高度下被裁"这类问题，从固定尺寸看永远是隐形的。想验多个宽度就只能自己起 Playwright。

**其二，截图到不了模型眼前。** `screenshot` 动作返回的是一句"截图已保存到 <路径>"。模型知道有张图，不知道图上是什么。要真看到，得再手动 `read_file` 那个路径——多一跳，而且只在主模型支持视觉时才成立。相比之下 `computer_use snapshot` 早就通过 `ToolResult.images` 把 PNG 直接挂到对话里了，`browser_debug` 这条路一直没接。

## 四、本次修复

### 视口

- `BrowserDebugDriver` 加 `setViewport(w,h)` / `viewportSize()`；`DriverLaunchOptions.viewport` 透传到 `launchPersistentContext`，`open` 带尺寸时一次到位、不闪。
- 新动作 `set_viewport {width?, height?}`。只给 `width` 时**保留页面当前高度**（`parseViewport` 接受回退基准，resize 传实时尺寸、新建传启动默认），扫断点不用每次重述高度。
- 边界 240–3840 px，整数校验。下界防退化页面，上界防截图变成兆像素负载。
- CDP 连接模式只在**显式传了尺寸**时才 resize——接管的是用户自己的窗口，连上去就把人家窗口改了是意外副作用。

### 截图视觉回流

- `screenshot` 现在填 `ToolResult.images`（data URL），并在正文里报出当前视口尺寸——一张图得说清是哪个宽度下的图。
- 超过 3.5MB 不挂图，只留文件路径并提示缩小视口。base64 膨胀三分之一且会在对话里驻留整个会话，超大图的代价远超看一眼的价值。
- **视觉桥打通**：`tool-execution.ts` 原来只有 `supportsVision === true` 一条路，false 就丢图。现在补了第二条——主模型是纯文本但配了 `agent.visionModel` 时，走 `describeImages` 把截图描述成文字追加。这条桥本来就在为用户附图服务（`loop.ts::run`），只是没接到工具自己拍的图上。**agent 能截图却看不见截图，是闭环差的最后一步。**
- 桥失败被隔离（try/catch）：侧模型挂了不能拖垮整批工具结果，结果本身没有它也成立。桥缺席时行为与改动前逐字节一致。
- 注入点仍是工具结果之后的尾部追加——和 steer 路径同一个边界，前缀缓存安全，不重写历史。

### 怎么用

`browser_debug` 不在 `minimal` 预设里，需要 `frontend` 或 `full`（`RIVET_TOOL_PRESET=frontend` 或配置 `tools.preset`）。非回环主机要走 `RIVET_BROWSER_ALLOWLIST`。典型一轮：

```
browser_debug {action:"open", url:"http://localhost:5173", width:1440, height:900}
browser_debug {action:"screenshot"}            # 模型直接看到 1440 宽下的渲染
browser_debug {action:"set_viewport", width:768}
browser_debug {action:"screenshot"}            # 同一高度、平板宽度
browser_debug {action:"eval", expression:"JSON.stringify(document.querySelector('.settings-content').getBoundingClientRect())"}
```

主模型支持视觉就直接看图；不支持但配了 `agent.visionModel` 时自动走描述桥；两者都没有则退回旧行为（只给文件路径）。

### 测试

- `src/tools/browser-debug/__tests__/tool.test.ts` +5：open 带尺寸、宽度单改保高、越界/非整数拒绝、截图挂图并报视口、超限降级。
- `src/agent/__tests__/tool-execution-vision.test.ts` +4：桥路径注入描述且**不带图像分片**、视觉模型优先于桥、桥抛错不影响工具结果、空描述不注入。

## 五、留给下一轮

- **降采样没做**。1280×800 的 PNG 直接进对话，没有 `computer_use` 那样的 1440px 上限缩放（macOS 用 `sips`、Windows 在脚本内做，`browser_debug` 跨平台没有现成的等价物）。目前靠视口上限 + 3.5MB 硬闸兜着。真要压，得引入图像处理依赖或走 CDP 的 `captureBeyondViewport` + scale。
- **没有"扫断点"的复合动作**。现在验三个宽度是三轮 `set_viewport` + `screenshot`。可以考虑 `screenshot {widths:[390,768,1440]}` 一次出三张，但要先想清楚三张图一起进对话的 token 代价。
- **这套循环还没写进提示词**。工具描述里加了一句"改完 UI 用它自查"，但 agent 会不会真的在改完 CSS 后主动去看，取决于星域/提示词层面的引导，本次没动。
- `/tmp/` 里那批一次性脚本没有沉淀成 harness。参考输入框那轮的 `desktop/scripts/scroll-harness.html`，桌面端视觉回归值得有个固定入口。
