---
title: 调度亲和升级——从 tie-breaker 到一级排序因子
type: design
status: draft
date: 2026-08-01
stage: D2
related:
  - docs/3.0/D1-moe-galaxy-deepseek-synergy.md
  - docs/design/2026-08-01-galaxy-mechanism-convergence.md
---

# 调度亲和升级——从 tie-breaker 到一级排序因子

> D1 实测证据：同 authority 三连发 cacheRead 384/384/384（命中率 99.2%），跨 authority 切换后归零。调度亲和的 token 成本节省是真实的——但当前实现只是 tie-breaker（同 priority 档内才生效），大多数场景不触发聚类收益。

## 背景

### D1 实测结论

同 authority 连续请求共享服务端全量 KV cache（384 tokens），切换 authority 后完全断裂（cacheRead=0）。token 成本节省约 99%。

### 当前实现（星河收编 Wave 2）

`src/agent/work-queue.ts` 已落地的基础设施：

```
QueueEntry.affinityKey ← order.authority          // enqueue 时存储
WorkOrderQueue.lastDequeuedAuthority               // dequeue 时更新
dequeue() 内 tie-breaker                            // 同 priority 档内匹配
```

`enqueue` 排序：`entries.sort((a, b) => b.priority - a.priority)`——纯 priority 降序，不考虑 authority。

`dequeue` 亲和逻辑（已存在）：

```typescript
// 亲和 tie-breaker：只在同 priority 档内选与上一个出队同 authority 的任务
let pick = firstRunnable
if (this.lastDequeuedAuthority !== undefined) {
  const firstPriority = this.entries[firstRunnable]!.priority
  const affinity = this.entries.findIndex((e, i) =>
    i > firstRunnable && e.priority === firstPriority
    && e.affinityKey === this.lastDequeuedAuthority && canRun(e),
  )
  if (affinity !== -1) pick = affinity
}
```

### 当前机制的瓶颈

tie-breaker 在以下场景不触发：

1. **只有一个 runnable entry 时**——没有候选可挑
2. **同 priority 档内没有同 authority 候选时**——跨 authority 无法匹配
3. **初始排序不聚类**——`entries.sort(b.priority - a.priority)` 不考虑 authority，同 priority 的不同 authority 交错排列；tie-breaker 只能补救第一对相邻，后续仍随机

典型 galaxy 场景（5 维度，各 1 worker，priority 均为 0）：
```
enqueue 顺序：天权·天机·瑶光·文曲·天府
dequeue 顺序（tie-breaker）：天权→天机→瑶光→文曲→天府  // 无同 authority 相邻，全部 cache miss
dequeue 顺序（聚类排序）：天权→天机→瑶光→文曲→天府     // 同样全 miss，因为各 authority 只有 1 个
```

只有同 authority 多个 worker 时（如 DP 副本、多 authority 视角），tie-breaker 才生效。

## 目标与非目标

- 目标：`enqueue` 初始排序加 authority 聚类——同 authority 的 entries 在 priority 相等时自动成簇
- 目标：`dequeue` 亲和从"同 priority 档内匹配"升级为"相邻 priority 档也可提升"（`affinityBoost`）
- 非目标：不改变 priority 的主排序地位（priority 10 的紧急任务不因亲和让给 priority 0）
- 非目标：不改变依赖/冲突/并发检查（canRun 逻辑完全不动）
- 非目标：不引入跨 authority 的全局优化排序（不需要知道谁能取缓存——只需让同 authority 的相邻即可）

## 设计

### 两级升级

#### 升级 A：enqueue 聚类排序

`entries.sort` 从 `(a,b) => b.priority - a.priority` 改为：

```typescript
// priority desc → authority 聚类键 → enqueue 序
const byPriority = (a: QueueEntry, b: QueueEntry): number =>
  b.priority - a.priority
    || (a.affinityKey ?? '').localeCompare(b.affinityKey ?? '')
```

效果：同 priority 的所有 entries 按 authority 字母序成簇（天机·天机→天权·天权→瑶光·瑶光），dequeue 时自然连续命中。

改动面：`enqueue` 方法 1 行。

#### 升级 B：affinityBoost——相邻 priority 也可提升

