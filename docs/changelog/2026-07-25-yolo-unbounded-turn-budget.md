# 2026-07-25 YOLO 无上限轮次的两处漏判

## 背景

`maxTurns = 0` 是「无轮次上限」的哨兵值，YOLO（`dangerously-skip-permissions`）
下由 `bootstrap.ts:1074` / `serve-agent.ts:420` / `slash-commands.ts`（`/yes`、权限面板）
四条路径统一置入，配置里的 `agent.maxTurns` 从此不生效。

这个约定在两处被正确遵守：

- `turn-orchestrator.ts:441` — `effectiveLimit = maxTurns > 0 ? maxTurns : Number.MAX_SAFE_INTEGER`
- `turn-budget-hook.ts:40` — `if (maxTurns <= 0) return`

另有两处漏了。

## 缺陷一：`isFinalTurn` 在 YOLO 下恒真（主要）

`perception.ts:92` 原为 `isFinalTurn: input.turn >= input.maxTurns - 1`。
`maxTurns=0` 时即 `turn >= -1` —— 从第 0 轮起恒为真。

它喂给 `StarPhase` 规则 3（`momentum > 0.8 && isFinalTurn → 瑶光归航`）。
同一份语料（16 会话 / 2169 帧）两个口径回放：

| | 修复前（生产真实） | 修复后 |
|---|---|---|
| `StarPhase` 熵 | 1.77 bit | 1.38 bit |
| 瑶光归航 | **49.2%** | 0% |
| `PhaseClass` deliver | **49.2%** | 0% |

近一半的帧被判成「交付阶段」，`phaseClass=deliver` 随之进入提示词与 convergence
的 phase-aware 阈值——**一个没有轮次上限的会话，被一路当成在收尾**。

与同日修复的 wuwei 缺陷（`docs/changelog/2026-07-25-wuwei-production-flow-conflict.md`）
是同一类病：把「该收手了」的信号常态化。

## 缺陷二：`turnDepth` 在 YOLO 下饱和（次要）

`reasoning-effort-controller.ts` 两处 `getTurnCount() / Math.max(getMaxTurns() ?? 50, 1)`
的 `?? 50` 只挡 `undefined` 不挡 `0`：YOLO 下分母塌成 1，`buildEffortContext` 再
clamp 到 1，于是 effort bandit 上下文的深度维度从第一轮起恒为 1，失去区分度。

## 变更

| 位置 | 改动 |
|------|------|
| `perception.ts:92` | `isFinalTurn` 加 `input.maxTurns > 0` 前置——无上限则没有最终轮 |
| `p3-reward.ts` | 新增导出 `computeTurnDepth(turnCount, maxTurns?)`：有上限取比例，无上限退化为固定分母 50（沿用 `tool-execution.ts` 既有口径）并封顶 1 |
| `reasoning-effort-controller.ts` | 两处改调 `computeTurnDepth` |
| `tool-execution.ts:200` | 原本就是 `min(1, count/50)`，改调同一函数——行为不变，消除第三份口径 |

## 影响与遗留

- 已发布的 `docs/analysis/2026-07-25-hexagram-stage-doctrine-evidence.md` 初版用
  `maxTurns=50/200` 回放，与生产不符。已加 1.5 节说明口径更正，3.1 / 3.2 改为
  双口径并列，S4f 的归因（原写「长会话后半程」「9.1%」）一并更正。
  C1（条件熵恒 0）与 C2（两两 NMI < 0.07）在三个口径下方向一致，结论不变。
- `tool-execution.ts` 那一层拿不到 `maxTurns`，仍走无上限口径——它是 shadow 遥测，
  不改行为，暂不为此加接线。
- 固定分母 50 是沿用既有口径的选择，不是标定过的值。真正合理的「无上限深度」
  度量（按 token 预算或任务阶段而非轮数）留待后续。

## 验证

- `perception` 新增 YOLO 用例（turn=0/1/50/500 均不判最终轮），`turn-depth` 新增
  4 例规格测试，先 RED 后 GREEN
- `perception` / `star-event` / `turn-perception` / `p3-*` / `effort-*` 共 97 例全绿
- `npm run typecheck` 零 error
