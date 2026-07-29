---
title: 2026-07-29 视觉通道诚实性修复 + 测试入口挂死护栏补齐
type: changelog
status: done
date: 2026-07-29
related:
  - docs/changelog/2026-07-26-frontend-visual-verification-loop.md
---

# 2026-07-29 视觉通道诚实性修复 + 测试入口挂死护栏补齐

> 起点是一个估算失真（图像 token 按张数算），查下去连出四个同族问题：都是**失败不可见**——系统降级了、算错了、翻倍了，但表现和正常一样。附带一条工作流闭环：僵留测试进程的护栏此前只落在一个入口上。

## 一、失真点：图像 token 按张数算

`context/rounds.ts` 与 `compact/micro.ts` 两处各写死 `imageCount * 765`。那个常数不是估的——它正好是 1024×1024 方图在分块规则（长边压进 2048 → 短边压到 768 → 按 512 方格切块 → `85 + 170×块数`）下的精确解，所以"每张 765"等价于"假设每张图都是方图"。

真实截图不是方的：

| 尺寸 | 旧估算 | 实际 | 偏差 |
|------|--------|------|------|
| 1024×1024 | 765 | 765 | 0（常数的来源点） |
| 1280×800（默认视口） | 765 | 1105 | 低估 44% |
| 1280×4000（整页长图） | 765 | 1445 | 低估 89% |
| 短边归一化后的极端长图 | 765 | 1785 | 低估 2.3× |

后果不是"数字不好看"。`micro.ts` 里已经写着同一失效模式的前科：`reasoning_content` 被漏算导致"压缩系统性偏晚"。估少了，压缩就晚，晚到撞窗口才补救。

**修**：新建 `src/context/image-tokens.ts` 单一实现，两处调用点接上。

两个刻意的设计约束，改它前先读：

- **必须 O(1)**。这函数在每次压缩检查里逐消息调用，而 data URL 可达数 MB。只 base64-decode PNG 头 32 个字符读 IHDR，不碰载荷（实测 2 万次 13ms，与图大小无关）。
- **只解 PNG**。截图路径全是 PNG；其他格式各要一套头部扫描（JPEG 跨 EXIF 找 SOF、WebP 三种 chunk 变体），而短边归一化会把大尺寸照片压进 765~1105 区间，本来就贴着退路值（4032×3024 手机照片算出来正好 765）。取不到尺寸就退回 765 —— 与旧行为逐位一致。

## 二、文本模型看不见图，而它不知道自己看不见

三条分支在 `agent/tool-execution.ts:615`：模型自带视觉 → 图进历史；配了 `agent.visionModel` → 走桥；两者都没有 → **静默丢弃**。

排查当时的会话 JSONL（`ms4tgfjucwsnvnmd`）确认走的是第三条：全会话无任何多模态 user 消息。模型"读出的页面内容"来自 `observe` 的 DOM 枚举（23 个元素带 selector 和标签），不是看图——这正是 AI 原语的意义，文本模型不靠眼睛也能操作页面。

问题在于 `browser_debug screenshot` 的结果文字只有"截图于 X → artifact Y"，**不含任何页面信息**。模型收到它无法区分"我看到了页面"和"我拿到一个我看不见的文件名"，于是可能凭截图存在就断言渲染正常。截图是验证手段；一个能让模型声称验证过它其实没看见的东西的工具，比没有这个工具更糟。

**修**：给结果文字补上能力无关的声明（两种情况都讲清，所以不必把 config 穿进工具层）。`read_file` 读图时早就是这个写法，而且时序证明有效——正是那句"非视觉模型该附件会被自动丢弃"把模型从截图拉去了 `observe`。

`computer_use` 无此缺口：它的结果文本始终带无障碍树，图掉了页面结构还在。

## 三、视觉桥的描述被完整复制一遍

`describeImages` 同时从 `onTextDelta` 和 `onContentBlock` 累加。这两个回调携带的是**同一段文本**，不是两半：

- `onTextDelta` —— 流式增量，给 UI。
- `onContentBlock` —— 收流结束时把累积的完整文本再发一次，给持久化（`openai-client.ts:881` 注释写明 agent loop 靠 content block 落库）。

消费方必须取其一。两边都收 = 所有 openai 协议 provider（DeepSeek/GLM/MiniMax/…）上的桥接描述精确翻倍：注入主历史的 token 翻倍，模型读到的还是一段自我重复的文字。

