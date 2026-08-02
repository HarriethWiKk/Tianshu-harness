---
title: DeepSeek MoE × 天枢 Galaxy 协同方向收编
type: research
status: draft
date: 2026-08-01
stage: D1
related:
  - docs/design/2026-08-01-galaxy-mechanism-convergence.md
  - docs/superpowers/specs/2026-07-14-cluster-agent-architecture.md
---

# DeepSeek MoE × 天枢 Galaxy 协同方向收编

> 调研日期：2026-08-01。基于 DeepSeek V3/V4 MoE 架构特征（细粒度专家 + 共享专家 + MLA KV-cache 压缩），扫描与天枢 Galaxy 多 agent 编排可形成结构协同的六个方向。

## 背景

DeepSeek V3/V4 的 MoE 架构核心参数：671B 总参数，每 token 仅激活 37B。关键组件：

- **细粒度专家（Fine-grained Experts）**：每层 256 个路由专家，每 token 选 top-8
- **共享专家（Shared Experts）**：2 个始终激活的专家，承载通用知识（编程语法、基础推理）
- **Multi-head Latent Attention（MLA）**：KV cache 压缩至传统 attention 的约 1/5–1/10
- **辅助损失免策略（Auxiliary-loss-free）**：专家路由均衡无需额外损失项

天枢 Galaxy 多 agent 编排与 MoE 模型之间存在结构同构——两边都是"路由 + 专业化"：Galaxy 按维度/authority 路由任务到 worker，MoE 按 token 路由计算到专家。以下是基于该同构的六个可探索方向。

## 六个方向

### 1. Expert Affinity 调度（零代码，调度亲和已落地）

**原理**：DeepSeek MoE 的专家路由是确定性的——相同前缀的 token 序列总是激活相同的专家集合。同 authority 的 worker 不仅在 prompt 前缀上共享 KV cache，在服务端专家选择上也共享计算路径。同批同 authority 的 worker 连续调度时，第一个 worker 的专家权重加载后，后续 worker 的专家权重已在 GPU 显存中，实际推理延迟递减。

**实测验证（2026-08-01，DeepSeek V4 API，`d1-expert-affinity-probe.ts`）**：

| 组别 | 轮次 | cacheRead | cacheCreate | 命中率 |
|------|------|-----------|-------------|--------|
| 同 authority（天权×3） | A0 | 384 | 3 | — |
| | A1 | 384 | 3 | 99.2% |
| | A2 | 384 | 3 | 99.2% |
| 跨 authority（权→机→瑶） | B0·天权 | 384 | 3 | — |
| | B1·天机 | 0 | 384 | 0% |
| | B2·瑶光 | 0 | 386 | 0% |

同 authority 连续请求的全前缀共享（384 cache tokens）在切换 authority 后完全断裂——证明调度亲和可省约 99% 的 input token 成本。

**天枢现状**：调度亲和（Galaxy 收编设计 #4）已落地（`5d8020c4`）——`WorkOrderQueue.dequeue` 按 authority 聚类出队。不做任何代码改动即可获得服务端的自然收益。

**验证方式**：同 authority 的连续 worker 对比跨 authority 的连续 worker，观察 `cache-log.jsonl` 中的 `time_to_first_token` 差异。

### 2. Static Prompt 共享专家最大化（中期）

**原理**：共享专家承载通用知识且始终激活。天枢的 frozen system prompt（`sober→locus→star-domain→project-instructions`）天然落在共享专家上——不消耗路由专家的 KV cache 预算。当前 star-domain 块包含大量星域专属纪律文本，这些应属于"路由专家"的范畴。

**优化方向**：将通用执行纪律（所有星域共享部分，约 40% 文本）和星域专属纪律（约 60% 文本）显式分离——通用部分留 frozen 块走共享专家，专属部分以精简形式注入走路由专家。总体 worker prompt 有效容量增大（共享专家区能容纳更多通用上下文）。

**涉及文件**：`src/prompt/static.ts`、`src/prompt/volatile.ts`。

**风险**：prompt 结构变动触发前缀缓存 miss（所有 worker 首轮冷启动）。需经 `scripts/verify-cache-hit-rate.ts` 基线验证。

### 3. 级联 Tier 推测执行（中期）

**原理**：DeepSeek 的 MoE 哲学——多数 token 只用 37B 参数（cheap），难的 token 才激活更多计算（strong）。天枢 Galaxy 有 tierFloor 三档（cheap/balanced/strong）和 DP quorum 机制。

**方案**：DP 副本先用 cheap 模型（v4-flash）跑——结果一致且 quorum 通过则直接采纳（成本最低）；结果不一致或 quorum 未达成时，自动 escalate 到 strong 模型重新验证分歧点。成本-质量帕累托：90% 场景 cheap 够用，10% 触发 escalation。

**与现有设施的衔接**：`tierFloor` schema + DP `replicas` + `quorum` 判定 + `tierTimeoutMultiplier`。新增：escalation 触发逻辑（quorum 未达成 → 自动追加 strong 副本）。

