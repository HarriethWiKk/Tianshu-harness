---
title: 星河集群（galaxy）天枢设施复用优化落地计划
type: plan
status: draft
date: 2026-07-31
revised: 2026-08-01（锚点核查后修订——更正过时断言、补全实现链、明确缺口；同日二次复核：回改更正②的 session-memory 遗漏与更正③的「第一个接入者」误判）
related:
  - docs/superpowers/specs/2026-07-14-cluster-agent-architecture.md
---

# 星河集群（galaxy）天枢设施复用优化落地计划

> 让 galaxy 从「能跑」到「吃满天枢既有基础设施」：worker 文件预热、前缀缓存亲和、回传设施对齐、冲突策略对齐。每项附量化验收标准。

## 目标

- 同批 worker（尤其 DP 副本）共享文件预热缓存，worker 冷启动读文件开销可量化下降
- 不同 authority 的 worker 共享更多前缀缓存（服务端 prefix cache 命中率提升，用 worker `cache-log.jsonl` 度量）
- galaxy 回传对齐 delegate_batch 标准设施（TUI fleet 面板、核验护栏、缓存指标可见）
- 文件重叠策略从「静默丢弃」改为「串行化或显式报告」

## 非目标

- 不改 worker system prompt 的 subagent 档结构（`subagentPromptBlocks()`）
- 不做跨 worker 信息素共享（当前全仓无消费方，属独立课题）
- 不动 coordinator 的 claims 跨会话互斥逻辑（`src/agent/coordinator.ts:1900-1936`）
- 不引入「提前发建缓存 API 请求」类设施（服务端自动前缀匹配，无需客户端协调）

## 背景与依据（2026-08-01 锚点核查修订）

