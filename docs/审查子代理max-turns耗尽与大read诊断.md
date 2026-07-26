# 审查子代理 max-turns 耗尽与首次大 read 诊断

> 2026-07-24 调查。起因：审查 worker（wiring/silence inspector）批量报「No work order context provided」「Unable to perform code review」等看似"缺上下文"的错误。深挖 worker session jsonl 后确认：**这些 summary 全是假象**，真根因是 worker 跑满 maxTurns 被切断、没产出 verdict JSON，且**首次全量 read_file 的大结果永久占据历史**。本文记录事实、证据、保护链为何层层失效，供后续修复参考。

---

## 1. 事实陈述

### 1.1 错误 summary 是假象，不是真"缺上下文"

`~/.rivet/subagents/*.json` 里 worker 的 `summary` 字段是 salvage 后的二手结果，在 max-turns 场景下**不可信**。对照 worker 真实 session jsonl（`~/.rivet/sessions/<slug>/worker-*`），summary 与轨迹完全矛盾：

- **wo_6be31b46**（deepseek-v4-flash，summary="No work order context provided"）：实际 prompt 50 万 token（12 轮累加）、21 次工具调用，轨迹全程在跑 `git diff`/`read_file`/`grep`，第 12 轮（最后一轮）仍在发 `read_file, grep`。`lastStopReason: max-turns / exhausted without a final turn / voluntary: false`。
- **wo_30437110**（glm-5.2，summary="Unable to perform code review…no repository, diffs"）：31 次工具调用、prompt 29 万 token，模型自己在 jsonl 第 13 行说「我需要检查提交的差异」并一路查到第 46 行。

**结论**：这些 worker 全程有上下文、有工具、正常工作，只是没收敛出 verdict JSON 就被 maxTurns 切断。salvage 逻辑把模型在半成品文本里写的敷衍 summary（"我没拿到上下文"）当真了。

> 方法论教训：子代理 summary 在 max-turns 场景下不可信，必须回到 worker session jsonl 看真实轨迹。

### 1.2 真根因：单一原因——maxTurns 配额用光，worker 没收敛

近 4 天（7-21~7-24）所有能查到 meta 的真实失败 worker，全是同一模式：

| worker | model | toolCalls | prompt tokens(12轮累加) | stop |
|--------|-------|-----------|----------------------|------|
| wo_6be31b46 | flash | 21 | 505,912 | max-turns |
| wo_30437110 | glm-5.2 | 31 | 294,807 | max-turns |
| wo_113559cb | flash | 23 | 519,668 | max-turns |
| wo_3541a32d | flash | 19 | 300,717 | max-turns |
| wo_554c53a1 | flash | 21 | 305,162 | max-turns |

共同特征：大 prompt（20-50 万 token 累加）+ 高工具调用次数（19-31）+ `maxTurns=12` 耗尽 + 非自愿终止。

### 1.3 maxTurns=12 是当前值

`src/agent/review-coordinator-deps.ts:358-359`：
```ts
const AUTO_WIRING_WORKER_TIMEOUT_MS = 240_000   // 240s
const AUTO_WIRING_WORKER_MAX_TURNS = 12
```
历史（注释 `:354-357`）：2026-07-19 审查空耗事故后，从 6 轮/150s 放大到 12 轮/240s。现在 12 轮仍然系统性不足。

只有 **wiring 路径**用这个常量（`wiringReviewerRequest:384`、`spawnWiringReviewer:444`）。其他审查路径（`spawnSquadron`/`spawnVerifier`/`spawnPatcher`）不传 budget，走 reviewer profile 默认 `defaultTimeoutMs: 600_000`（`profile-registry.ts:94`，10min），且 profile 无 `defaultMaxTurns` 字段。

### 1.4 抬高 maxTurns 无副作用——1M 窗口下空间充足

deepseek-v4-pro / flash / glm-5.2 全是 `contextWindow: 1_000_000`（`provider-presets.ts:38,47,84`）。505,912 是 `addUsage()` 把 12 轮 input_tokens **累加**的结果（`context.ts:356-357`），单轮最大才 ~5 万 token，离 1M 差 20 倍。窗口完全不是瓶颈。

抬高 maxTurns 的约束只剩两个：时间（每轮 flash ~10-20s，需同步抬 timeoutMs）和成本（多轮重带固定开销，但有前缀缓存兜底）。

---

## 2. 深层原因：首次大 read 永久占据历史

抬高 maxTurns 是治标。治本要看为什么 12 轮被"探索"吃光——**首次全量 read_file 的大结果永久留在历史里，每轮重带**。

### 2.1 铁证：5 个失败 worker 全部有首次全量 read

按 `tool_call_id` 配对工具调用与结果后：

| worker | 全量 read（无 offset/limit）的文件（字符数） |
|--------|------------------------------------------|
| wo_6be31b46 | plan.ts(28,958) · **session-manager.ts(50,019)** |
| wo_30437110 | GoalBar.tsx(5,488) · session-event-hub.ts(11,058) · mission-projector.ts(11,900) · **event-reducer.ts(44,902)** · team-panel-model.ts(8,570) |
| wo_3541a32d | domain-lesson-precipitate.ts(5,871) · .test.ts(8,907) |
| wo_554c53a1 | 同上 |