实测 MiniMax-M3 描述一张 1280×800 截图返回 3516 字，其中一半是复本；修后 1476 字。

**为什么活到今天**：既有 4 条测试全部只调 `onTextDelta`，从没模拟真实客户端的双回调契约。已补 6 条覆盖：双回调不重复、只有增量、只有终值块、多个终值块（codex 逐 part）、截断标记只追加一次、thinking 块不被当描述。

## 四、桥配了但用不上时完全沉默

`buildVisionClient`（`agent/create-agent-config.ts`）在四个失败点全部返回同一个 `undefined`：provider 不认、模型不认、OAuth 未登录、key 拿不到。于是"配了但起不来"和"根本没配"表现完全一样——图照样被丢，无从分辨。

**修**：各自点名原因（按 key 去重，避免每次建 agent 刷屏；这函数每会话 + 每次 switchModel 都跑）。特别标注最常见成因：**key 只存在环境变量里，而这个进程没继承到**——GUI/Dock 启动的桌面端读不到 shell profile，且 `config.env` 那套解析（`tools/resolved-env.ts`）只作用于命令执行，不改 `process.env`。

同时不再对"选了个非视觉模型当桥"沉默：不拦（手改配置是用户的权利），但会警告描述结果不可信。

## 五、配置里的 model 字段被写没了（先误判成预设漂移，已闭环）

现象：`~/.rivet/config.json` 里的 `MiniMax-M3` 缺 `supportsVision: true`，而预设里有。后果是桌面端 Settings → Integrations 的视觉模型下拉按 `supportsVision` 过滤，该模型**不出现在列表里**；本轮新加的告警也对它误报"未声明视觉能力"。

第一版归因写的是"配置存的是预设副本，预设演进不回灌"。这条**真实存在**（`deepMerge` 对数组整包替换，磁盘上的旧 models 永远赢过预设），但**不是这次的主因**。真正的指纹在字段清单上：那条记录只剩 `{id, alias, contextWindow, maxTokens}` 四个字段，而这**正好是桌面端 Settings 编辑表单提交的四个**。`setupProvider` 与 `upsertProviderModel` 里都是 `models[i] = model` 整对象替换——所以在 UI 里改一次上下文窗口，就把那个 model 的 `supportsVision` / `tier` / `pricing` 当场抹掉。不是配置太旧，是被写坏的。

三个损失各自静默：图被丢弃（无报错）、`tier` 退化成按模型名猜、成本核算读到零。

**修①（止血，主因）**：`mergeModelUpdate` —— 写入方携带的都是**部分** model（桌面表单四个字段，`rivet config set-model` 只带用户敲的）。字段缺席一律视为"调用方没表达意见"，保留已存值；清字段是 `removeModel` 的活，不该是编辑上下文窗口的副作用。显式值（含 `false`）照常覆盖。

**修②（回灌，兼治那条真实的漂移）**：新增 `src/config/preset-model-backfill.ts`，`loadConfig` 在 `configSchema.parse` 之后按允许清单补**缺席**字段。

选读时修复而非一次性磁盘迁移，因为读时一次修好所有已存在安装、覆盖所有 provider，且以后预设新增字段只要进清单就自动触达老配置；磁盘则在下次 `saveConfig` 顺带自愈（`saveConfig` 的起点就是已修好的 `loadConfig` 结果）。前科可比：`migrateDeepseekMaxTokens` 是同一形状的一次性特例，其注释早已承认 "the preset fix alone doesn't reach existing users"，只是当时只治了一个 provider 的一个字段。

刻意的边界，三条都有测试钉住：

- **只填 `supportsVision` / `tier` / `pricing`**——这三个*描述*模型；其余要么给它命名（`id`/`alias`），要么调请求行为（`reasoningEffort`），静默改动那两类是比"修好能力元数据"大得多的承诺。第一版担心的"照预设覆盖会让 `alias: minimax` 从 M3 悄悄变 M2.7"，现在由这份清单**结构性排除**，不再依赖每次手工小心。
- **不注入预设后来新增的 model**：裁剪过 model 列表是正当选择，补回去是跟用户对着干。
- **按 `id` 匹配预设条目，用户的 `alias` 不参与匹配**：否则一个恰好撞上别的模型名的自定义别名，会把错的模型元数据接过来。