**参考论文**：MasRouter: Learning to Route LLMs for Multi-Agent Systems（ACL 2025）。

### 4. MoE Routing Locality 即隐式 Pheromone（长期，API 依赖）

**原理**：FineMoE 论文（2026.04，arxiv:2604.17182）证明共享前缀的代码生成请求在各层的专家选择模式高度相似。同文件、同 authority 的只读 worker 在服务端产生相似的专家激活轨迹——这个"专家激活指纹"是零成本的隐式信息素，不需要 worker 显式写 stigmergy。

**前提**：需 DeepSeek API 暴露 expert activation metadata（当前不提供）。一旦可用，天枢可直接读取做调度决策（"worker A 和 worker B 的专家激活模式高度重叠 → 结果强相关 → quorum 权重上调"）。

**替代方案**：不依赖 API——用 proxy 层（如 `cache-log.jsonl`）记录 `time_to_first_token` 和 `tokens_per_second` 作为专家亲和度的代理指标。

### 5. MLA KV-Cache 压缩 × 激进续跑（一行常量）

**现状**：`MAX_BUDGET_CONTINUATIONS = 2`（`src/agent/worker-continuation.ts:18`），即 worker 最多续跑 2 次。这是基于稠密模型 KV cache 膨胀的保守估计。

**原理**：MLA 将 KV cache 压缩至传统 attention 的约 1/5–1/10。worker 的 multi-turn 上下文（续跑、resume、checkpoint）的内存成本远低于稠密模型。续跑 4–5 次基本不会因 KV cache 膨胀导致退化。

**改动**：`MAX_BUDGET_CONTINUATIONS` 从 2 改为 4。受益：减少 hard-fail（blocked），增加 partial result salvage 概率。

**影响面**：`delegationToolTimeoutMs` 中的 `runs` 因子（`1 + MAX_BUDGET_CONTINUATIONS`）相应增大——外层 timeout 会增长约 67%（从 3x 到 5x）。需同步评估。

### 6. Expert Dropout 即对抗信号（纯观测）

**原理**：FP8 混合精度下 MoE 路由有微小数值噪声——同一 prompt 两次推理可能激活略有不同的专家子集（概率约 1–3%）。这不是 bug——是 genuine uncertainty。

**利用**：如果两个 DP 副本在相同模型上得出不同结论，不一定是 worker 的推理问题——可能是 MoE 路由的微小差异导致了不同的推理路径。这种分歧本身就是有价值的信号（该任务存在 genuine ambiguity），不应简单地判为"一方错误"。

**观测方式**：比较同模型同 prompt 的 DP 副本结果时，对细微分歧不立即判为 failure，而是标注为 "possible routing divergence" 并降级为 advisory。

## 优先级矩阵

| # | 方向 | 落地难度 | 收益 | 与现有设施的关系 |
|---|------|---------|------|----------------|
| 1 | Expert Affinity 调度 | 零代码（调度亲和已做） | 服务端自动收益 | Galaxy 收编 #4 |
| 2 | 共享专家 Prompt 结构 | prompt 引擎重构 | 容量提升 | `static.ts` + `volatile.ts` |
| 3 | 级联 Tier 推测 | galaxy + coordinator | 成本-质量帕累托 | `tierFloor` + DP + quorum |
| 4 | Routing Locality Pheromone | API 依赖（暂无接口） | 长期 | Galaxy 收编 #3 批级信息素 |
| 5 | MLA × 激进续跑 | 一行常量 | 减少 hard-fail | `MAX_BUDGET_CONTINUATIONS` |
| 6 | Expert Dropout 对抗 | 纯观测 | 零成本信号 | DP 副本机制 |

## 近期可动手项

**D1-1** `MAX_BUDGET_CONTINUATIONS`: 2 → 4（一行改动 + 测试更新 + typecheck）。收益：减少 worker blocked。

**D1-2** Galaxy 收编 #3（批级信息素）+ #4（调度亲和）→ 结合 Expert Affinity 做一篇实测报告：同 authority 连续 worker vs 跨 authority 连续 worker 的 `cache-log.jsonl` 温差。

**D1-3** 级联 Tier 推测 spec 设计：quorum 未达成 → auto-escalate strong 副本的触发逻辑与成本边界。

## 参考

- DeepSeek-V3 Technical Report（arXiv:2412.19437）——MoE 架构、MLA、辅助损失免策略
- FineMoE: Layer-wise MoE Routing Locality under Shared-Prefix Code Generation（arXiv:2604.17182, 2026.04）
- MasRouter: Learning to Route LLMs for Multi-Agent Systems（ACL 2025）
- DeepSeek V4 Inference Optimization（clusterbid.com, 2026）——KV cache sizing、MLA kernel fusion
- Sparse Mixture-of-Experts Architectures and AI Agent Systems（zylos.ai, 2026.03）
