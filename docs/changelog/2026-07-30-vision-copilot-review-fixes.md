---
title: 2026-07-30 视觉副驾评审修复：自动选桥改 opt-in + 工具截图可追问
type: changelog
status: done
date: 2026-07-30
related:
  - docs/changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md
  - docs/user-guide-vision.md
---

# 2026-07-30 视觉副驾评审修复：自动选桥改 opt-in + 工具截图可追问

> 复查 `feb50615` / `6bd29a19`（从公开仓反向同步的「chromium 安装引导 + 视觉副驾 v2」）。同步本身是干净的：HEAD `tsc --noEmit` 通过、随附 49 例测试全绿，7-29 那批修复（`PLAYWRIGHT_INSTALL_HINT` 语义、`describeImages` 去重、`isBrowserMissingError` 分流）都没被覆盖。但有三处行为需要纠正，其中两处是「承诺了却没接线」和「替用户做了不该默认做的决定」。

## 一、自动选桥：从默认开改成显式 opt-in

`buildVisionClient` 在未配 `agent.visionModel` 时会遍历所有 provider，挑第一个有可用凭据的视觉模型建桥（优先级：主 provider > minimax > glm）。这让「开箱即用」的代价变成**把用户的图片发给一个用户从未为此选择过的 provider**——成本与隐私决定，不该由默认值代做。

改法：新增 `agent.visionAutoBridge`（默认 `false`）。关着的时候不静默丢图也不静默外发，而是点名候选并给出两条启用路径：

```
未配置 agent.visionModel；检测到可用视觉模型 minimax/MiniMax-M3，在 /config → 识图模型 选定它，
或设 agent.visionAutoBridge=true 让它自动选（会把图片发给该 provider）
```

点名走的是新抽出的 `visionCandidates()`：只看模型声明，不试凭据、不建 client——「想说出候选的名字」不该付一次构造代价。

## 二、多模态主控不再白建桥

`createAgentConfig` 无条件调 `buildVisionClient`，而运行期三个消费点（`loop.ts:2089`、`tool-execution.ts` 的 if/else-if、`loop-factory` 的 `visionAsk`）都要求 `!supportsVision`。于是主控本身能看图时，桥 client 被建出来却永不使用，还会在每次启动打一行不实的「已启用识图桥」。现在 `primarySupportsVision` 时直接跳过构建，状态如实显示「主模型原生支持识图，无需桥接」。

## 三、`ask_image` 现在真的能问 agent 自己截的图

工具描述写的是「就本会话中已发送的图片提问」，而寄存只发生在 `loop.ts:2082`——那条路径只处理**用户附图**。`browser_debug` / `computer_use` 的截图走 `tool-execution.ts` 的描述通道，从不进 `ImageRegistry`。结果：agent 截完图追问细节，拿到的是「本会话没有可查询的图片」。

这正好断在浏览器验证闭环最需要的一步上：截图 → 「逐字念出红色报错那一行」。修法是给 `ToolExecutionDeps` 加 `registerImages`，在两条分支（多模态直传 / 桥接描述）都寄存实际转发的那 ≤2 张，并把分配到的 id 写进 system-reminder，模型才知道能追问哪一张：

```
Retained as img_3, img_4 — use ask_image with that id to re-interrogate a specific detail.
```

worker（无 registry）不传这个 dep，行为退回原样：照旧描述，只是不可追问。

## 四、两个小毛病

- `ImageRegistry.register()` 返回的 id 可能在同一轮就被字节预算驱逐（单图超 `maxBytes` 时），调用方拿到一个查不到的引用——提示里写着 `img_9`、`ask_image` 却说没有这张图，是最难查的那种不一致。现在只返回存活的 id。
- `mostRecent()` 的 `img.id > best.id` tie-break 在 clock 单调递增下永不触发，真触发了也是错的（`img_9 > img_10` 字符串比较）。删掉。

## 配置与 UI

| 面 | 位置 |
|----|------|
| 配置 | `agent.visionAutoBridge`（默认 false）；`agent.visionModel.fallback` 主备双桥（同步进来的，本轮补文档） |
| TUI | `/config` → 识图模型 → 「未配置时自动选桥」；setter `setVisionAutoBridge`，自成一个脏块 |
| 文档 | `docs/user-guide-vision.md` 补 `ask_image` / 双桥 / 自动选桥 / prompt 自动分档 / `rivet browser`；README 两语种同步；`AGENTS.md` 档位计数订正 27/28/47 → 29/30/48（`ask_image` 使三档各 +1） |

## 验证

- 受影响范围 116 例全过（`image-registry` 10 / `tool-execution-vision` 15 / `vision-service` / `create-agent-config` 17 / `ask-image` / 三组 settings / `manager-provider`）。
- 新增 11 例：不 opt-in 不建桥且点名候选、opt-in 后建桥、无候选时的措辞、多模态主控完全跳过、两条分支都寄存截图并点名 id、只寄存真正转发的那几张（尊重 2 张上限）、无 registry 时降级、驱逐后的 id 不外泄、单图爆预算返回空。
- `npx tsc --noEmit` 干净。

## 遗留

1. **`GET /sessions/:id/vision-bridge` 仍无消费方**：桌面端零引用（`rg vision-bridge desktop/src` 为空）。加它的动机是让桌面端显示准确的桥状态，那一半没做——桌面端目前仍只能凭 config 有没有 `visionModel` 键去猜。
2. **`ask_image` 的定向问答不带随图文本**：`visionAsk` 直接把 question 当 prompt，不走 `selectVisionPrompt` 的 OCR/通用分档。问「逐字念出报错」时靠的是用户问法本身够具体，没有模式兜底。
3. **`feb50615` 是半成品提交**：漏了 6 个文件（`ask_image` 的全部接线在 `6bd29a19` 才补齐），能编译但功能是死的。bisect 落在这条上会得到假阴性。
4. **测试计数在高负载下会少报**：`--test-force-exit` 下同一文件同一命令，`tests` 有时 10 有时 6/7/8，exit 仍为 0（load avg 12–15 时复现，node v24.1.0）。14 次带故意失败用例的试验里失败**都**被执行并如实 exit 1，所以目前看是汇总行少报而非漏跑失败——但读「N 例全过」时要知道 N 本身在高负载下不可靠。