模型第一次读目标文件时全量读，**没有任何截断**。wo_30437110 一次全量读 5 个文件、合计 8 万字符——这 8 万字符之后每轮都留在历史里。

值得注意的是：模型**后续的 read 全都自觉带了 offset/limit**（如 `limit:60,offset:2580`，体量 1-2KB），说明它会用，只是第一次没带。

### 2.2 wo_6be31b46 的 prompt 构成（反推）

worker 任务 prompt 仅 **11,099 字符**（`<worker-knowledge>` + Objective + Scope + Files，结构正常）。505,912 token 累加的构成：
- 固定开销 S ≈ 17,636 token/轮（system prompt + 工具定义）× 12 轮 = 211,636
- 对话历史累计 ≈ 294,276（第 4 轮因两个大 read 跳涨到 2.6 万 token，之后每轮递增）
- 两者相加 ≈ 505,912 ✓

第 4 轮的跳涨是元凶：两个超大 tool result（29KB + 50KB）一次性塞进历史，**之后每轮都被重带**。

---

## 3. 保护链为何层层失效（不猜，全源码为据）

worker 的大 read 不被裁，是因为五层保护机制**全部恰好对 1M-window worker 失效**：

### 第一层：read-ref 防的是"重复读"，不是"首次大读"

`read-file.ts:751-810`。触发条件（全满足才生效）：
- `isReadRefEnabled()`（默认开，`:130`）
- `unchangedRepeat`——**必须是第二次读同文件且 mtime 未变**（`:744-748`）
- `entryBytes > READ_REF_THRESHOLD(2048)`（`:776`）

失败 worker 的文件每个只读了一次，read-ref 根本不触发。它管的是"第 2 次读"，问题出在"第 1 次读得太大"。

### 第二层：read_file 单次截断，1M 窗口被放大到 12 万字符

`model-read-cap.ts:53-98`。`computeModelReadCap(1M)`：
```
1_000_000 × 0.05(≥500K档) × 4(CHARS_PER_TOKEN) × 1.3(cache-preserving) = 260_000
→ 夹到 ABSOLUTE_MAX_CHARS = 120_000
```
50KB 文件远低于 12 万，**原样返回不截断**。注释（`:5-8`）明说这是有意为之：1M 窗口下 8000 字符只占 <1%，slice 会让推理不可靠。对主会话合理，对轮次有限的 worker 反效果。

### 第三层：worker 压缩全关，且 1M 窗口连请求时修剪都跳过

最致命的一层，三个子机制全部失效：

**3a. 重压缩（maybeCompact）** — `compaction-controller.ts:503-505`：
```ts
if (this.deps.compactEnabled === false) {
  return { failures: input.failures, compacted: false }
}
```
worker `compact.enabled = false`（`bootstrap.ts:870/929/1015` 三处全 false）→ maybeCompact 直接返回，T9 质量压缩、sessionSplit 全不跑。

**3b. stale-round 修剪** — `compact-boundary-coordinator.ts:225`：
```ts
if ((tokenRatio >= 0.5 || ...) && contextWindow < 1_000_000) {
```
硬条件 `contextWindow < 1_000_000`。worker 是 1M → 整个分支跳过，N-2 轮的旧 tool_result 永远不被裁。

**3c. 请求时修剪（semantic prune / staleness / observation masking）** — `prompt/engine.ts:610,632`：
```ts
if (!contextWindow || contextWindow < 1_000_000) {
  // pruneOutdatedQueryResults / detectStaleness / observation masking
}
```
同样是 `contextWindow < 1_000_000`。worker 是 1M → 请求时也不裁。

注释（`:626-630`）说明设计意图：1M 窗口"有足够空间"，修剪破坏 exact-prefix cache，靠 `trySessionSplit` 防溢出。但 trySessionSplit 归 maybeCompact 管，worker 关了 compact，等于这条防线在 worker 上整个不存在。

### 主控为什么不这样

主会话同样是 1M 窗口，3a/3b/3c 里 `contextWindow < 1M` 的条件对它也不满足——但主会话 `compact.enabled = true`，靠 3a 的 maybeCompact（T9/sessionSplit）做重压缩兜底。worker 唯一区别就是 `compact.enabled = false`，把最后一道防线也关了。

### 保护链总结

| 保护层 | 源码位置 | worker 是否生效 | 原因 |
|--------|---------|---------------|------|
| read-ref 引用化 | `read-file.ts:756` | ❌（首次读不触发）| 只防重复读 |
| read_file 单次截断 | `model-read-cap.ts:98` | ❌（cap=120K）| 1M 窗口 cap 放太大 |
| maybeCompact/T9 重压缩 | `compaction-controller.ts:503` | ❌ | `compact.enabled=false` |
| stale-round 修剪 | `compact-boundary-coordinator.ts:225` | ❌ | `contextWindow < 1M` 挡掉 |
| 请求时 semantic/staleness/mask | `engine.ts:610,632` | ❌ | `contextWindow < 1M` 挡掉 |

