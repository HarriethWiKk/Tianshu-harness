# 2026-07-25 前缀块开关配置层（prompt.profile）

## 背景

诉求原话是「给主控做加载的提示词做瘦身……胶囊先只挂最小集合，其他作为配置项按需开启」。
两轮澄清后目标收敛为**减轻注意力稀释**而非省钱——实测 cacheRead 层 12032 token 已被缓存，
成本只有全价十分之一，但缓存命中不减少模型要读的字数。

调研先推翻了原始假设：胶囊早已是 recall-only 的 gist 索引（899 字符，占首轮输入约 1.5%），
不是有效靶子。真正的大头是工具 schema 与 `static.ts`，而后者是行为护栏，动不得。

## 实测基线（本仓库，minimal 工具档）

改动前 frozen 前缀 39820 字符：

| 块 | 字符 | 占比 |
|----|------|------|
| 工具 schema | 13699 | 34.6% |
| static.ts BASE_PROMPT | 13170 | 33.3% |
| project-instructions | 8000（原始 14264，截 44%） | 20.2% |
| knowledge-manifest | 1954 | 4.9% |
| project-memory | 1517 | 3.8% |
| seed-capsule 索引 | 899 | 2.3% |
| star-domain volatileBlock | 367 | 0.9% |

护栏 13537 / 参考 12370 / 工具 13699 —— 三类几乎均分。

## 变更

### 块三分法（本次的核心决策）

- **刹车类**：`static.ts` 的 rules / delivery-contract / workflow / security / tool-usage，
  星域 volatileBlock 与 suffix。**没有开关，档位永不影响。**
- **参考类**：capsule 索引 / knowledge-manifest / codebase-index / project-memory /
  historical-lessons。`lean` 档缩减或关闭，都有 recall 通道兜底。
- **工具描述**：独立 `full | compact` 开关。是操作手册不是护栏。

分界线来自 V3.1：`0c776b9` 把胶囊正文改成按需 recall，同日 `17b496a` 回滚，
commit 记录根因「behavioral guardrails must be RESIDENT, not on-demand」。

### 新增

- `src/prompt/block-policy.ts` — 四层优先级解析（env > 项目 > 用户 > `standard`）+ 会话内冻结。
  `FROZEN_BLOCK_CAPS` 从 `volatile.ts` 迁来（它就是 standard 档的定义），`volatile.ts` re-export 保持兼容。
- `src/prompt/prefix-budget.ts` + `scripts/prefix-budget.ts`（`npm run prefix:budget`）—— 分块归因。
  脚本走真实装配路径并与实际前缀对账，偏差 >15% 告警。
- `src/tools/description-compact.ts` — 保留式压缩：首段 + 每个标题及其首行 + 所有硬门禁行。
- TUI `/prefix-budget` — 会话内查看当前档位与各块占比。
- `config.prompt` 节：`profile` / `toolDescriptions` / `blocks.*`。
- `docs/user-guide-prompt-profile.md`。

### 修改

- `volatile-snapshot.ts` 消费 policy 决定加载哪些块、用什么 cap；显式传入的块不受档位影响
  （档位管「自动加载什么」，无权丢弃调用方明确要求注入的内容）。
- `gateToolDefinitions` 接管描述档位。**放在门控里而非各调用点**是关键：构造期与
  `updateTools()` 若用不同变换，MCP/LSP 异步注册后描述会回弹成 full → system 字节
  中途翻转 → 整段前缀缓存 miss。
- `plan` 工具描述与 `<plan-mode>` appendix 去重，3011 → 2635 字符（−12.5%）。
- 14 条 seed capsule 的 gist 压缩措辞，638 → 587 字符。

## 缓存影响

`standard` 档的**配置层部分**零字节变化。逐块对账（`prefix:budget --json` 快照 diff）：

```
工具 schema      13699 -> 13323  (-376)   plan 描述去重
seed-capsule 索引   899 ->   848  (-51)   gist 压缩
static.ts / star-domain / project-instructions / knowledge-manifest / project-memory  逐字节不变
明细差值合计 -427 == 真实前缀差值 -427（完全归因，无隐藏变化）
```

护栏类一个字节没动。两处内容改动是**有意的**，会让所有用户 miss 一次前缀缓存（之后恢复）。
合计 39820 → 39393 字符。

## 实测收益与预估的偏差

计划预估 plan 描述去重能省 1200-1500 字符，**实际 380**。原文重复量没有预估的那么大。

`compact` 档在当前工具集下**只命中 plan 一个工具**（−254 字符）——其余工具的 JSON 虽然
超过 800 字符阈值，但 description 正文最长的 todo 也只有 572。工具 schema 的大头是
JSON 结构本身（name/type/properties/required），不是描述文字。降阈值收益边际递减、
风险不成比例，故保持 800；机制已就位，未来出现超长描述会自动生效。

`lean` 档在本仓库把前缀降到 38494 字符（−3.3%）。收益随项目知识文件规模放大。

诚实的结论：**这一轮建的主要是可观测性与开关机制，不是大幅瘦身。**
真正的两个大头——工具 schema 结构与 static.ts 护栏——一个受 JSON 格式约束，
一个受行为安全约束，都不是措辞优化能解决的。

## 途中修掉的两个真实缺陷

1. **胶囊索引截断可能反向增重**：胶囊少或 gist 短时，「其余 N 位（…）」尾行比省掉的
   行更长。现在只在真能省字节时才截断，否则返回全量。
2. **compact 曾让 plan 的 `exit_mode` 整个消失**：该章节正文用「不修改」措辞，不命中硬门禁
   正则，标题因此被判为空章节一并删除——等于该 action 从工具契约里消失。
   规则改为「每个标题带上首行正文」，标题定义的是工具动作词汇表，不能丢。

## 防线

`block-policy.test.ts` 锁死无配置时返回 `standard`，并断言 `blocks` 的键集合恰好是五个
参考类块——防止有人「顺手」把护栏加进开关。默认值不要改成 lean：那等于绕过全部防线重演 V3.1。

## 验证

- `npm run typecheck` 绿
- `src/prompt` 439 + `src/config` + `block-policy` 22 + `volatile-snapshot-policy` 12 +
  `description-compact` 17 + `seed-capsule-store` 29 全绿
- `src/tools` 全套 9 个失败，与 HEAD 基线（独立 worktree）逐条对照：7 个基线同样失败，
  2 个是超时敏感的 diff 测试（`edit-diff.ts` 未被本次触及、不依赖任何新模块，单独跑会挂起）
- `standard` 档 `prefix:budget --json` 与配置层落地前逐字节相同
- `lean` 档下 `src/prompt` 全套（含 `engine-cache-stability`）449 个全绿——档位不破坏缓存稳定性不变量

## 遗留

**lean 档的质量代价未实测。** 计划把它列为「待验证假设，不预设结论」，理由是
`.rivet/knowledge/天枢现状复盘-2026-07-01.md` 记载过子代理去人格化的 A/B 结果是
100% vs 80%——瘦身有可测量的质量代价。

完整对照需要 10 个编码任务 × 2 档 = 20 次完整会话，有实际 API 费用且耗时小时级。
经与需求方确认**暂不执行**：lean 是 opt-in，当前无用户使用，等有人真正切档再测更有意义。
dry-run 通路已验证可用：

```bash
npm run benchmark -- --dry-run                      # 确认任务集
RIVET_PROMPT_PROFILE=standard npm run benchmark
RIVET_PROMPT_PROFILE=lean     npm run benchmark
```

在此之前，`lean` 应视为「已实现但未验证质量影响」的实验档位。
