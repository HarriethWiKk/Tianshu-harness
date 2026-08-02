# 2026-07-30 安全告警层1 补漏 + tree-sitter 内存释放

对当天两个提交（`b13c4f2` 层1 正则告警、`4a86818` Python 校验 tree-sitter 化）
做评审跟进。层1 原提交没有 changelog，本文一并补记。

## 一、tree-sitter 解析树未释放（真 bug）

`checkPythonSyntaxTreeSitter` 解析完不调用 `tree.delete()`。`Tree` 活在 WASM
线性内存里，**不受 JS GC 管理**——每写一个 `.py` 文件就泄漏一棵语法树。

同仓库的 `meridian-parser.ts` 三个 parse 函数每一个都在遍历后 `tree.delete()`，
并有 `MAX_PARSES_BEFORE_RESET = 250` 周期性重建 parser（parser 自身的 scratch
内存也会单调增长）。原提交的 commit message 把 250-parse reset 当作"索引器的
重量级负担"排除，但顺带漏掉了 `delete()`。

改动：`tree` 在 `finally` 里 delete（错误路径也走到），并照抄 250 次重建节律。
测试锁定重建节律 + 重建后解析结果仍正确。

## 二、安全告警层1 的四处补漏

### apply_patch 完全不被扫描

hook 只接 `extractWriteContents`，而那个集合刻意不含 `apply_patch`。对探针检测
漏一个工具只是少提醒一次，对安全扫描是"换个写工具就绕过全部规则"——而
`edit-failure-recovery` 恰好会引导模型改用 `apply_patch`。

新增 `extractPatchContents(diff)`（`write-tool-helpers.ts`）：解析 unified diff，
按 `+++ ` 头分组收集新增行。只取新增行——context 行是文件原有内容，与 `edit_file`
只扫 `new_string` 同口径。纯函数，diff 文本已在 input 里，不读盘。
`check_only` 不扫（只校验不落盘）。

顺带修一个同族的静默失效：`extractWriteFilePaths` 对 apply_patch 按
`input.path ?? input.file` 取路径，而真实 schema 是 `{ diff, check_only }`——
恒返回空数组，所有消费方（dead-end-detector 等）对 apply_patch 的文件级追踪
一直是瞎的。改为解析 diff 头。旧行为有测试锁定，那个测试锁的是错的，已更新。

两处 `+++ ` 解析（这里与 `apply-patch.ts::extractPatchTargetPaths`）刻意各自
实现——hook 层不宜拖进 apply-patch 的 git/syntax-check 依赖链。加了一致性测试
防路径归一规则分叉。

### 写失败也告警

`run` 不检查 `tool.success`：写失败（权限、edit 未匹配）或被 syntax-check 判
fatal 回滚的内容，都会收到告警——对磁盘上并不存在的代码报安全问题。仓库多数
postTool hook（dead-end-detector / physarum / stigmergy / error-diagnosis）都判
`tool.success`。已补。

### 同一条长文案跨轮反复注入

AdvisoryBus 的 key 去重**只在同轮渲染时生效**，跨轮抑制要靠 `KEY_COOLDOWN_TURNS`，
而 `security-pattern` 没注册在里面。反复编辑同一个含 `eval(` 的文件，每轮都重发
同一份几百字 reminder（对比 probe-tracking 那条只有一行，成本量级不同）。

tracker 里本来就记着"这个文件的这条规则告警过了"，却没用于抑制。现在按
`(文件, 规则)` 粒度去重：全会话首次命中才注入，已提醒的规则仍留在 tracker 里
供交付前复扫。这同时让 tracker 不再是纯死代码（层3 按设计走 fs 复扫，本来不会
用到它）。

顺带：`priority` 从 0.55 提到 0.62——0.55 与 `discipline-reanchor` 完全相同且
同属 `discipline` category，要抢 `MAX_PER_CATEGORY` 预算；补 `expect:
{ kind: 'file_touched' }` 核销谓词，否则该条只计送达、不进采纳率统计。

### 默认关，而且桌面端开不了

`=== '1'` 在 `create-runtime-hooks.ts` 里是独一份的方向——其余十八个 advisory
hook 全是 `!== '0'`（默认开、可关）。设计存档里"安全审查门默认 off"针对的是
**花钱的 LLM 审查**（层2/3），层1 是纯正则零 API 调用，与默认开着的
probe-tracking / git-clear-guard / dead-end-detector 同一性质。默认关意味着它对
几乎所有用户等于不存在。

改为默认开。关闭走两条通道（`src/config/security-guidance-config.ts`）：
`RIVET_SECURITY_GUIDANCE=0` 或 config `agent.securityGuidance=false`。config
通道是桌面端唯一可行的路——GUI 启动的 sidecar 继承不到 shell 环境变量（与 vision
key "配了不生效"是同构问题）。接线沿用 `songlineEnabled` 的现成链路：
schema → create-agent-config → loop-types → loop-factory → hook deps。

