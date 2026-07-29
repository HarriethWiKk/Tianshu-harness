---
title: 2026-07-29 TUI 设置面板 /config
type: changelog
status: done
date: 2026-07-29
related:
  - docs/changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md
  - docs/user-guide-vision.md
---

# 2026-07-29 TUI 设置面板 `/config`

> 上一轮查视觉通道时留了个尾巴：`agent.visionModel` 只有桌面端有 UI，TUI 用户只能手改 JSON。补入口时发现空白不止一处——子代理路由、审查子代理覆盖卡在 TUI 侧同样没有入口，而 `workers.patcherTier` / `workers.escalationCap` **两端都没有**。于是做成一个面板，一次把三块空白连同常用基础项收在一起。

## 做了什么

`/config`（别名 `/settings`、`/setup`）打开全屏设置面板：左栏五个分类，右栏字段。`Tab`/`←→` 切栏，`↑↓` 移动，`Enter` 编辑（布尔就地切换、枚举弹选择列表、文本/数字进编辑缓冲），`S` 保存，`Esc` 退出。

| 分类 | 覆盖 | 落盘 setter |
|------|------|-------------|
| 子代理 | 6 个任务键的 profile 路由、各 profile 的 provider·model、`patcherTier`、`escalationCap` | `setRoutingConfig({ workers })` |
| 审查子代理 | 7 个 profile 的模型覆盖（含「继承会话模型」= 删除覆盖）、`skipAuto`、`mechanicalFastPath` | `setRoutingConfig({ review })` |
| 识图模型 | provider·model（候选只列 `supportsVision`）、`prompt`、`maxTokens`、关闭桥接 | `setVisionModelConfig` |
| 基础 | `tools.preset`、`agent.approval`、`checkpointEveryTurns`、`defaultDomain`、`defaultModel` | 各自专用 setter |
| 网络与镜像 | 镜像开关与预设、`network.proxy` / `noProxy`、`search.backends` | `setMirrorConfig` / `setNetworkConfig` / `setSearchConfig` |

顺带补掉两处上游缺口：桌面端未暴露的 `workers.patcherTier` / `escalationCap`；桌面路由页漏掉的 `planning` 任务键（TUI 取 schema 默认与桌面列表的并集，不跟着漏）。

## 三个不想再踩的形状

**一、「保存了」必须是真的**。写入粒度是**块**，每块对应恰好一个 setter，只写真正改过的块——改代理地址不该顺手重写 workers 路由（那会覆盖别的会话刚改的值）。脏判定是**结构比较**而非改动标记：改了再改回去等于没改，不写。单个 setter 失败只报自己那块，其余照写，一个坏代理串吞不掉一次合法的路由修改。保存后**回读磁盘**作为新基线（setter 会规范化：schema 默认值、空串删键），否则面板显示会与磁盘悄悄分叉。

**二、生效时机必须如实说**。每个字段旁标 `即时` 或 `下次会话`。除 `agent.approval` 外全是下次会话——`workers` / `agent.review` / `network` / `search` 都在 `bootstrap.ts` 启动时读进运行时（`config.workers` at bootstrap.ts:817、`config.agent.review` at 670、`config.network` at 428），会话中途改磁盘不会生效。审批模式经运行时 hook 同步到当前会话（`ctx.agent.setApprovalMode` + badge + 落盘），是唯一的例外。

**三、未保存改动不能静默丢**。`Esc` 有脏块时先要一次确认，确认页也能直接按 `S` 保存。这正是上一轮反复踩的「失败不可见」形状——用户以为改完了，其实什么都没落盘。

## 接线：不加第 15 个位置参数

`registerOverlays` 已经挂了 14 个位置参数回调，再加一个会让签名彻底失控。设置面板不走它：配置读写留在 `slash-commands.ts`（同 `/mirror` 直接调 `setMirrorConfig` 的先例），`app.ts` 只收一个纯状态机和一个落盘闭包，因此不依赖 config manager。

光标也没进 `overlayNav`（与计划中的三个 nav 字段不同）：flow 每次开面板都由调用方读盘新建，光标与 draft 天然是新的，不需要靠 `resetNav()` 清理跨会话残留——少一份可能与 flow 分叉的状态。

## 文件

| 文件 | 职责 |
|------|------|
| `src/tui/settings-model.ts`（新） | 声明式分类/字段表：kind、取值域、生效时机、读写闭包；`dirtyBlocks()` 结构比较。纯数据 + 纯函数 |
| `src/tui/settings-flow.ts`（新） | 纯状态机：双光标、焦点、编辑缓冲、picker、脏确认、保存握手 |
| `src/tui/settings-persist.ts`（新） | 唯一的 I/O 边界：`loadSettingsDraft` / `loadSettingsEnv` / `saveSettings` |
| `src/tui/format/settings.ts`（新） | 左右分栏渲染，复用 `overlay-frame` 原语，宽度一律走 `stringWidth` |
| `src/tui/engine/app.ts` | `startSettings` / `getSettingsOverlayData` / overlay 注册 / 按键块 / 粘贴路由 |
| `src/tui/slash-commands.ts` | `/config`、`/settings`、`/setup` |
| `src/tui/command-palette.ts` | 命令面板登记 |

## 验证

四组测试，52 例全过：

- `src/tui/__tests__/settings-flow.test.ts`（23）—— 光标钳制（不环绕）、换分类复位字段光标、枚举光标定位到当前值、校验拒绝后编辑器不关、识图候选只列 `supportsVision`、未选模型时改 prompt 明确报错而非静默无效、改回原值不脏、`Esc` 脏确认三态。
- `src/tui/format/__tests__/settings-render.test.ts`（12）—— 行数与**显示宽度**恒等于终端网格（含 40 列窄屏、6 行极矮屏、40 字段滚动窗口、CJK 分隔线列位一致）。修出两个真 bug：窄屏下三列各设下限导致下限之和溢出把右边框顶行；状态行额外加一行导致 `height ≤ 6` 时页脚被 OverlayEngine 静默截掉。
- `src/tui/__tests__/settings-persist.test.ts`（11）—— 指 `RIVET_CONFIG_PATH` 到临时目录：只写脏块（其余块逐字不动）、改 workers 不动 review、写识图桥再清除、搜索后端清空回落默认链（不写空数组）、代理留空删键、单 setter 失败只报自己那块、审批 hook 拒绝时如实报错。
- `src/tui/engine/__tests__/settings-overlay.test.ts`（6）—— 按键归属：编辑文本时 `s` 是字符不是保存快捷键、`Tab` 切栏、`S` 只把脏块交给落盘通道、`Esc` 脏确认后才关闭。

`npx tsc --noEmit` 干净；`src/config` 190 例全过；`src/tui` 全量仅 `app-clipboard-image.test.ts` 一例失败，原因是该测试读**真实系统剪贴板**并假定其为空（宿主环境依赖，与本轮无关）。

## 遗留

1. **议事会席位**（`agent.council.seats`）未纳入 —— 数组结构 + `tierHint`/`noDowngrade` 语义复杂，仍需手改配置。
2. **profile 增删**未做 —— 只能改已有 profile 的模型，路由只能指向已存在的名字。
3. **只写用户级** `~/.rivet/config.json` —— 项目级 `.rivet-config.json` 优先级更高，若项目文件里有同名字段，会盖掉面板里看到的值；面板不提示这种覆盖。
4. `compact.*` / `cache.*` 无专用 setter（需整包 `saveConfig`），未纳入。