当前 tie-breaker 只选同 priority 的亲和候选。升级后：如果第一个 runnable entry 不匹配 `lastDequeuedAuthority`，在后续 entries 中查找匹配的，只要其 priority 差异不超过 `AFFINITY_BOOST_PRIORITY_GAP`（默认 1），就优先选它。

```typescript
let pick = firstRunnable
if (this.lastDequeuedAuthority !== undefined) {
  const firstPriority = this.entries[firstRunnable]!.priority
  // 第一阶段：同 priority 亲和（当前行为，保留）
  const samePriorAffinity = this.entries.findIndex((e, i) =>
    i > firstRunnable && e.priority === firstPriority
    && e.affinityKey === this.lastDequeuedAuthority && canRun(e),
  )
  if (samePriorAffinity !== -1) { pick = samePriorAffinity }
  else {
    // 第二阶段：相邻 priority 亲和（新增）
    const boostAffinity = this.entries.findIndex((e, i) =>
      i > firstRunnable
      && (firstPriority - e.priority) <= AFFINITY_BOOST_PRIORITY_GAP
      && e.affinityKey === this.lastDequeuedAuthority && canRun(e),
    )
    if (boostAffinity !== -1) pick = boostAffinity
  }
}
```

默认 `AFFINITY_BOOST_PRIORITY_GAP = 1`：priority 差 1 以内才提升（如 priority 5→4，不提升 priority 5→2）。

### 数据流

```mermaid
flowchart LR
    A[galaxy.createGalaxyTool] -->|requests[]| B[coordinator.delegateBatch]
    B -->|orders[]| C[WorkOrderQueue.enqueue]
    C -->|entries[].affinityKey = order.authority| D[enqueue 聚类排序]
    D --> E[priority desc → authority clusters]
    E -->|dequeue loop| F[canRun 过滤]
    F --> G{lastDequeuedAuthority}
    G -->|匹配| H[优先同 authority]
    G -->|不匹配| I[affinityBoost 相邻 priority]
    I --> J[出队 + 更新 lastDequeuedAuthority]
    H --> J
```