galaxy(PR #14）经 `delegateBatch` 扇出 worker，骨架复用正确，但设施利用率低于 council/team。
**核查更正①**：原稿称 `batchPrewarm`/`buildPrewarmValue`「全仓无调用方」已过时——prewarm 链路早已完整存在：

| 环节 | 位置 | 现状 |
|---|---|---|
| 缓存实现 | `src/agent/prewarm.ts` | `PrewarmCache`（Map + mtime/size 双校验 + TTL 60s / 上限 50） |
| 预热点 1：用户文本文件意图 | `prewarm-controller.ts:27-36`（`maybePrewarm`，2026-06-16 提取 W-L7b） | 已接 |
| 预热点 2：turn 边界最近读文件 | `prewarm-controller.ts:39-44`（`prewarmRecentReads`）→ `loop-factory.ts:699` | 已接 |
| 预热点 3：grep 命中文件（grep→read 最常见序列） | `tool-pipeline.ts:1851` | 已接，一次最多 5 个 |
| 消费点 | `read-file.ts:846-851`（`consumePrewarm`，mtime 校验跳过 fs 读） | 已接，注入点 `tool-pipeline.ts:766` |
| 写后失效 | `tool-pipeline.ts:1839`（write/edit 后 `prewarm.invalidate`） | 已接 |

**P0-1 的真实增量是「实例级隔离 → 批级共享」，不是首次接线。**

- `PrewarmCache` 按 AgentLoop 实例隔离（`src/agent/loop.ts:201` 字段默认值 `new PrewarmCache(60_000, 50)`）；worker 的 AgentLoop 构造（`src/agent/worker-session.ts:524`）**不传 prewarm** → 每个 worker 独立实例。主会话读热的文件、兄弟 worker 读过的文件对下一个 worker 全冷。
- **共享实例的隐性放大器**：worker 内 grep→read 预热（`tool-pipeline.ts:1851`）在共享 cache 下惠及同批兄弟 worker——副本 1 grep 命中的文件，副本 2..N 首读直接命中，不限于派发前 scope 预热。
- worker frozen 块序（`src/prompt/volatile.ts` 主函数）：`<sober>`→`<locus>`→**`<star-domain>`**→`<project-instructions>`→`<verify-block>`→`<session-memory>`。**核查更正②（2026-08-01 二次复核修正）**：worker 的 volatileCtx 只传 `cwd/sessionMemoryBlock/blockCaps`（`bootstrap.ts:1037`、`headless-coordinator.ts:109`），故 `projectMemory / knowledgeManifest / seedCapsule / codebaseIndex` 对 worker **不渲染**；但 `sessionMemoryBlock` 传了，且 `<session-memory>` 位于 star-domain **之后**（`volatile.ts:1092`）——不同 authority 的 worker 在星域块分叉后，连带损失 = `<project-instructions>`（AGENTS.md/.rivet.md）+ `<verify-block>` + `<session-memory>`，原稿「AGENTS.md + 记忆段」成立。同 profile 同 authority（DP 副本）因同 cwd + 同 authority → star-domain 块字节相同，已天然全共享。
- galaxy 调 `delegateBatch` 只传 3 参（`src/tools/galaxy.ts:572-576`），漏接 `onProgress`/`onWorkerSettled`（`src/agent/coordinator.ts:2440-2447` 签名确认存在）。**核查更正③（2026-08-01 二次复核修正）**：`delegate-task.ts` 未接这两个回调，但 `delegate-batch.ts:313-324` 已接（`onProgress` 批次进度 + `emitTerminal` 经 `onWorkerSettled` 发 per-worker 终态）——galaxy 是**第二个**接入者，「对齐 delegate_batch 标准设施」的表述成立（标准即 delegate-batch 所立）。
- 弃用 `run.packet` 自写报告，丢失 `WORKER_RESULTS_HINT` 待核验护栏（`src/agent/worker-prompts.ts:410`——**核查更正④**：原稿行号 513-631 偏移，实际常量在 410，`buildPrimaryWorkerPacket` 在其后）。
- `enrichResult` 已挂 cache_read/create tokens（`src/agent/coordinator.ts:1146-1164`）但报告不展示。
- 文件重叠处理是静默字符串去重（`galaxy.ts:495-512`），team 模式是同文件串行化（`src/bootstrap.ts:1175-1180` 注释，`groupTeamTasks`）。
- council 有 `tierFloor` 护栏（**核查更正⑤**：实际在 `src/agent/council/council-orchestrator.ts:207-212`——原稿路径少了 `council/` 层）。**核查更正⑥**：`tierFloor` 在 coordinator batch 路径已补传（`coordinator.ts:2503-2522`，含专门测试 `coordinator.test.ts:534`「delegateBatch 透传 tierFloor 到 WorkOrder」）——P2 剩余增量只是 galaxy schema 暴露。
- modelOverride 静默 fallback 不可见（`src/bootstrap.ts:902-905` 仅 debugLog）。

## 技术方案要点

### P0-1 文件预热（核心）

- **在 coordinator 层（而非 galaxy 层）做**：`delegateBatch` 创建批级 `PrewarmCache` 实例，生命周期 = 一次批派发。这样 delegate_batch / team / council / galaxy 全部受益，galaxy 零改动。
- **打通链（原稿只写了「传入 runtimeFactory → tool-pipeline」，漏了中间层）**：
  1. `coordinator.ts` `delegateBatch`：入口创建 `const batchPrewarm = new PrewarmCache(60_000, 50)`；派发前先 `await` 收集预热（见下），再启动并发调度
  2. `coordinator.ts` `delegateOrder`（~1692）：`workerConfig.prewarm = batchPrewarm`——`WorkerRuntimeFactory` 返回类型就是 `WorkerSessionConfig`（`coordinator.ts:245-247`），无需新接口，`WorkerSessionConfig` 加一个可选字段 `prewarm?: PrewarmCache`（缺省 undefined → worker-session 用 AgentLoop 实例默认，向后兼容）
  3. `worker-session.ts:524`：AgentLoop 构造传 `prewarm: config.prewarm`
  4. 消费点 `read-file.ts:846-851` 已就绪，无需改
- **预热时机**：`delegateBatch` 开头统一 `await` 收集预热（所有 order 的 `scope.files` 去重后 batchPrewarm），**再**启动 `processNext` 并发调度——否则并发 worker 1 启动时副本 2 的预热可能还没完成。预热失败静默（`catch(() => {})`），不阻塞派发。
- **batchPrewarm 5 文件硬上限**（`prewarm-file.ts:104` `if (count >= 5) break`）：`count` 是函数局部变量，每次调用独立计数 → **按 5 个/批切分多次调用**即可突破上限（或给 batchPrewarm 加可选 `limit` 参数，二选一，倾向参数化）。
- **symbols 解析缺口（原稿未写实现路径）**：全仓无 symbols→files 解析设施（grep 确认）。**P0 收窄为 files-only 预热**——symbols 由 worker 首读冷读 + 共享 cache 的 grep→read 预热自然覆盖（副本 1 grep 后副本 2 命中）。symbols→files 静态解析列为 P2 候选，不阻塞 P0。
- DP 副本收益最大：副本 1 读过的文件，副本 2..N 直接命中内存。

### P0-2 缓存指标可见（P0-1 的度量手段）

- `formatGalaxyResult` 报告尾部加一行聚合用量：`Σ input / Σ cacheRead / hitRate`（数据源：`WorkerResult.usage`）。**容错**：usage 是 `Partial`（`enrichResult` 的 usage 可能缺 `cache_read_input_tokens`），缺失字段计 0。
- DP group 段落（`dataParallelGroups`）加 **per-replica cacheRead 提示**——副本间 cacheRead 差异是 P0-1 收益的直接度量（副本 1 冷读、副本 2..N 命中的量化证据）。
- 验收 P0-1 的方式：同一 DP 任务跑两遍（预热开/关），对比 worker `cache-log.jsonl` 的 read_file 耗时与首轮 cacheRead。

### P1-1 前缀缓存亲和

- 把 `<star-domain>` 块移到 `<project-instructions>`、`<verify-block>`、`<session-memory>` **之后（frozen 最末）**——不同 authority worker 共享星域块之前的全部前缀（sober/locus/project-instructions/verify-block）。注意这是对**所有** worker 场景的改动，且主会话 frozen 同序受影响（一次性缓存失效，块序稳定后稳态恢复），需跑 prompt 快照测试与缓存回归（`scripts/verify-cache-hit-rate.ts`）。
- **认知影响（locus 要求说明）**：star-domain 从「身份前置区」（sober/locus 之后）移到「记忆末区」——指令权重降低、context 权重升高；块内容不变仅位置变化。风险：模型对星域纪律的遵循可能衰减。缓解：① 块内容（含全星域共享执行纪律行）字节不变；② 合并后先跑一轮 council/galaxy 冒烟观察遵循度；③ 若衰减，回退为「仅 worker 引擎调整块序」（主会话不动）的收窄方案。
- galaxy proposal 文案建议：多 authority 维度对齐 modelOverride 同模型（缓存按模型隔离，`src/bootstrap.ts:977-981` workerRouting 注释确认独立模型 → 独立服务端缓存）。

### P1-2 回传对齐

- galaxy `delegateBatch` 调用补 `onProgress`/`onWorkerSettled`（第 4/5 参）。进度/终态事件走既有 `params.onOutput` 文本流通道（与 `streamActivity` 同通道，galaxy 已接 onWorkerActivity）——TUI 工具卡实时进度 + 终态字形。
- galaxy 报告补「只读发现为待核验假设，交付前需独立确认」护栏文案（对齐 `WORKER_RESULTS_HINT` 语义，`worker-prompts.ts:410`），保留自写报告（`run.packet` 构建成本高且自写报告已含 DP quorum/聚合结论，评估结论：不切换）。
- coordinator 侧 packet 构建若确认无人消费，评估跳过（省一次 32K artifact 落盘）——**此点需先 grep 消费方再动，防止误删主控依赖**。

### P2 策略对齐

- **文件重叠：倾向显式报告，不串行化**。理由：galaxy 的核心价值是并行，同文件串行化（`groupTeamTasks` 语义）会把 galaxy 退化为 team；文件重叠 = 用户维度配置错误（可写维度必须文件范围不重叠，工具 description 已声明）。实现：去重时收集被剥离的 `(维度名, 文件路径)` 清单，报告尾部显式列出 + 提示拆维度。若用户坚持串行化，再做依赖边方案。
- **tierFloor（现状：coordinator 已实现+已测试）**：仅剩 galaxy 侧——`dimensionSchema` 加可选 `tierFloor` 字段（`cheap|balanced|strong`），透传进 `DelegationRequest.tierFloor`（字段已存在，`coordinator.ts:207`）。serve-agent 已透传（`serve-agent.ts:819`），galaxy 对齐即可。
- **modelOverride fallback 报告**：fallback 发生在 bootstrap `runtimeFactory`（`bootstrap.ts:902-905`，仅 debugLog），galaxy 拿不到。实现路径：**检测放 coordinator 而非 bootstrap**——`delegateOrder` 在 runtimeFactory 返回后比较 `workerConfig.promptEngine.getModel()` 与 `order.modelOverride?.model`，不一致即记录 fallback 事实，经 `WorkerResult` 或 `CoordinatorRun` 带出，galaxy 报告标注。bootstrap 内无法回传信息（`WorkerRuntimeFactory` 签名固定返回 `WorkerSessionConfig`）。

### 附带修正

- `AGENTS.md` 引用的 `src/api/request-freezer.ts` 已不存在（职责并入 engine + `src/api/stable-json.ts`），主仓文档更正（不属于本 PR 范围，单独提交）。

## 任务分解

### P0（本 PR 周期内）—— 2026-08-01 完成

- [x] `src/agent/coordinator.ts`：`delegateBatch` 创建批级共享 `PrewarmCache`（侧表 `batchPrewarmByOrder` 按 order.id 键控，防并发批串批）；`delegateOrder` 注入 `workerConfig.prewarm`
- [x] `src/agent/worker-session.ts`：`WorkerSessionConfig` 加 `prewarm?: PrewarmCache`；AgentLoop 构造后 `if (config.prewarm) agent.prewarm = config.prewarm`（缺省保留实例隔离默认值，向后兼容）。写工路径经 `runAgent` 的 `...workerConfig` 展开自动继承
- [x] `src/agent/prewarm-file.ts`：`batchPrewarm` 加可选 `limit` 参数（默认 5）；`coordinator.ts` 派发前按全部 order `scope.files` 去重预热（limit 25，失败静默，不阻塞派发）
- [x] `src/tools/galaxy.ts`：`formatGalaxyResult` 增加聚合用量行（Σinput / ΣcacheRead / 命中率）+ DP per-replica cacheRead 提示
- [x] 测试：coordinator.test.ts 新增「同批 worker 共享 prewarm 实例 + scope.files 已预热」（真实临时文件 + 实例同一性断言）；galaxy.test.ts 新增聚合用量行与 per-replica cacheRead 断言
- [x] 验证：`tsc --noEmit` 通过；相关套件全绿

### P1（紧随 P0，可独立合并）

- [x] `src/prompt/volatile.ts`：star-domain 块序后移至 frozen 末尾 + 受影响快照测试更新（`volatile.test.ts`）
- [ ] 验证：`npm exec -- tsx scripts/verify-cache-hit-rate.ts` 多轮命中率不低于基线（95–99% 稳态）；council/galaxy 冒烟观察星域遵循度
- [x] `galaxy.ts`：`delegateBatch` 接 `onProgress`/`onWorkerSettled`（走 onOutput 文本流 + onWorkerActivity 终态事件，与 delegate-batch 同构）；报告加核验护栏行（对齐 `WORKER_RESULTS_HINT` 语义）
- [x] 评估：`run.packet` 消费方 grep 结论 + coordinator packet 构建跳过与否（结论见「风险与依赖」附录）

### P2（后续迭代）—— 2026-08-01 完成（symbols→files 除外，仍为候选）

- [x] 文件重叠：显式报告被剥离清单（倾向方案落地；串行化放弃——重叠本质是维度划分问题）。收窄：只读维度不参与去重（work-queue 只序列化写侧，只读并行读同一快照安全）
- [x] `tierFloor`：galaxy `dimensionSchema` 加字段 + 透传 `DelegationRequest.tierFloor`（coordinator 已就绪）
- [x] modelOverride fallback：galaxy 报告标注「⚠ 模型回退：请求 X → 实际 Y」（数据源 `CoordinatorRun.workerModels` + WorkerResult.model）
- [x] **冒烟追加发现**：`enrichResult` 采信 worker 自报 usage（模型生成 JSON，不可信——实测副本虚报 514K cacheRead，真实累计 ~103K，聚合命中率被污染）→ 改为实测遥测优先，无实测才回落自报值
- [ ] symbols→files 静态解析（P0 收窄项，列为候选）

## 风险与依赖

- 共享 PrewarmCache 的并发安全 → 现实现为 Map + mtime/size 校验，worker 并发读同 key 最坏是重复读一次 fs，可接受；写路径（prewarm 填充）为 `delegateBatch` 开头串行 await，无实例级状态污染。批级 cache 生命周期结束即 GC，无跨批泄漏。
- 预热错误文件（scope 填了但不读）→ 预热是 best-effort，60s TTL 自然过期，代价仅为一次 fs stat/read。
- P1-1 块序调整影响所有 worker 与主会话缓存键 → 必须过 `verify-cache-hit-rate.ts` 基线；失败则回退为「仅 worker 引擎调整块序」的收窄方案。**认知风险**：star-domain 后移降低星域指令权重，冒烟观察遵循度，衰减则回退。
- P0-1 动 coordinator + worker-session（主仓），需与 PR #14 本体（B2/B3/W1-W4 修复）同批评审；P1-1 独立 PR。galaxy.ts 已随 PR #14 合入主仓 main。

### 附录：run.packet 消费方评估（2026-08-01 结论）

grep 全仓后确认 `run.packet` 是 delegate 系工具的**主结果载体**，消费方包括
`delegate-task.ts:245`、`delegate-batch.ts:369`、`team-orchestrate.ts:115`、
`plan-task.ts:266`、`hooks/anchor-break-scout-hook.ts:136`——coordinator 的
packet 构建**不可跳过**（跳过会同时斩断这些工具的输出）。galaxy 侧自写报告
（含聚合缓存行 + DP quorum + 核验护栏）保留；packet 构建成本仅在超 32K 预算
时多一次 artifact 落盘，galaxy 场景可接受。**结论：不做跳过改动**，galaxy 与
packet 双轨并存是刻意选择而非浪费。

### 附录：P1-1 验证记录（2026-08-01）

- `tsc --noEmit` 通过；prompt/agent 相关 277 项测试中仅 2 项失败，与块序调整
  前后逐文件对比完全一致（`volatile.test.ts` 的 `order of parts` 与
  `buildDynamicAppendixParts` 均为既有失败，worktree 未改版本同样挂）——零新增回归。
- `scripts/verify-cache-hit-rate.ts`（真实 API 基线）：**未执行成功**——环境内
  `DEEPSEEK_API_KEY` 已失效（401）。块序稳定性的缓存语义由
  `engine-cache-stability.test.ts`（通过）覆盖。
- **真实冒烟（2026-08-01，headless + v4-flash，3 worker 星河）**：galaxy 真实
  扇出，聚合报告 `input Σ1.40M · cacheRead Σ1.28M · 命中率 91.2%`；worker
  `cache-log.jsonl` 实测：DP 副本 1 首轮 86.9%（建缓存），**副本 2 首轮即
  86.9%**（吃副本 1 的同字节前缀缓存——跨 worker 共享获真实佐证），后续轮
  96.9–98.6%。autoReview join 正常触发。**星域遵循度信号正面**：两个瑶光副本
  因只读无法动态复现，主动将结论自我降级为 unverified（绿非证明纪律在块移后
  完整生效，未见身份衰减）。认知影响长期观察仍保留。
- 同轮冒烟抓到并已修复：P0-1 消费端断裂（`46e66728`）、headless galaxy 注册
  时序 + bootstrap 丢参（`a5ea68dd`）。
