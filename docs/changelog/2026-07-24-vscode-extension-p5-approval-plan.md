# VS Code/Cursor 插件 P5 — 审批 + Plan Mode 深化（2026-07-24）

> 承接 [P0–P4 迭代记录](2026-07-23-vscode-extension-p0-p4-iteration.md)。版本 v0.3.0 → v0.4.0。
> 全部改动限定 `vscode-extension/`；server REST 均为现成能力，未动内核。

## 缘起

Cursor 实机测试发现两个表层现象：① 首条消息完成后弹
`POST /sessions/:id/steer → 409` 错误条；② 看不到审批模式与 plan 模式。
排查结论：② 主因是 Cursor 里装的仍是 0.1.0 旧包（P4 功能没装上），
但对照桌面端，审批与 plan 两条线的交互深度也确实不足——协议字段早就备好，
UI 一直没接上。

## steer 409 根因与修复（v0.3.0 补丁，先行落地）

server 在 run 收束时只发 `done` 事件（`src/server/session-manager.ts:1812`），
不再发 `status: idle`；webview reducer 只认 `status` 事件，`done` 被 default
分支忽略 → `chat.status` 永远滞留 `running` → 下一条消息误判为运行中插话发去
`/steer` → server 空闲态回 409。桌面端无此问题（reducer 处理 `done` 且 steer
遇 409 回退 prompt）。

修复（对齐桌面端两处范式）：

- `webview-ui/src/model.ts`：reducer 新增 `case 'done'` 落终态（缺字段回退 idle）
- `src/sidecar/client.ts`：`steer()` 返回 `'queued' | 'idle'`，409 不抛错
- `src/views/cockpit-provider.ts`：steer 收到 `idle` 自动回退 `prompt` 开新
  turn（覆盖"提交瞬间 run 恰好收束"的残余竞态）
- `tests/model.test.ts`：done 事件回归用例

## P5 功能项

| 能力 | 落点 | 说明 |
|------|------|------|
| 审批卡 editedInput | `App.tsx` ApprovalCard | 「改参数…」展开 JSON 编辑，解析失败 fail-closed 不发送；批准时回传修改后入参 |
| 审批卡 remember | 同上 | 「记住本次会话同类决策」checkbox |
| Plan 多方案 | `App.tsx` PlanCard | `options≥2` 渲染 radio，批准回传 `selectedApproach`（label，对齐 `PlanPanel.tsx`） |
| Plan 编辑 | `client.ts` editPlan → `PUT /plans/:slug` | 仅 submitted 可编辑（server 409 闸门）；保存后宿主重推 plan 刷新 |
| 手动 plan-mode | `client.ts` setPlanMode → `POST /plan-mode` + Toolbar「📋 计划」按钮 | 状态由 `plan_mode` SSE 事件驱动，无本地臆测 |

桥架构不变：webview 不直连 sidecar，新能力只加消息类型（approval 加
editedInput/remember 字段；新增 editPlan / setPlanMode 消息），token 不进 webview。

## 验证

- `tsc --noEmit` ✅ · 双 bundle 构建 ✅ · `node --test` 12/12 ✅
- 已重打 `tianshu-vscode-0.4.0.vsix`（含 P4 全部能力 + 本轮修复），
  Cursor 实机验收（审批改参数/remember、多方案、计划编辑、手动 plan-mode）待用户确认

## 遗留

- Cursor/VS Code 实机验收清单见上；旧 0.1.0 包需手动从 VSIX 换装
- 沿用上一轮「明确不做」：图片粘贴、会话搜索/归档、token/成本、walkthrough、
  SSE 增量重放/虚拟化、FIM、市场发布（billing 锁定未解）