## 三、补两类规则：SQL 注入、硬编码密钥（26/27）

官方规则表没有这两条（官方靠 LLM 审查层抓），但它们最常见、形状足够固定，纯正则
可靠命中，没必要等有成本的层2。硬编码密钥尤其对着仓库安全闸门最关心的东西。

两处误报边界是被测试逼出来的，值得记：

- **`%s` 不能当危险信号**——它正是 Python DB-API 的参数化占位符，
  `execute("… %s", (uid,))` 是正确写法。危险的是字符串结束后的 `%` 运算
  （`"… %s" % uid`），所以匹配引号后紧跟的 `%`。
- **要求成对的 SQL 语法**（`SELECT…FROM` / `UPDATE…SET`），不认裸动词——裸
  `UPDATE` + `{` 会把 `store.update({ name })` 这类调用全部误报。

已知漏报：跨行 SQL（模板字符串换行后才插值）。主体正则不跨行，跨行会把误报面
放大到整段代码。与本模块整体取向一致：漏报优于误报。

硬编码密钥只认「密钥类字段名 = 长字面量」和可辨识 token 前缀（`sk-`/`ghp_`/
`AKIA`/`AIza`/`xox?-`），显式排除占位符（`xxx`/`your-`/`changeme`/`${}`/env 读取）
——误报会让这条规则被无视，那比漏报更糟。

## 四、附带发现（未修，需单独决策）

`--test-force-exit` 会让含异步顶层 `test()` 的测试文件**被随机截断，且仍报 pass、
退出码 0**。而 `scripts/test-runner-flags.ts::nodeTestFlags` 给所有批次都带了这个
参数，也就是说 `npm test` 的绿不代表跑全了。

实测（同一文件、同一 commit，只差这个参数）：

| 文件 | 应有 | 带 `--test-force-exit` | 不带 |
|------|------|------------------------|------|
| `agent/__tests__/recovery-trigger.test.ts` | 38 | 19 / 2 / 9 | 38 / 38 |
| `agent/__tests__/security-patterns.test.ts` | 49 | 1 / 2 / 26 / 48 | 49 / 49 |
| `tools/computer-use/__tests__/tool.test.ts` | 56 | 52 / 56 / 56 | 56 / 56 |
| `api/__tests__/cost-model.test.ts`（7 个，同步） | 7 | 7 / 7 / 7 | 7 / 7 |

`describe()` 包裹的文件不受影响（suite 一次性注册完）；受影响的是顶层裸 `test()`
且测试内有 await 的文件——仓库里这类文件不少（`session-manager` 75 个、
`session-routes` 70 个都是这个写法）。

这条不能简单删 `--test-force-exit`：它是防僵留进程护栏的一半（另一半
`--test-timeout` 才是真正能救中途挂死的，`test-runner-flags.ts` 的注释自己写明了
这点）。修法需要单独评估——要么把受影响文件改成 describe 包裹，要么在 runner
层换别的收尾方式，且应该有门禁防止回退。本轮验证因此改用「带 `--test-timeout`、
不带 `--test-force-exit`」以取得可信结果。

补一条实测证据，说明「删掉它」的代价是确定性的、不是理论风险：
`tools/__tests__/edit.test.ts` 不带 `--test-force-exit` 时，31 个测试全部报 `ok`
（套件级 `ok 1 - edit_file tool`，零 `not ok`）之后**进程不退出**——三次复跑全部
被外部 timeout 杀掉（退出码 124），单测超时从未触发，即测试早已跑完。缩到单个
`--test-name-pattern="replaces a unique string"`（只编辑 .txt）仍然 3/3 挂死，而只跑
那条 Python 用例反而干净退出 0，所以泄漏源不在 tree-sitter 一侧；`withTimeout` 有
正确的 `clearTimeout`，`syntax-check` 的 `npx tsc` 子进程在挂死期间也查不到，具体
句柄未定位。`hash-edit.test.ts` 同样表现。

归因已排除本次改动：在 `df460a75~1` 的干净 worktree（软链主仓 node_modules）跑同一
文件，同样退出码 124。也就是说这个挂死先于本次提交存在，`--test-force-exit` 一直在
掩盖它——这既解释了那个参数为何会被加上，也意味着换收尾方式前得先修掉泄漏本身，
否则 `npm test` 会直接挂住。

## 验证

- typecheck 绿
- security-patterns 49 / security-pattern-hook 16 / write-tool-helpers 15 /
  syntax-check 32 / create-runtime-hooks（含 gate 四例）/ 写工具回归 77 全过
- 均以 `--test-timeout` 且不带 `--test-force-exit` 运行（见上条）
