# 2026-07-30 /scout 巡天侦察蜂群 + T5 计划坍缩修复

## 背景

社区用户在天枢上用现成积木（`delegate_batch` + `code_scout` + 星域 authority）自行
包装了「星河集群」轻量并行诊断工作流：先摸底 → 按维度切三个只读 scout → 汇总成带
✅ 的实测核对清单 + 启动 runbook。截图里的层级树 / per-worker 工具与 token 计数 /
`/tasks` 面板全是 TUI 原生渲染——用户补的是**方法论包装层**，而这层收编成本最低。
该用户还给出一条选型准则：team 与轻量并行的分界是**是否需要计划文档作为长期资产**。

本轮同时修掉 07-29 team e2e 实测遗留的 T5 缺陷
（`docs/analysis/2026-07-29-team-mode-e2e-repro-and-gaps.md` §四 #5）。

## 一、/scout 巡天侦察蜂群工作流

仿 `/team`、`/council` 的 prompt 模板工作流（`ecosystem-workflows.ts`），无新工具：

- `/scout <诊断目标> [--dims 前端,后端,集成]`；`--dims` 缺省由模型按仓库形态自选
  2-5 个维度，上限 5（delegate_batch 单批上限）。
- prompt 契约四步：①先侦察后派发（内联摸底，一句话报技术栈与维度）②按**关注维度**
  切分而非文件分片（集成一致性类维度天然跨模块——诊断的正交是问题维度正交，不是
  文件集不相交）③一次 delegate_batch 全部派出（code_scout 只读 + 各配星域
  authority + 深侦察显式 `timeoutMs: 900000`）④交付实测核对清单 + runbook——每项
  ✅/❌ 必须带证据（exit code / 逐一比对数量 / file:line），构建类验证主控亲自实跑，
  拿不出证据标「未验证」。
- 修复出口：发现问题先问用户，确认后把清单喂 `plan_task` 走计划-执行链
  （batch → team 正向互操作）。
- `delegate_batch` 在 CORE 层 → 不声明 `requiredTools`。

**附带收口**：`/team`、`/council` 的 `requiredTools` 声明还停留在 T3 修复前——
`team_orchestrate` 已升 CORE 却仍被声明为需挂载工具（继续声明会把用户显式 deny 的
工具强行挂回），据此 `/team` 不再声明、`/council` 只声明 `council_convene`。
锁 EXTENDED 层成员资格的测试（`ecosystem-workflows.test.ts`）在 HEAD 上本就红着，
本次一并转绿。

## 二、委派选型教义进 static prompt

`<delegation>` 块新增「并行编排选型」段：判断标准是**是否需要计划文档作为长期资产**
——要写文件/留计划/门禁 → `plan_task` + `team_orchestrate`；只要这一次并行加速
（诊断/侦察/体检）→ `delegate_batch`。附一句诊断交付契约（实测清单，非转述）。

字节影响：static prompt 变更 = 一次性前缀重建（golden hash 已按协议更新，
`static-subagent.test.ts` 注明变更原因；运行时 `prompt-version-warning` 自动提示
用户新开会话）。

## 三、T5 归因与修复：多任务计划坍缩成单任务单波

### 归因（复现测试钉死，`src/agent/__tests__/plan-collapse-t5.test.ts`）

三个嫌疑点逐一排查：

| 嫌疑点 | 结论 |
|--------|------|
| plan-store sessionId 桥接 | **排除**——同 sessionId 逐字节还原；不同 sessionId 返回 null 且 team 侧硬拦报错（fail-loud，不静默降级） |
| UnifiedPlan → TeamTask 转换 + groupTeamTasks 分波 | **排除**——1:1 映射；7 任务经分波全量覆盖不丢不并 |
| `decomposeObjective` 对 files 缺席的退化 | **真根因** |

根因形状：**新建文件类任务的 scope 文件还不存在，模型合理地不传 `files`——而启发式
分解器完全依赖 `files` 分片，缺席时静默退化成单个 monolith 分片（`files:[]`）**。
e2e Run 4 观察到的「单任务单波 + Scope Health leaked」正是这个形状。坍缩发生在
**计划生成侧**，不在桥接/分组链路——analysis 文档原先的「进 team 后被坍缩」措辞
是错误归因。

### 修复（`task-planner.ts`）

`files` 缺席时从 objective 文本恢复分片信号（显式 `files` 永远优先，不二次猜测）：

1. **编号清单分片**：objective 含 ≥2 个编号条目（`1.` / `2)` / `3、`）→ 每条目
   一个自包含分片，scope 取条目中点名的文件路径（上限 8 片）；
2. **正文路径提取**：无编号清单但正文点名文件路径（`(?:dir/)+name.ext` 形状，
   要求至少一层目录避免把 `node:test`、裸 `.mjs` 误抓）→ 提取为 scope 走既有
   模块分组；
3. 两者都无 → 维持既有单分片行为（不误伤）。

### 同族修复（`team-grouping.ts`）

`isTestFor` 只认 `.ts/.tsx` → `.mjs/.js` 的 source+test 对永远绑不回同一分片，
两个写工在同一波竞速。改为扩展名无关（仅 `.test.<ext>` 后缀标记测试文件，
非测试文件的扩展名剥不掉、不会误绑）。

### 回归

- 单元：10 用例（嫌疑点 pin ×4 + 根因修复 ×4 + .mjs 绑定 ×2）
- 端到端（`plan-orchestrate-bridge.test.ts`）：7 任务多波 UnifiedPlan 经
  `storePlan → team_orchestrate` 原样到达派发层（3 波、7 任务全在列、wave 0 只派
  scout）；编号清单目标（无 files）经 `plan_task → team_orchestrate` 并行派发
  3 分片——修复前这条链路的产物是 1 个 monolith。

## 遗留

- e2e 沙箱复测（真实 sidecar + SSE 观测）未跑——本轮回归全部在单元/集成层，
  analysis 文档 §七 的观测命令可随下次 team 实测一并复核。
- `--dims` 指定超过 5 个维度时静默截断，未回显提示。
- moduleKey 对两段路径（`dir/file.ts`）返回含文件名的 key（每文件一片）——对平铺
  目录是过度分片，因 source+test 绑定修复后实际后果可接受，未动语义。
