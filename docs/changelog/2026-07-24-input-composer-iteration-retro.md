# 输入框迭代复盘（2026-07-24）——Mission Composer 全线重构

> 范围：桌面端滚动/光标根修 + TUI 输入框十一轮迭代（IME 锚定 → 编辑韧性 → 帧节流 → ghost text → parking 重开 → 高三项 → 选区轮 → Contract 预览 → vim visual）。
> 用户视角版本说明见 [`docs/releases/v2.22.0.md`](../releases/v2.22.0.md)。本文是工程侧复盘：根因分布、方法论、遗留风险。

## 一、时间线与根因分布

| 轮次 | 提交 | 症状 | 真正根因（层） |
|---|---|---|---|
| 桌面滚动根修 | 54aa31ce | 拉不到底部/回弹（修过 10+ 次） | **布局层**：composer 高度变化静默顶开跟底；残余 measure() 塌缩；回底 reconcile |
| 桌面光标 | 2e9635a8 | 指针乱跳/中文错位 | **状态层**：草稿 store 回声回拨；受控值被正则中途剥离 |
| TUI IME 锚定 | 7a8f314b | 组词串跳到框外 | **协议层**：硬件光标停在帧尾，IME 候选窗锚错位置 |
| P1 编辑韧性 | db42a552+6a4a50de | 无 undo/草稿丢失/粘贴注入/半序列卡死 | **语义层**：编辑操作无单元模型；输入解析无超时 |
| P2 帧节流 | 11a333bb | 高频 delta 每事件圈一帧 | **调度层**：只有 microtask 合并无帧率上限 |
| P3 ghost text | 38024774 | 命令参数靠记忆 | 数据层无 argsHint schema |
| parking 重开 | 5a405169 | 重复行（dc572683 曾整体关闭 parking） | **协议层竞态**：CPR 探针 rowsUp 漂移误判污染 |
| 高三项 | 096cf2dd | 无 Redo/长粘贴淹没/@补全静默失效 | **语义断链**：补全裸 `@path` 提交后不被解析 |
| 第五轮 | 5c6023db | 无选区/无高亮/搜索弱 | 选区模型缺失 |
| Contract 预览 | cd8d5ca1 | 结构化提交无确认 | 无 MissionDraft → UI 通路 |
| vim visual | 82446bf7 | vim 无选区操作 | 模式机两态不够 |

**分布教训（与前史互证）**：同一症状在同一层反复修而不好，根因大概率在另一层——桌面滚动在虚拟器/意图层修 5 次，根子在布局；IME parking 被误判为"机制本身有害"而整体关闭，根子在 CPR 竞态。**回滚兜底不是修复，定性到机制才算完。**

## 二、方法论沉淀（下一轮可直接复用的套路）

1. **先取证后动手**：滚动类问题三遍修不好就停止打补丁——取证探针（`rivetScrollDebug` 环形缓冲）、无头 Chrome 布局复算 harness（修复前后各跑一次对照数据）、修史回溯（`git log --follow` 看同一文件的补丁层分布）。一次实验顶十轮推演。
2. **纯函数 + 测试钉**：凡判别逻辑抽纯函数（scroll-clamp、shouldMirrorStoreDraft、splitMentions、scoreHistoryEntries、slashArgsHint、parseMissionDraft、shouldPreviewContract），node:test 直接钉；React/引擎侧只留薄接线。
3. **文本不变量防回潮**：布局铁律写成源码文本断言（chrome 不进滚动容器、禁全量 measure()、回底禁末项 scrollToIndex、startup 首帧内容区禁 cursorUp）——比行为测试更早拦回潮。
4. **性能纪律**：每帧成本显式记账（16ms 帧节流、诊断 stat 按值缓存、undo 快照 200 万字符总量上限、粘贴折叠正则只在 grapheme 缓存重建时跑）。新特性评审先问"每帧多花什么"。
5. **外部设计文档先对照再落地**：外部模型的 Mission Composer 文档 P0 清单 80% 已存在——先出"已落地/真实缺口/出入点"对照表再排期，避免重复建设和架构照抄（EditorDocument/Rope 明确不做）。
6. **多会话共享工作区纪律**：工作树改动会被其他会话打包提交（db42a552）、机制会被其他会话回滚兜底（dc572683）——关键机制修复后**立即补防回归测试**，并在交付报告中写清层间因果，方便兄弟会话不误判。

## 三、新增防回归资产

- 测试增量 40+ 例：TUI `src/tui` 1170→1234、engine `src/tui/engine` 332→339、desktop 436→443。
- harness/探针：`desktop/scripts/scroll-harness.html`（无头 Chrome 布局复算）、`rivetScrollDebug` 事件表扩充（intent-set/clear、scrolledup-flip、clientheight-change、follow-snap、sweep-adjust）。
- 归档文档：`docs/known-issues/2026-07-23-desktop-scroll-follow-clientheight.md`、`2026-07-23-tui-ime-hardware-cursor-anchor.md`。

## 四、遗留风险与后续候选

- **需人工真机回归**：中文 IME 组词串锚定（macOS/Windows 各一次）、P2 节流后长流式体感、vim visual 操作流畅度——单测与 MockTerminal 覆盖协议层，真实终端渲染只能人肉过一遍。
- **vim v2 候选**：行数前缀（3w/d2w）、normal 全操作符（dw/cw/yy）、文本对象（iw/aw）、命名寄存器。
- **Mission Contract v2 候选**：Contract 落库/持久化、criteria → /goal 联动（当前仅提示）、风险与权限联动。
- **@ 语义残留**：历史会话里存量裸 `@path` 不做迁移（只保证新输入规范形）。
- **fence parity 近似**：视口截断时被裁段内 fence 不计（纯视觉，明示不修）。
