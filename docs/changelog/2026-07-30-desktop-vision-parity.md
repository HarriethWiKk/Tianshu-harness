---
title: 2026-07-30 桌面端识图能力补齐：与 CLI 各自独立可用
type: changelog
status: done
date: 2026-07-30
related:
  - docs/changelog/2026-07-30-vision-copilot-review-fixes.md
  - docs/user-guide-vision.md
---

# 2026-07-30 桌面端识图能力补齐：与 CLI 各自独立可用

> 目标是一句话：**CLI 和桌面分开部署，各自都能自己把识图跑通**。此前识图的完整控制面只在 CLI 侧（TUI `/config` 面板 + `rivet browser` 命令），桌面端只有一个能选主识图模型的下拉——只装桌面端的用户碰到"图片没被看到"或"chromium 没装"时，唯一出路是自己开终端。

## 修的第一件事：保存会抹掉备用识图桥

`setVisionModelConfig` 是整体替换。桌面端 UI 只发 `provider/model/prompt/maxTokens`，TUI 面板同样只发四个字段——于是**任何一次保存都会吞掉用户手写的 `visionModel.fallback`**。同一份配置被两个界面轮流写时，后写的那个界面不知道的字段就消失了，而且没有任何提示。

改成三态语义：

| 载荷里的 `fallback` | 行为 |
|---|---|
| 省略 | **保留现有值**（"我没提到它" ≠ "我要删掉它"） |
| `null` | 清除 |
| 对象 | 设置/替换 |

两个界面同时补上备用桥的编辑入口，并且都显式发 `null` 来表达"清除"（否则界面里清不掉）：桌面端识图卡新增「备用识图模型」下拉（跨 provider 单选，排除与主桥相同的模型），TUI 面板新增 `vision.fallback` 字段（未选主桥时 guard 拦住）。

## 补的第二件事：桌面端能自己开关自动选桥

`agent.visionAutoBridge` 是 7-30 那批评审引入的 opt-in 开关（开了才会自动挑视觉模型送图）。它当时只接到了 TUI 面板。新增：

```
GET  /config/vision-auto-bridge   → { enabled }
PUT  /config/vision-auto-bridge   { enabled: boolean }
```

非布尔载荷返回 400 而不是强转——这个开关的语义是"允不允许把我的图片发给第三方"，不该被 `"yes"` 之类的输入蒙对。桌面端识图卡底部一个开关，文案明说"你的图片会发给那个 Provider，默认关"。

## 补的第三件事：桌面端显示的是真实桥状态，不是配置里有没有键

`GET /sessions/:id/vision-bridge`（7-29 加的）一直没有消费方。桌面端此前只能凭"config 里有没有 `visionModel`"来暗示能力，于是出现过"配了却报图片未发送"这类显示层误导。

现在识图卡顶部一行直接渲染运行时状态：主控原生支持 / 桥已生效 / 图片不会被看到（附后端点名的原因）。没有活会话时**明说状态未知**，不拿配置冒充运行时事实。

## 补的第四件事：附图时桌面端也会明说"这张图没人看得见"

TUI 早就在气泡下方警告"非视觉模型该附件会被自动丢弃"，桌面端一直照收不误——用户附了图、模型答得像看过，比不支持更糟。

`decideVisionAttachNotice`（`desktop/src/lib/vision-attach-notice.ts`）是个纯判定：有图 + 桥不活跃 → 警告并给「去配置识图模型」按钮（直接跳设置对应分类）。唯一的纪律是**不喊狼来了**：桥状态未知（会话还没建 agent / 请求 404）时不警告，假警告只会训练用户忽略所有警告。

## 补的第五件事：桌面端能自己装 chromium

截图是视觉验证的入口，chromium 约 150MB 不随包分发。CLI 有 `rivet browser status|install`，桌面端此前只能看着工具报错里那句"请运行 rivet browser install"——对没有 CLI 的用户是一条走不通的路。

新增 `src/server/browser-routes.ts`：

```
GET  /browser/readiness   探测（零副作用，不启动浏览器）+ 当前安装任务状态
POST /browser/install     启动安装（异步，{ mirror?: boolean }）
```

安装是**进程内单例任务**：并发跑两个 `playwright install` 会互相写同一份缓存，所以第二个请求返回 409 而不是排队。进度靠轮询 readiness（安装中 2s 一次，其余不轮），日志只留最近 40 行尾部。`module-missing`（playwright-core 模块本身缺失）在路由层就拦掉并且 UI 不给安装按钮——那不是"浏览器没下载"，装浏览器解决不了，按了只会白等几分钟。

桌面端新增 Settings → 集成 → **浏览器（截图）** 卡片：就绪状态、镜像/官方源两个安装按钮、实时日志、失败退出码与重试提示。

顺带修文案：`PLAYWRIGHT_INSTALL_HINT` 与 `formatBrowserMissingBanner` 之前只报 CLI 命令，现在两条入口都给（终端命令 + 桌面端设置路径）。

## 测试

- `src/server/__tests__/browser-routes.test.ts`（12 例）：安装状态机用注入的 spawn 替身测（不真下 150MB）——running 标记、并发拒绝、退出码记录、spawn 失败与下载失败的区分、失败后可重试、日志尾部裁剪；路由层断言形状 + `installable` 只在 `browser-missing` 时为真 + 鉴权。
- `src/server/__tests__/config-routes.test.ts` +4 例：auto-bridge 默认关、PUT/GET 往返、非布尔 400、鉴权。
- `src/config/__tests__/manager-vision-model.test.ts` +4 例：fallback 省略即保留 / 显式 null 清除 / 替换 / 畸形载荷拒绝。
- `src/tui/__tests__/settings-persist.test.ts` +1 例：备用识图模型存/读/清，且"只改 maxTokens"不带走备用桥。
- `desktop/src/lib/__tests__/vision-attach-notice.test.ts`（6 例）：含"状态未知时不警告"。

`src/server` + `src/config` + `src/tui/settings*` 全面跑：1009 例通过零失败。桌面端 `src/lib` 364 例通过。根仓库与 `desktop/` 的 `tsc --noEmit` 均干净（`desktop/` 侧余下 3 处报错属其他会话在改的文件：`GreetingSettings` 的 `ui/label`、`HomeWelcome` 未用变量、`cli-format` 未用变量）。

## 遗留

- 桌面端没有"启动时体检 chromium"的首屏提示（CLI 在浏览器 preset 下有）。目前依赖用户进设置或工具报错时的文案引导。
- 安装任务状态是进程内的，sidecar 重启即忘。重启后 readiness 探测本身就是事实来源，所以不持久化——但正在下载时重启 sidecar，UI 上会看不到进度（子进程仍在跑）。
