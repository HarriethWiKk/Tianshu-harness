---
title: 星河收编落地与实测验证记录——七项收编全落地、审查修复链、路由学习闭环实测
type: changelog
status: done
date: 2026-08-01
stage: D3
related:
  - docs/design/2026-08-01-galaxy-mechanism-convergence.md
  - docs/plans/2026-07-31-galaxy-prewarm-and-cache-affinity.md
  - docs/3.0/D1-moe-galaxy-deepseek-synergy.md
---

# 星河收编落地与实测验证记录

> 收编设计（`docs/design/2026-08-01-galaxy-mechanism-convergence.md`）的七项机制经 Wave 1-3 落地、两轮审查修复后全部接通生产；路由学习经真实任务两轮冒烟验证闭环。本文存档落地链、审查发现与修复、实测证据与遗留。

## 落地链全景

| 阶段 | 提交 | 内容 |
|------|------|------|
| Wave 1 | `706bc5fc` | quorum 一等聚合策略 + DP 证据冗余（redundancy 义务 + deliver_task 门禁） |
| Wave 2 | `5d8020c4` | 批级共享信息素、调度亲和、路由学习（GalaxyRoutingRecord） |
| Wave 3 | `5e6c1afe` | DAG 条件依赖边（skip/alternate）、council/team 两阶段确认 |
| 自愈 1 | `43c99ad0` | quorumK 公式两处不一致（聚合侧 ceil 残留 → 统一 floor(n/2)+1） |
| 自愈 2 | `ec5fe5ac` | delegate-batch `.options` 在 ZodUnion 上产出垃圾 enum → `aggregationPolicyKinds`；条件边生产入口 |
| 审查修复 | `888a1303` | 本文「六项修复」节（9 文件 +177/-15） |
| 冒烟修复 | `b98d907c` | hook 超时/慢双报修复（瑶光副本 RED 复现驱动） |

## 审查发现与六项修复（`888a1303`）

审查方式：三个 Wave 各派独立子代理深审 + 逐条读码坐实。关键教训：**「测试全绿」不等于「生产可达」**——两条链路只有 mock 注入可达，生产装配点未接线。

| # | 问题 | 修法 |
|---|------|------|
| ① | DP 证据冗余生产不可达（无声明点、无 store 注入） | `RuntimeRefs.obligationTrackerRef`（`createAgentRuntime` 回写）；deliver_task 生产注入 `getObligationStore`；galaxy DP 派发创建 quorum 义务（risk=high），副本 verified 各计一次独立证据 |
| ② | 路由学习生产不可达（两装配点未传 `domainKnowledgeStore`） | 三装配点接通：TUI 经 `domainKnowledgeStoreRef` 惰性 getter（/cd 随动）、sidecar 经 SharedRuntime 回写、headless per-session 建库 |
| ③ | redundancy 计数不去重（同一验证命令绿两次满足 k=2）+ 测试名实相反 | `satisfyCount` 按独立证据计；测试改断言「重复不计 + 独立第二证才关闭」 |
| ④ | stigmergy `_dirty` 清在写盘前（EPERM 静默丢 pending） | 恢复写成功才清；内存模式提前 return |
| ⑤ | taskShape 自由文本（胜率稀释成精确重名匹配） | 限定枚举 impl/review/explore/plan/docs，经 `mapDimensionToKind` 两跳推导 |
| ⑥ | team 预览/执行分波参数不一致（maxTeamParallel≠3 时展示≠真相） | 预览不再传 options，与执行对齐 |

新增 3 条 DP 冗余义务端到端测试（galaxy.test.ts 18/18）；相关 282 项测试全绿 + tsc 干净。

## 实测验证（headless，v4-flash）

**run1**（审查 runtime-hooks 超时护栏，review 瑶光 + research 天璇）：
- 路由记录落盘 `.rivet/knowledge/galaxy-routing.jsonl`；taskShape 已是枚举（research → doc_research → docs，⑤ 在线生效）
- 意外产出：瑶光副本对 hook 护栏提出两条断言，其一 RED 复现成立——生产默认 timeout 10s > slow 2s，每次超时必双报 `[hook-timeout]` + `[hook-slow]`，用户 onError 钩子对同一事件触发两次。headless 主会话修复（timedOut 跳过 slow 上报），提交 `b98d907c` 并补生产比例回归用例

**run2**（同形状任务，新进程，仅 confirm:false 展示方案）— proposal 出现历史路由：

```
历史路由（同任务形状 · 按 authority 聚合胜率）：
  yaoguang @ review: 1/1 通过（100%）
  tianxuan @ research: 1/1 通过（100%）
```

沉淀（run1 写入）→ 跨进程召回（run2 新会话读出）闭环完整。

## 证据链方法学记录（本次评审-修复循环的复用价值）

- **「绿非证明」在副本形态下加强**：冒烟中双瑶光副本独立得出同结论仍自我降级 unverified（无法动态复现不宣称）——收编 #2 的制度化正是基于此实证
- **审查要区分「注入发生」与「注入生效」**：P0 prewarm 断裂（`46e66728`）与本次两条死链路同型——测试只断言到 config/接口层，生产装配未接线。审查清单应固定包含「生产装配点可达性」一项
- **夹带变更要申报**：Wave 1 夹带的 tierTimeoutMultiplier 行为变更（后 `835239c3` 返工）提示多主题提交必须在提交信息中显式声明所有行为面

## 遗留（已知、有意保留）

- 调度亲和正向重排路径缺测试（变异存活——功能实测正确，缺 `a(瑶光),b(天机),c(瑶光)→a,c,b` 用例）
- coordinator 批级信息素测试存在位置敏感断言（并发负载下 flake 类别，按 order id 断言可根治）
- DAG 多层递归未做（计划内：两层先跑稳）；team/plan 波次逻辑不迁移
- galaxy 自算 quorum 并对 aggregation 注记文案做正则解析（脆弱耦合——组级结论进 `CoordinatorRun` 结构化字段后可删）
- `flushRoutingDirty` 锁内不重读合并（多进程丢胜率样本，咨询性数据）
- D1-3 级联 Tier 推测（quorum 未达成自动 escalate strong）为 spec 待评估（`docs/3.0/D1-3-cascade-tier-speculation.md`）