## 改动面

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/agent/work-queue.ts` | A: enqueue sort 加 authority 二级键 | 1 行 |
| `src/agent/work-queue.ts` | B: dequeue affinityBoost 第二阶段 | ~15 行 |
| `src/agent/work-queue.ts` | 常量 `AFFINITY_BOOST_PRIORITY_GAP` | 1 行 |
| `src/agent/__tests__/work-queue.test.ts` | A: 聚类排序测试 | ~10 行 |
| `src/agent/__tests__/work-queue.test.ts` | B: affinityBoost 测试 | ~15 行 |

总计约 40 行，不涉及其他模块。

## 权衡

### 收益

- 同 authority worker 连续出队，每对相邻可省 ~99% input token（384 tokens → 3 tokens cacheCreate）
- galaxy DP 副本场景最受益：副本 1 建缓存，副本 2..N 全命中（同 priority 下 tie-breaker 实测已满聚类 4/4，S2；mixed priority 形态下聚类排序提供跨档相邻收益，见「实测验证」「未来形态推演」）
- council 多席：同 authority 的约束席和平衡席天然聚类

### 代价

- affinityBoost 可能将 priority 略低（差 1）的同 authority 任务提前出队。这是可配置的（`AFFINITY_BOOST_PRIORITY_GAP = 0` 即退化为当前行为）
- 零副作用场景：所有 worker priority 相同时（galaxy 默认行为，生产现状），聚类排序实测与现状持平（S2/S3 相邻对不变）——但注意同 priority 下现状 tie-breaker 已满聚类，聚类排序无额外收益（见「实测验证」）

### 风险

- **饥饿**：如果同 authority 大量连续入队，跨 authority 的稍高 priority 任务可能被延迟。缓解：`AFFINITY_BOOST_PRIORITY_GAP` 限定了最大差距；priority 差 ≥ GAP+1 的场景不受影响。⚠ GAP 限差距不限次数——锚持续存在时，低 1 档同域任务可反复提前，跨域高 1 档任务被无限推迟（2026-08-01 实测：S5/S6 各 1 倒挂，见「实测验证」）
- **测试**：当前 `work-queue.test.ts` 已有 affinity 测试——确认这些测试在升级后仍然通过

## 瑶光反证

- **断言**："聚类排序不破坏 priority 语义" → 反证：构造 priority=[5(天权), 3(天机), 3(天权)]，验证出队顺序为 天权(p5)→天权(p3)→天机(p3) 或 天权(p5)→天机(p3)→天权(p3)。两种都合法——priority 5 第一个不变；priority 3 的聚类取决于第一个 p3 的 authority
- **断言**："affinityBoost 默认为 1 不造成饥饿" → ⚠ 原推导双重错误，2026-08-01 实测推翻（见「实测验证」节）：① p5 是天机不是天权（笔误）；② 实测 V0 出队为 天机5→天机4→天权4——出天机5 后锚=天机，tie-breaker 在同档 p4 内亲和命中天机4，"tie-breaker 不触发"前提错误；③ V2 实测为 天机4→天机5→天权4——affinityBoost 触发且把 p4 提到 p5 前（1 次倒挂），"affinityBoost 也不触发"同样错误。真实结论：boost 触发时相邻对收益为零（1=1）、代价是优先级倒挂；饥饿的真实形态是锚持续存在 + 同域低 1 档任务持续入队 → 跨域高 1 档任务无限推迟（GAP 限差距不限次数）。保守配置是 **GAP=0**（完全退化现状），而非"GAP=1 不触发所以安全"

## 实测验证（2026-08-01）

验证方法：基线 `work-queue.test.ts` 19/19 绿；模拟器复刻三种策略——V0（当前实现，与真实 WorkOrderQueue 逐行对齐并通过一致性校验）、V1（聚类排序）、V2（聚类 + affinityBoost），8 场景矩阵实测。相邻同 authority 出队对 ≈ 缓存命中对（D1 实测 384 tokens/对）。

| 场景 | V0 现状 | V1 聚类 | V2 聚类+boost |
|------|---------|---------|---------------|
| S1 galaxy 5维各1 worker | 0对 | 0对 | 0对 |
| S2 DP副本 2域×3 交错入队 | 4对 | 4对 | 4对 |
| S3 council 多席 | 1对 | 1对 | 1对 |
| S4 mixed priority（权5机5机4权4机3） | 1对 | 2对 | 2对/1倒挂 |
| S5 反证2场景 [机5,权4,机4] 锚=机 | 1对 | 1对 | 1对/1倒挂 |
| S6 [权5,机4,权4] 锚=权 | 1对 | 1对 | 1对/1倒挂 |
| S7 依赖阻塞 | 0对 | 0对 | 0对/1倒挂 |
| S8 大混合 3域×3副本 p2/1/0 | 2对 | 2对 | 4对/3倒挂 |

（倒挂 = 低 priority 先于高 priority 出队）

结论（收益条件视角——本设计面向未来实施，不以当前调用形态收窄设计空间）：

1. **tie-breaker 比原设计文档声称的强**：匹配范围是整档而非仅相邻；priority 全同形态下（当前生产恒为 0）同档即全队列，S2 交错入队实测 4/4 满聚类，**当前实现已达成同 priority 形态的最优聚类**。原「瓶颈场景 2」（同档无同 authority 候选）仅在 mixed priority 形态下成立；「典型 galaxy 场景 5 维各 1 worker」是无解数据形态（各域仅 1 worker，V1/V2 同为 0 对），不宜作为瓶颈论据。
2. **升级 A（聚类排序）的收益条件是 mixed priority 形态**：同 priority 下与现状持平（S2/S3 无差异，零副作用）；mixed priority 下产生跨档相邻收益（S4: 1→2 对，+384 tokens）。未来一旦引入差异化 priority（紧急插队 / per-task priority，见「未来形态推演」），聚类排序直接生效——**无需前置条件，建议保留在 Wave 1**。
3. **升级 B（affinityBoost）收益与代价同源**：每多 1 对跨档相邻对应 1 次优先级倒挂（S8: +2 对 = +768 tokens、3 倒挂；S5/S6/S7: 收益为零或更差、纯倒挂）。在 priority 全同形态下同档亲和恒命中，boost 永不触发；在 mixed priority 形态下收益与倒挂并存——**是否开启取决于未来优先级语义的严格度**（见「未来形态推演」的三种来源与设计匹配）。

修订落点：瓶颈章节按本表改写；反证 2 已重写；Wave 1（聚类排序）保留立即生效；Wave 2（boost）默认 `GAP=0`，开启时机由「未来形态推演」的触发条件决定。

## 未来形态推演（mixed priority 的来源与设计匹配）

实测表明两个升级的收益条件都是 mixed priority 形态。该形态何时真实出现？三种可能来源，各自特征不同、对设计的匹配度不同：

| 来源 | 特征 | 与升级 A（聚类） | 与升级 B（boost） |
|------|------|------------------|-------------------|
| A. 紧急任务插队（用户中断 / 高危修复，单任务高 priority） | 高档任务数量少，低档同域任务多 | 收益小（高档无同域可聚） | 收益小（跨档相邻机会少），倒挂影响也小 |
| B. delegateBatch / team 支持 per-task priority（同域任务分布在多档） | 同域任务跨档分布，S8 形态 | 收益中等（档内聚类） | **收益最大**（+2 对/批），倒挂也最频繁——最需要倒挂控制 |
| C. wave 分波加权（plan 波次优先级递增/递减） | 档间天然有序，同域任务多在波内同档 | 收益中等 | 非必需（波内已同档，same 阶段即可命中） |

来源 A/B 出现前，Wave 2 保持 `GAP=0`。来源 B 落地时需同时引入倒挂控制，三个可选设计：

1. **全局常量 GAP**（文档现状）——最简单，但"限差距不限次数"（锚持续存在时低 1 档同域任务可反复提前）
2. **per-tool 配置 GAP**（开放问题 2 原案）——galaxy 可设 gap=2，team 设 gap=0，按场景取舍
3. **老化机制（aging）**——低档任务等待超阈值后强制出队，把"限差距"升级为"限差距 + 限时长"，彻底消除饥饿；复杂度最高（需维护等待时间戳）

**暂定**：Wave 1 落地（聚类排序，无条件收益或零副作用）；Wave 2 随来源 B 落地时以选项 2 或 3 配套实施，不单独以 GAP=1 全局开启。

## 实施

### Wave 1：升级 A（聚类排序）→ 立即生效

1. 改 `enqueue` 的 sort 比较函数
2. 写测试：同 priority 不同 authority → 验证同 authority 相邻
3. Typecheck + `work-queue.test.ts` GREEN

### Wave 2：升级 B（affinityBoost）→ 随 mixed priority 形态落地，默认 `GAP=0`（2026-08-01 实测修订）

1. 加 `AFFINITY_BOOST_PRIORITY_GAP` 常量（默认 0 = 完全退化现状）
2. 扩 `dequeue` 亲和逻辑
3. 写测试：同 authority 相邻 priority 的优先出队（含倒挂断言）
4. Typecheck + `work-queue.test.ts` GREEN
5. ⚠ 开启前置条件：mixed priority 形态的触发条件出现（见「未来形态推演」来源 A/B，即紧急插队或 per-task priority 落地）——priority 全同形态下 boost 永不触发；来源 B 落地时须配套倒挂控制（per-tool GAP 或老化机制），不单独以 GAP=1 全局开启（实测数据见「实测验证」）

### 回退

`AFFINITY_BOOST_PRIORITY_GAP = 0` → 完全退化为当前 tie-breaker 行为。升级 A 的聚类排序不受此常量控制——它不改变 order，只改变同 priority 内的排列，语义等价于当前行为。⚠ 实测聚类排序确实改变出队物理顺序（S1: tianquan→tianji→… 变为 tianfu→tianji→…，字母序），同 priority 下语义等价（S2/S3 相邻对不变，见「实测验证」）。

## 开放问题

0. **mixed priority 何时真实出现？** 这是 Wave 2 开启时机的前置问题——三种可能来源（紧急插队 / per-task priority / wave 分波加权）及各自设计匹配见「未来形态推演」。**暂定**：来源 A/B 落地时再评估，当前不预设。

1. authority 聚类键是否该用 `localeCompare`（字母序）还是有更好的启发式？字母序简单但不可预测——`tianji` 在 `tianquan` 之前，但哪个先出队不重要，相邻才重要。**暂定**：字母序。

2. affinityBoost 的 priority gap 是否该由 galaxy 配置而非全局常量？例如 galaxy 场景可设 gap=2，而 team 场景设 gap=0。**暂定**：先做全局常量（默认 0），来源 B（per-task priority）落地时升级为 per-tool 配置或老化机制（见「未来形态推演」）。
