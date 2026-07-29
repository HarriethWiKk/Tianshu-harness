# 遥测探针

离线读会话遥测、回答「某个机制在真实数据上到底成不成立」的一类脚本。与 `scripts/` 下
一次性验证脚本的区别：**这些是要反复跑的**，因此共享语料读取层、共享口径纪律、有单测。

## 为什么单独一层

第二轮指标监测期间，会话日志解析逻辑被重写了六遍，每次细节都有差异（完整性后缀怎么剥、
fixture 目录算不算语料、空数组分位数返回 0 还是 null）。更贵的是口径事故：第一轮按聚合
均值直接改传感器，导致 pressure 过冲、73.5% 样本钉死在 0.50。事故复盘见
[`docs/analysis/2026-07-28-阈值与分布脱钩.md`](../../docs/analysis/2026-07-28-阈值与分布脱钩.md)。

所以这层的职责不只是「少写点重复代码」，而是**把踩过的坑固化成默认行为**。

## 探针清单

| 探针 | 回答什么 | 入口 |
|------|----------|------|
| `threshold-coverage.ts` | 六维阈值判据在真实数据上分不分得开；哪些是死分支 / 恒真 / 假阶梯 | `npm run probe:thresholds` |

`scripts/hexagram-divergence-probe.ts` 是同类前作，早于本目录，仍留在原处（有文档引用其路径）。
新探针一律进本目录。

## 用法

```bash
npm run probe:thresholds                     # 当前项目会话目录
npm run probe:thresholds -- --since-days=2   # 只取最近 N 天
npm run probe:thresholds -- --json           # 机读
npm run probe:thresholds -- --strict         # 有死/恒真分支时 exit 1
npm run probe:thresholds -- <sessions-dir>   # 指定语料

npm run probe:test        # 探针单测（等价于 npm test scripts/telemetry-probes）
npm run probe:typecheck   # 探针类型检查
```

`sensorium.jsonl` 需 `RIVET_DEBUG_TELEMETRY=1` 才落盘；没有遥测数据时探针 exit 2 并说明原因。

> **门禁状态**：`npm test` 已收 `scripts/**/*.test.ts`，探针测试进主门禁。但
> `npm run typecheck` 仍只 include `src`（`scripts/` 有 68 个既有类型错误，另案），
> 故类型检查另走 `probe:typecheck`——改探针后记得跑。

## 共享层

`lib/session-telemetry.ts` —— 语料入口。新探针不要自己解析 jsonl。

- `parseTelemetryLine(line)` 剥掉 `…|<16 位 hex>` 完整性后缀后解析
- `listTelemetryFiles(root, opts)` 定位遥测文件，兼容单 slug 目录与 sessions 根目录
- `readVitalsLite(root, opts)` 读六维帧；六维缺任一项的帧**丢弃而非补默认值**
- `parseProbeArgs()` 通用 CLI：`[<sessions-dir>] [--since-days=N] [--json]`
- `quantile` / `mean` / `valueHistogram` / `pct` 统计。`quantile` 空数组返回 `null` 不返回 `0`

`lib/thresholds.ts` —— 阈值判据的发现与评估，纯逻辑。

- `discoverPredicates(srcRoot, repoRoot)` 从源码**自动发现**判据
- `evaluatePredicates` / `detectCollapsedLadders` / `verdictOf`

## 语料纪律（照抄，别重新发明）

`listTelemetryFiles` 已内建，跨语料手写扫描时同样适用：

- **只取主会话**。`worker-` 前缀的子会话有自己的认知轨迹，混入会污染主控口径。
- **排除 fixture 与跑分**。`tmp-*` / `repo-*` 是 cwd 为 `/tmp`、`/repo` 的单元测试残留，
  `*_task<N>_<model>-*` 是 benchmark。都不是真实使用轨迹。见 `isFixtureSlug()`。

## 口径纪律（比代码更重要）

这几条是事故换来的，写新探针前先读：

1. **不要用聚合均值校准阈值。** 消费侧看的是取值集合，不是均值。均值 0.85 的维度可能只有
   5 种取值、83% 落在 1.00 —— 任何设在 0.6/0.7/0.8 的阈值都是同一个判据。探针必须同时
   报取值数与最高频值占比。
2. **单项发火率是所在分支的上界。** 真实分支多为合取（`measured && dim > x`）。上界为 0
   可断定整条分支死；反之单项恒真**不**等于分支恒真。
3. **结论是对语料成立，不是对代码成立。** 换项目、换使用强度可能翻转。改阈值前先确认语料
   代表目标场景，并在报告里写清语料规模与时间窗。
4. **假阳性比漏报更贵。** 六维之外同名字段极多（`claim.confidence` / `route.confidence` /
   测试失败分类置信度 / 记忆条目置信度）。拿六维分布去评判非六维判据，正是这条工作线要防的
   错误。故接收者走白名单，且**所有排除项与盲点都要打印出来供审计**，不静默丢弃。
5. **判据不硬编码。** 硬编码的判据表会随重构漂移，探针就从测量仪变成谎报器。

## 加新探针

1. 放本目录，命名 `<被测机制>-<问题>.ts`。
2. 语料一律走 `lib/session-telemetry.ts`，不自己读 jsonl。
3. 顶部注释写清：回答什么问题、数据前提、**口径声明**（尤其结论的适用边界）。
4. 纯逻辑抽进 `lib/`，在 `__tests__/` 补测试 —— 探针谎报的代价是照它改代码。
5. 支持 `--json`，机读输出便于串进别的分析。
6. 新增 npm 入口 `probe:<name>`。
