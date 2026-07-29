# 识图能力用户手册（视觉通道）

> 天枢什么时候能真的「看见」图片、看不见时会怎样、桌面端与 TUI 分别怎么配。

---

## 三种状态

图片能不能进模型，取决于**主控模型**的能力和有没有配识图桥：

| 状态 | 条件 | 行为 |
|------|------|------|
| **直接看图** | 主控模型声明 `supportsVision` | 图片作为多模态消息追加到对话尾部，模型直接看 |
| **桥接描述** | 主控不支持 **+** 配了 `agent.visionModel` | 图片先发给识图模型换成文字，只有描述进主对话 |
| **丢弃** | 两者都没有 | 图片不发送 |

第三种状态是**会明说的**：TUI 在消息气泡下方给出警告，截图工具的结果文字里也会写明"非视觉模型该附件会被自动丢弃，改用 `observe` / `extract` / `eval` 读 DOM"。早期版本静默丢弃，模型会凭"我截了图"断言渲染正常——截图是验证手段，能让模型声称验证过它没看见的东西，比没有这个工具更糟。

## 哪些内置模型能直接看图

| Provider | 模型 |
|----------|------|
| `glm` | `glm-5.2` |
| `minimax` | `MiniMax-M3` |
| `siliconflow` | `zai-org/GLM-5.2` |
| `codex` | `gpt-5.5` |
| `ccswitch` | `glm-5.2`（别名 `cc-glm`） |

**默认的 `deepseek-v4-pro` 不支持识图。** 用 DeepSeek 当主控又要看图，就得配识图桥。

自定义 provider / 自己加的模型必须在那条 model 上手写 `"supportsVision": true`，否则天枢按纯文本模型对待。这个字段是**按模型**声明的，不是按 provider——同一个 provider 下文本模型和多模态模型混编是常态。

## 配识图桥

```jsonc
{
  "agent": {
    "visionModel": {
      "provider": "minimax",
      "model": "MiniMax-M3",
      "prompt": "请详细描述这张图片…",  // 可选，描述提示词
      "maxTokens": 1024                 // 可选，描述的输出上限
    }
  }
}
```

两个前提：该 provider 已配好 key，且目标模型声明了 `supportsVision`。

### 桌面端

**Settings → 集成 → 识图模型**。Provider / 模型下拉只列**已配置且声明支持图片输入**的组合，留空即关闭桥接。

### TUI

`/config` 打开设置面板 → 左栏选**识图模型** → `Enter` 选模型 → `S` 保存。候选同桌面端：只列**已配置且声明 `supportsVision`** 的 provider/模型组合，选第一项「（关闭）」即关掉桥接；`prompt` 与 `maxTokens` 也在同一分类里改。面板写的是用户级 `~/.rivet/config.json`，**下次会话生效**（会话模型在首个请求前就钉住了，中途换会碎前缀缓存）。

`/settings`、`/setup` 是同一面板的别名。

### 手改配置文件

`~/.rivet/config.json`（全局）或项目根的 `.rivet-config.json`（只作用于本项目，优先级更高）。字段名两处相同。注意面板只写用户级——项目级文件里的同名字段优先级更高，会盖掉面板里看到的值。

## 图片从哪来

**用户附图**：TUI 里粘贴图片的**文件路径**（终端只能粘贴文本），或直接 `Ctrl+V` 读系统剪贴板里的图；桌面端用 Composer 的附件按钮。每条消息最多 4 张，单张解码后 1.5MB，超了会按长边 1568px 自动缩。

**agent 自己截的**：`browser_debug screenshot`（`frontend` / `full` preset）和 `computer_use screenshot`（`full` preset）。单张 PNG 超 3.5MB 不附图，只留文字说明——这时缩小视口重截，或用 `eval` 量 DOM。

每轮工具批次最多带**最近 2 张**截图进上下文：一批里连拍多张时，不让百万像素的 base64 灌满窗口。

## 成本与缓存

图片走对话**尾部追加**，不重写历史，所以不打断前缀缓存。

token 按分辨率估算（OpenAI 分块规则，实现在 `src/context/image-tokens.ts`），别按"每张固定"心算：

| 尺寸 | 估算 token |
|------|-----------|
| 1024×1024 | 765 |
| 1280×800（默认视口） | 1105 |
| 1280×4000（整页长图） | 1445 |

桥接路径下主历史里只留一份文字描述，识图模型自身的调用成本单独记在侧路（会话目录的 `cache-log.jsonl`）。

## 排查

桥配了却不生效时，先看 sidecar / 终端日志里的这一行，它会点名原因：

```
[vision] 识图桥未启用：<原因>（图片仍会被丢弃）
```

常见原因与对策：

| 原因 | 对策 |
|------|------|
| provider 不在已配置列表里 | 先 `rivet config setup <provider>` 或在桌面端 Settings → Providers 里加 |
| 模型不在该 provider 的 `models` 里 | 补一条 model，或换成上表里的模型 |
| 该模型没声明 `supportsVision` | 自定义模型手写 `"supportsVision": true` |
| **没有可用的 key** | 最常见：key 只存在环境变量里，而 GUI / Dock 启动的桌面端没继承到 shell profile。把 key 写进配置，或从终端启动。（`config.env` 那套只作用于命令执行，不改进程自身环境） |

**如果某个内置模型的 `supportsVision` 看起来"丢了"**：旧版本在 UI 里编辑上下文窗口会连带抹掉这个字段。2026-07-29 起写入改为逐字段合并，且加载时会按预设补回缺失的 `supportsVision` / `tier` / `pricing`，不需要手动修配置文件。详见 [`docs/changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md`](changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md)。

## 相关文档

- [Provider 配置用户手册](user-guide-provider-config.md)
- [前端视觉验证闭环](changelog/2026-07-26-frontend-visual-verification-loop.md)（`browser_debug` 的截图 → 验证链路）