**五层保护，worker 一层都吃不到。** 所以一个 50KB 的首次全量 read 会原封不动留在历史里，每轮 prompt 重带，直到 maxTurns 耗尽。

---

## 4. 修复（2026-07-24 已实施，四层）

> 原"修复方向（待定）"已全部落地，另有两个实施中坐实的新发现（见 4.5/4.6）。

### 4.1 prompt 机械化约束（原方向 C）

`earlyConvergenceHint` 实际在 `review-coordinator-deps.ts:362`（本文原写 worker-prompts.ts 是笔误）。原 hint 已有"禁止整文件 read"但模型首读时不遵守——意图性表述无效。改为机械可执行规则：「`read_file` 每次调用都必须带 `offset`+`limit≤200`——包括第一次读」，并解释后果（全量 read 永久钉进每轮上下文）。

### 4.2 salvage 降信（新增层，治"假 summary"）

**假 summary 的制造机制已定位**：`runWorkerSession` parse 失败后走 `repairWithJsonMode`——它是**无对话历史的单发直连请求**（只带 repair prompt + 前文尾部），模型看不到任何任务上下文，于是捏造"没拿到上下文"的合法 JSON，parse 通过后堂而皇之上桌。

修复（`worker-session.ts`）：初始 run 的 `agent.latestStopReason.source === 'max-turns' && !voluntary` 时**绝不进修复梯**。新纯函数 `buildMaxTurnsExhaustedResult` 走诚实阶梯：终轮已产出合法报告→正常路径；可字段级抢救→保留 findings + max_turns 标注；否则结构化 blocked，summary 带 `max-turns: exhausted without a final turn` 标记（命中 `classifyInfraFailure` 的 budget 正则→重试分流不做同预算复跑），半成品散文只作为 artifact 留痕。`WorkerFailureReason` 新增 `'max_turns'`。

### 4.3 worker 紧 read cap（原方向 B，治本）

`AgentConfig`/`ToolCallParams` 加 `readCapOverride?: ModelReadCap`，worker 注入 `WORKER_READ_CAP = 16,000 字符`（`worker-session.ts`），`read_file`（单读+多读）与 `grep` 均消费。超 cap 的无参数全量读经 `preferFoldOnOverflow` 门降级为 fold 摘要骨架（带导航提示教模型精确重读；单超长行病态场景回退字符级截断）——该门**仅在 override 激活时生效**，主会话字节级行为不变。

### 4.4 预算抬升（原方向 A，兜底余量）

`AUTO_WIRING_WORKER_MAX_TURNS 12→20`、`TIMEOUT 240s→360s`（`review-coordinator-deps.ts`），外层 `AUTO_REVIEW_BUDGET_MS 300s→420s`（`review-router.ts`）。

### 4.5 新发现：policy 层在单文件工具路径上是死接线

`READ_FILE_TOOL.execute` 把 `offset` 默认成 1 再传给 `readFilePayload` → `hasExplicitRange` **恒真** → `decideReadPolicy` 的全部无参保护（>80KB 源文件 PARTIAL 视图、log preview、>100KB too-large 门）在单文件工具读上**从不触发**（实测 144KB 源文件经工具返回 108K 字符切片）。这是"首次全量大 read 不被裁"的更深根源——工具描述里"超过约 2000 行返回 PARTIAL 视图"一直是死文档。已修：只在模型真正传了 offset/limit 时才下传（多读分支本来就不传,不受影响）。

### 4.6 遗留

- `read-file-invalidation.test.ts` 的 `position-only hash_edit hard-reject is session-scoped` 失败 + 进程尾部挂起：**HEAD worktree 复现，预先存在**，与本次修复无关，另行排查。
- cap 收紧的 trade-off 仍在：worker 看不全文件可能影响审查质量——但骨架+导航提示实测可引导精读（失败 worker 后续 read 全部自觉带参数），且 20 轮预算给了补读空间。观察一周 max-turns 失败率再定是否微调 16K。

---

## 5. 排查路径备忘

- 真实失败 worker 的 session jsonl：`~/.rivet/sessions/<slug>/worker-<orderId>-<nonce>.jsonl`（slug = `目录名+cwd哈希前6位`，本项目是 `opencode-tui-522c83`）
- worker 摘要（二手，不可信）：`~/.rivet/subagents/*.json`
- 区分测试产物 vs 真实失败：看 `model` 字段。`test-model`/`large-cache`/`fast-json`/`cheap-flash` 是测试夹具假名；`deepseek-v4`/`glm-5.2`/`MiniMax-*` 是真实运行
- 看真实 maxTurns 是否生效：worker meta.json 的 `lastStopReason`（`source: max-turns` / `detail: exhausted without a final turn` / `voluntary: false`）
- 按工具调用配对查大 read：用 `tool_call_id` 关联 assistant 的 `tool_calls` 与 tool result，过滤 `read_file` 且 args 无 offset/limit 的