### 打包与首次启动（顺带查清）

不随包分发 config 模板（`tauri.conf.json` 的 resources 只有 runtime/node/shell/playwright/EULA）。预设编译进二进制，`DEFAULT_CONFIG` 用 `cloneProviderPreset` 即时克隆；首次运行没有 `config.json` 时内存里就是最新预设，第一次 connect 或存 key 才落盘成快照。便携版（`<exe>/TianshuData/.rivet`）的 Rust 侧只创建日志目录、注入 `RIVET_HOME`，不拷模板。

**所以全新安装（含便携版）拿到的配置本来就是对的。** 风险只有两条，都不在打包：升级已有安装（旧快照永不回灌）、以及 UI 编辑抹字段。这两条本节都堵了。

### 配置入口（两端不对称，留档）

provider 本身两端同源：TUI 走 `/connect` 或 `rivet config setup <provider>`，桌面端走 Settings → Providers，最终都落到同一个 `setupProvider`、写同一份 `config.json`。但 `agent.visionModel` 当时**只有桌面端有 UI**（Settings → Integrations，下拉按 `supportsVision` 过滤），TUI 侧没有任何命令，只能手改配置文件——TUI 里那句"不支持识图"的提示本身就是叫你去改 `.rivet-config.json`。→ 同日已补 `/config` 设置面板，见「遗留」第 1 条。

## 六、工作流闭环：测试入口的挂死护栏只落在一个入口上

一个 `npm run test:desktop` 进程跑满 **2 天 13 小时**、占 75% CPU，SIGTERM 都不吃。

真正的代价不是烧一个核，而是**污染归因**：被它拖慢的机器上，依赖时间窗的测试成批失败——临时 git 仓变更率（`git-freshness`）、watchdog 定时器（`turn-heartbeat`）、spawn tsc（`theta-check`）、abort 时序（`abort-tool-hang`）。这些失败看起来像当前改动引入的回归。排查走了几小时弯路，最后要用 `git worktree` 开 HEAD 干净副本、只搬入本轮 8 个文件才归对因（工作树里同时有 93 个文件在改，多数属于其他会话）。清掉进程后，同样 4 个文件在同一棵混合树上 **6.1 秒 37 条全过**，此前要 40–80 秒且挂一半。

**成因**：`scripts/run-node-tests.ts` 早先已为同类事故加固过两次（注释在案：`--test-timeout` 挡 Node 默认的 Infinity、信号转发防子进程 reparent 到 init，两次都是"捡到 4 个跑满一天多的僵留进程"），但加固只落在那一个入口。三处直接 `node --test` 完整绕开：

| 入口 | 修前 | 修后 |
|------|------|------|
| `package.json` → `test:desktop` | 裸 `node --test` | 补 `--test-force-exit --test-timeout=120000` |
| `desktop/package.json` → `test` | 裸 `node --test` | 同上 |
| `vscode-extension/package.json` → `test` | 裸 `node --test` | 同上 |

**闭环**（关键——补参数只治这三条，不防下一条）：新增 `scripts/__tests__/test-entry-hardening.test.ts` 扫所有 package.json 的 scripts，凡直接调 `node ... --test` 的必须自带两个参数，且超时值必须等于 `test-runner-flags.ts` 的 `DEFAULT_TEST_TIMEOUT_MS`（package.json 没法 import 常量，用断言把两处钉在一起）。门禁自身经过反证：摘掉任一处参数，3 条断言变红并给出可操作报错。

第一条断言刻意校验"审计到的入口 ≥ 3"——防止选择器写错导致门禁空扫长绿。

## 影响面

- **前缀缓存**：无。图像走 tail-append，估算只影响压缩时机；`browser_debug` 结果文字变长几十字节，是 append-only 尾部。
- **主历史 token**：桥接路径**减半**（翻倍 bug 修掉）。
- **配置**：写入 `agent.visionModel = minimax/MiniMax-M3`（CLI + 桌面端两份，各留 `.bak-vision` 备份）。M3 的 `supportsVision` 当时是手工补的，第五节的回灌已让这步变成多余（保留无害）。
- **既有配置**：所有 preset provider 的 model 在加载时补齐缺席的 `supportsVision`/`tier`/`pricing`，不改用户已设的任何值；下次写配置时磁盘顺带自愈。
- **需重新构建**：`src/` 侧改动（`browser-debug/tool.ts`、`vision-service.ts`、`create-agent-config.ts`）对桌面端生效需重跑构建，且 `npm run build` 后必须补 `node scripts/stage-runtime-deps.js`（build 会清空 dist，漏了这步 `dist/node_modules/playwright-core` 变空壳目录，反而遮蔽仓库里完整的包）。

