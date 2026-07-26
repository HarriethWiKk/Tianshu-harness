# 2026-07-25 无为季与产出流的行为冲突修复

## 背景

卦象阶段道统设计（`docs/design/2026-07-25-hexagram-cvm-stage-doctrine.md`）的 Phase −1
离线探针在验证「四代理收敛」价值前提时，顺带量出一个独立于该设计的实存缺陷：
心流帧几乎全部落在 `wuwei` 季内，而 `wuwei` 会把执行价值打三折。

完整取证见 [`docs/analysis/2026-07-25-hexagram-stage-doctrine-evidence.md`](../analysis/2026-07-25-hexagram-stage-doctrine-evidence.md)
的 C6 及其处置节。

## 实测（16 个真实会话 / 2169 帧，最近 4 天全部可用遥测）

```
season 分布：wuwei 73.9% · genesis 26.1%     doom 全程 none
isInProductionFlow 命中 251 帧（11.6%），其中 season=wuwei 的 233 帧（92.8%）
探针自定义「飞」口径互证：370 帧中 347 帧在 wuwei 内（93.8%）
```

工具 status 未落遥测，回放一律记 success ⇒ 无失败可排除 ⇒ 命中数为上界。

静态可解释：零改动会话的 `computeStability` 走重归一分支，doom 干净时基线 ≈ 0.688，
而 `wuwei` 门槛只是 turn>5 + stability ≥ 0.6 —— 在 turn>5、doom 干净的前提下，
**产出流的判定域几乎被 wuwei 包含**。

## 问题

`wuwei` 同时携带两层意图：「别打扰」和「抑制执行」。前者与产出流一致（正在推进时
更不该插话），后者与产出流正相反。旧实现让两者绑在同一个季节标签上，于是
`prediction-error.ts` 的 `pragmatic × 0.3` 与 `affordance.ts` 的 `instrumental × 0.3`
恰好压在「编辑 + 验证推进中」的那批帧上 —— stability 高**正是因为**在稳定产出，
却被当成了「没事别动」的理由。

## 变更

不动 `classifySeason`，也不新增第五季：只让冲突的那一层在产出流中让位。
（若改判季节标签，产出流会掉进 `genesis` 分支从而**开始**发鼓励，与 navigator
沉默规则正面打架 —— 修错了地方比不修更糟。）

| 位置 | 改动 |
|------|------|
| `src/agent/production-flow.ts` | 新建。`isInProductionFlow` 判据本体自 `loop.ts` 内联闭包提取，成为三处共用的单一事实源 |
| `src/agent/prediction-error.ts` | `seasonFactor`：`wuwei && !inProductionFlow` 才 ×0.3，否则回到无折扣基线（不是换个新系数） |
| `src/agent/affordance.ts` | `instrumentalModulator` 的 `seasonPenalty` 同上；`AffordanceState` 增 `inProductionFlow` |
| `src/agent/turn-step-producer.ts` | 每帧算一次，同时喂 `computeEFE` 与 `AffordanceState` |
| `src/agent/loop.ts` | `setFlowStateProvider` 改调同一函数 |

提取时唯一的语义变动：编辑工具集统一到 `WRITE_TOOL_NAMES`，比原内联列表多
`ast_edit` —— 原列表漏掉它属于同类漂移（参照 `PRODUCTIVE_TOOLS` 单一事实源），
不是有意排除。

## 有意未修

- **`wuwei` 覆盖 73.9% 帧这件事本身没动。** 非产出流的稳定帧继续 ×0.3，那正是无为的本意。
- **纯编辑连击（尚未跑验证）不算产出流，仍受抑制。** 产出流要求「编辑 + 验证」两个半边，
  与 TDD 纪律同向，不做放宽。
- **卦象读出层的飞/wuwei 消歧仍是设计文档的未决项。** 本次只解行为层冲突。

## 验证

- `production-flow` 新增 9 例纯函数规格测试，全绿
- `prediction-error` / `affordance` 各新增行为测试（先 RED 后 GREEN），含「让位到基线」
  与「不误伤 genesis 折扣」两条边界
- `npm run typecheck` 零 error
- `src/agent/` + `src/prompt/` + `src/context/` 回归：残留失败 22 例经 HEAD 临时 worktree
  逐一对照，**与本次改动无关**（`cognitive-mirror` 12 例、`general-ledger`、`loop-reentry`、
  `autonomy-checkpoint` 在干净 HEAD 上同样失败；`theta-check` 单独跑通过，批量并发跑 tsc 时环境性超时）
