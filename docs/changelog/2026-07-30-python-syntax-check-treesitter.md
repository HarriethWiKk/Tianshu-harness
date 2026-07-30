# 2026-07-30 Python 语法校验改用进程内 tree-sitter

## 背景

其他用户反馈:Windows 中文环境写含孤立 surrogate（`\udc80`,GBK→UTF-8 残留）
的 `.py` 文件时,校验器把 Python 的 `UnicodeEncodeError` 误判为语法错误 → 回滚
写入 + "请修复内容后重试"（用户无从修,代码本身没错）。

当天先打了两层补丁修症状（`isPythonInfraFailure` 甄别编码失败 degrade +
`replaceLoneSurrogates` 校验前净化）。但那个 bug 是 `checkPythonSyntax` 走
「spawn 系统 python 子进程 + `ast.parse(sys.stdin.read())`」这个设计的**必然
产物**——这条路有三个结构性弱点:

1. **跨进程编码**:content 经 stdin 序列化再由 python 解码 → surrogate/编码类崩溃
2. **依赖系统 python**:用户机器没装 `py`/`python`/`python3` → 校验静默失效
3. **进程启动开销**:每次 fork python 解释器,冷启动几十~上百 ms（Windows+AV 更慢）

## 变更

Python 语法校验从子进程改为**进程内 web-tree-sitter（WASM）**:
- `checkPythonSyntaxTreeSitter(content)`:惰性加载 `web-tree-sitter` +
  `tree-sitter-wasms/out/tree-sitter-python.wasm`（模块级缓存,复用 meridian-parser
  的成熟加载模式,但不耦合索引器）→ `parser.parse(content)` → 查 `rootNode.hasError`
  → 遍历取首个 ERROR/MISSING 节点的行号
- 全程 try/catch:加载失败 / 解析异常 / 超时 → degrade（返回 OK,绝不误判 fatal）
- 删除 `checkPythonSyntax`（三候选轮询 / stdin 写入 / 超时 kill）、
  `isPythonInfraFailure`、`replaceLoneSurrogates`（补丁——底层问题消失,补丁不再需要）
- env `RIVET_PY_SYNTAX_TIMEOUT` → `RIVET_TS_PARSE_TIMEOUT`

`web-tree-sitter` + `tree-sitter-wasms` 项目已装（meridian 生产在用）且在 tsup
external 白名单,无新增依赖,打包已验证。

## 收益

- **消除整类 bug**:surrogate/编码/系统 python 缺失全部消失（不再跨进程）
- **更快**:进程内解析 ~毫秒级,省 fork python 开销
- **更准位置**:错误信息带行号（`⚠️ Python 语法错误（第 N 行）：...`）,子进程版只有一句 traceback

## 诚实的权衡（已知判定差异）

tree-sitter 是容错解析器,对"什么算语法错误"的判定与 CPython `ast.parse`
**不完全一致**。实测两处 tree-sitter 比 CPython 宽松（漏报）:
- **缩进错误**（如 `def foo():\n    return 1\n  bad\n`）:ast.parse 报
  IndentationError,tree-sitter `hasError=false`
- **空 body**（如 `class A:` 无内容）:ast.parse 报 SyntaxError,tree-sitter 放过

括号/引号未闭合、意外符号等**结构性错误仍正常检出并回滚**。对"AI 写完文件做
即时结构校验"这个用途,漏报优于误报回滚（ast-edit 已用同样的 `kind:ERROR` 判据）。
测试记录差异而非强行对齐:syntax-check.test.ts 有专门用例锁定"缩进错误在
tree-sitter 下不判 fatal"。三个写工具回滚测试的输入从缩进错误改为未闭合括号
（tree-sitter 能检出),测试意图（验证回滚机制）不变。

## 归因纪律

这是"消除 bug 温床"而非"再打补丁"——上次修症状（编码失败误分类,commit
3809eb0b）,这次拔病根（跨进程本身）。上次的两层补丁随本次一并删除。

## 验证

- typecheck 绿
- `src/tools/__tests__/syntax-check.test.ts` 31 全过（含 surrogate 不误判 /
  错误带行号 / 缩进宽松差异 / 超时 degrade）
- 写工具回归 write-file/hash-edit/edit 77 全过（含三个"真语法错误仍回滚"）
- 端到端:含 `\udc80` 合法 py → 不回滚;`def foo(` → 仍检出;合法 py → OK
