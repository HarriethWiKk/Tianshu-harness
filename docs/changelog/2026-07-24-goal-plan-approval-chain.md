# Goal 模式计划审批链路修复 + 倒计时自动批准（2026-07-24）

> 三环根因：事件断链（死代码）+ goal 循环审批盲 + 透出缺失。
> 内核改动：`src/server/` + `src/agent/`；桌面：`desktop/src/`。

## 用户反馈

goal 模式下模型创建计划后需要审批，但右栏折叠时会话区无任何提示，
goal 看似死掉——用户困惑"为什么开了 goal 还需要审批"。

## 根因链（调查坐实）

1. **事件断链（2026-06-23 起）**：`session-manager.ts` 在 `onToolResult` 里按
   `name === 'plan_submit'` 补发 `plan_submitted` SSE，但工具早已合并改名为
   `plan`（`src/tools/plan.ts`）——该检查是死代码，`plan_submitted` 从不发射。
   后果：会话内 PlanApprovalCard 永不出现、右栏自动展开永不触发、
   mission-projector `awaiting_approval` 不可达、approvePlan 的 approved
   离场转移也不可达。**所有计划审批受影响，不止 goal 模式。**
2. **goal 循环审批盲**：计划提交后 `GoalContinuationController.handleGoalCheck`
   无"等待审批"检查，每轮末注入 [GOAL CONTINUATION] 空转烧 iteration；
   `session.running` 恒 true → 批准 API 被 409 拒绝——用户想批都批不了。
3. **透出缺失**：GoalBar 无"等待审批"状态；右栏折叠时计划零可见性。

## 修复（P1-P4）

### P1 — 断链修复（一切前提）

- `onToolUse` 登记 `plan` 工具 `action=submit` 的 toolId，`onToolResult`
  按登记精确识别（其它 action 不误发），替换死代码名检查。
- `approvePlan` 补发 `plan_submitted{status:'approved'}`——projector 离场转移
  与各端审批卡清除都消费它（此前只有 reject/edit 路径发）。

### P2 — goal 循环审批感知（止血）

- `GoalContinuationDeps` 新增 `hasPendingPlanApproval` 探针（`loop-factory`
  注入，读 plan-store 最新计划状态；读失败 fail-open——宁可空转不可假死）。
- `handleGoalCheck` 在 tracker.check() 前加闸门：最新计划为 `submitted` 时
  走 finalize 不续跑（goal 保持 active、不计 iteration）。
- 效果：提交计划后 run 正常收束 → `session.running=false` → 批准 409 解除；
  批准后 kickoff 轮末自然恢复续跑；驳回（rejected ≠ submitted）同样放行。

### P3 — 服务端倒计时自动批准（复刻 watchdog C2 刹车模式）

- **武装**：`plan_submitted` 发射时若本会话 goal 激活 → 发
  `plan_auto_approve_pending { slug, deadlineMs, delayMs }` 并开可取消定时器，
  默认 **150s**（`RIVET_GOAL_PLAN_AUTO_APPROVE_MS` 覆盖，0=关闭）。
  **非 goal 会话不武装**——普通 plan mode 保持纯手动审批。
- **取消**（用户任何参与即停）：approve / reject / PUT 编辑 / 新 prompt /
  steer / abort / 显式路由 `POST /sessions/:id/plans/:slug/auto-approve/cancel`
  → 发 `plan_auto_approve_cancelled { slug, reason }`。
- **触发**：到期复核守卫（未运行 / 未归档 / goal 仍激活）后走 approvePlan
  同路径（内容校验 + 锚点复查 + kickoff 注入），批准成功 goal 自然续跑。
- 定时器 `unref` + sidecar 重启后丢失语义 = 退化为普通手动审批（无卡死）。

### P4 — 桌面透出

- `event-reducer`：消费两个新事件维护 `planAutoApprove { slug, deadlineMs }`；
  终态/plan_mode off 同步清除。
- `PlanApprovalCard`：有 deadlineMs 时显示「⏳ Goal 模式：N 秒后自动批准执行」
  秒级倒计时 +「查看计划」按钮（调取消路由 + 展开右栏）——倒计时卡本身就是
  会话区审批提示。
- `GoalBar`：mission phase `awaiting_approval` 时显示「⏸ Awaiting plan
  approval」chip（projector 早已产出该 phase，P1 修复后可达）。
- 右栏折叠 → 提交即自动展开（`latestPlanSlug` 机制随 P1 复活）。

## 测试

- server：`session-manager-goal.test.ts` +4（武装/非 goal 不武装/到期触发/
  取消不触发）；`session-tool-result-coalescing.test.ts` 旧名改新 + 登记式
  submit 路径；`turn-orchestrator-goal.test.ts` +2（待批 finalize / 无待批续跑）。
- desktop：`event-reducer.test.ts` +2（倒计时生命周期 / slug 不匹配不误清）。
- 根仓 + desktop `tsc --noEmit` 全绿；桌面全量测试通过。

## 语义边界（设计决策）

- 自动批准**仅 goal 模式**——approval 门在普通场景的意义不变。
- "静默"只发生在用户看过之后不反对：倒计时在会话区可见可取消，
  任何参与（含点「查看计划」）即停止自动批准。
- `RIVET_GOAL_PLAN_AUTO_APPROVE_MS=0` 整体关闭。

## TUI 实现（同日收束）

> 纠正：本文件此前称"TUI 不消费也被自动批准覆盖"是**错的**——纯 TUI 走
> 进程内 AgentLoop，不经 session-manager，P3 定时器在 TUI 不会触发。
> 已补 TUI 原生实现，与 sidecar 语义逐条对齐：

- **纯逻辑层** `src/tui/plan-auto-approve.ts`：env 解析（同
  `RIVET_GOAL_PLAN_AUTO_APPROVE_MS`，默认 150s/0 关）、shouldArm /
  remainingSec / shouldFire 守卫判定，可单测。
- **TuiApp 机制**（`src/tui/engine/app.ts`）：arm/cancel/fire + 1s tick
  驱动倒计时重绘；dispose 清理。取消点：批准/驳回 exec、进入驳回反馈
  输入子模式、新用户提交、用户主动 abort；**Esc 收起面板不取消**——
  倒计时退到 GlanceBar 徽章继续走（Esc ≠ 决策，只是收起）。
- **展示两态**：overlay 开 → 标题区倒计时行「⏳ Goal 模式：Ns 后自动批准
  （批准/驳回即取消；Esc 收起不取消）」（provider 每渲染重算，零 renderer
  侵入）；overlay 关 → GlanceBar「⏳ 自动批准 Ns」warning 色徽章。
- **触发**：`onPlanAutoApproveFire`（main.ts 装配）→ 默认方案（Recommended
  否则首个）→ `approvePlanAndKickoff` → scrollback 通知。

## 遗留

- `src/agent/star-domain.ts` 14 处 `plan_submit`/`plan_close` 死白名单（无功能
  影响，hygiene 另清）。
- GoalBar 的 goal.* 文案走 inline defaultValue（英文），zh-CN locale 无对应
  键——历史遗留，未在本轮处理。
- sidecar 重启后倒计时丢失：goal 停住 + 计划仍 submitted，用户手动批准即可。