## 验证

- `tsc --noEmit` 干净。
- 隔离验证（`git worktree` 开 HEAD 干净副本 + 只搬入本轮 8 个文件，排除工作树里其他会话的 85 个文件）：**766 条全过**（`src/context` + `src/compact` + `browser-debug` + vision + config）。
- 新增：`image-tokens` 14 条、`vision-service` 双回调契约 6 条、`test-entry-hardening` 4 条、`preset-model-backfill` 13 条 + `manager-provider` 合并语义 3 条。
- 配置侧回归：`src/config/__tests__` 全量 **190 条全过**；受影响的下游（`monitor-tool`/`plugin-api`/`mcp-hot-add`/`vision-service`）44 条全过。
- 合并语义的隔离验证：断言用**预设里不存在**的自定义 model（`house-model`），否则回灌会在加载时把字段补回来，测试即使没修合并也会绿。
- 真实文件实证：拷一份 `~/.rivet/config.json`、把 M3 的三个字段抠掉，`loadConfig` 读出 `supportsVision: true` + `tier: strong`，而用户调过的 `maxTokens: 131072` 与别名 `minimax` 原样保留。
- 端到端真实请求：MiniMax-M3 10 秒读出目标截图内容（版本号、hotfix 条目、警告框、按钮文案），修前 3516 字含复本 → 修后 1476 字单份。
- 门禁反证：摘掉护栏参数 → 3 条断言红；已还原。

## 遗留

1. ~~**TUI 侧没有配视觉桥的入口**（第五节末）。~~ **已补**（2026-07-29 同日）：`/config` 设置面板（`/settings`、`/setup` 同义），左栏「识图模型」分类给出与桌面端同源的候选（按 `supportsVision` 过滤），同面板还覆盖了子代理路由、审查子代理覆盖卡、工具档位/审批/默认星域/默认模型、镜像·代理·搜索后端。顺带补掉桌面端也没暴露的 `workers.patcherTier` / `workers.escalationCap`，以及桌面路由页漏掉的 `planning` 任务键。实现：`src/tui/settings-{model,flow,persist}.ts` + `src/tui/format/settings.ts`。
2. **视觉桥失效只走 `console.warn`**。桌面端用户看不到 sidecar 日志。桥配了却不生效时，应在 Settings → Integrations 或 `/doctor` 明示。
3. **非 PNG 图像仍退回 765**（第一节的刻意取舍）。若将来 JPEG/WebP 成为主要来源（用户附图路径），再补头部扫描。
4. **全量测试未跑完**。工作树里 85 个文件属于其他会话在飞的工作，全量跑出来的失败大多不归本轮，噪音大于信号。等那些改动落地后再跑才有意义。
5. **`vscode-extension` 的 `node --test` 未带 `--import tsx`**（本轮只补护栏，未动其运行方式）。若它当前依赖 Node 原生 TS 支持，升级 Node 时需复核。

## 反模式清单（这一轮的共同形状）

五个问题一个形状：**失败不可见**。

- 图被丢弃 → 工具结果文字不说，模型以为自己看见了。
- 桥起不来 → 与"没配"返回同一个 `undefined`。
- 描述翻倍 → 内容看着正常，只是多了一份。
- 僵留进程 → 表现为"别的测试挂了"，指向错误的地方。
- 部分更新抹字段 → 编辑上下文窗口成功了，同时丢掉的三个字段无人报告。

写降级路径时的自查：**这条路走通和走不通，观察者能区分吗？** 区分不了的静默降级，早晚会被当成别的东西来排查。

第五条还多一层教训，正好落在同一份文档里：**"能解释现象"不等于"是成因"**。"预设演进不回灌"确实存在、也确实能解释缺字段，于是第一版就此收笔，只手工补了一个字段。真正的成因要看字段清单的形状——剩下的恰好是编辑表单提交的那四个。归因写完后值得再问一句：这个解释能不能同时解释**为什么偏偏是这几个字段没了**？
