# 设计：安全审查 层2/层3（Stop-LLM 审查 + commit 跨文件审查）

状态：**设计存档，未实现**。层1（正则告警 hook）已落地并提交（commit b13c4f2b）。
本文记录层2/层3 的探查结论与推荐方案，供日后实现。

## 背景

移植官方 Claude Code security-guidance 插件的三层能力：
- **层1**（已做）：postTool 正则告警。`security-patterns.ts` 25 条规则 +
  `security-pattern-hook.ts`，gate `RIVET_SECURITY_GUIDANCE=1`（默认关）。
- **层2**（本文）：Stop 时对本轮 git-diff 做 LLM 安全审查。
- **层3**（本文）：commit 时 agentic 跨文件安全审查（IDOR/越权/跨文件 SSRF）。

用户追加要求：
1. LLM 审查用 **deepseek-v4-flash 子代理**作为默认审查模型。
2. 安全审查门**默认 off**，用户可手动开启 review（只针对新的安全审查，
   不动现有 `RIVET_REVIEW_DISCIPLINE`——那个保持默认 on）。

## 关键探查结论（改变了原计划形态）

原计划想"独立新建两层"。但探查发现**项目已有大量可复用基础设施**，独立新建会
与现有 review 系统重叠/冲突。推荐**复用现有 review 链**。核心事实：

1. **「安全审查」inspector 已存在** — `review-coordinator-deps.ts:268-296`
   的 INSPECTORS 数组第一个就是「安全审查」，objective="审查认证、授权、路径
   校验、密钥泄露、fail-open/fail-closed"，stances=`['pathBoundary']`。
   **但它只在 L3 squadron 跑**（`spawnSquadron`），auto 模式的
   `spawnWiringReviewer`（:473-499）只跑接线+静默两个 inspector。

2. **审查子代理已锁 cheap 档** — `profile-registry.ts:87-98` 的 `reviewer`
   profile 有 `tierLock: 'cheap'`。auto 审查注释（:477）明说 "Flash models are
   reliable enough at these focused axes"。config `workers.profiles` 已有
   `'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' }`
   （default.ts:233）。→ "用 flash 子代理审查"接线点在此。

3. **detached review + 投递链已完整** — deliver-task.ts:1024-1364 的
   post-commit review 全部后台 detached（`launchDetached`），结论经
   `enqueuePostCommitReviewOutcome` → `post-commit-review-hook` →
   AdvisoryBus 注入。**层2/层3 的"投递"半边已经现成**。

4. **交付门 fs 复扫是权威模式** — probe-residue gate（deliver-task.ts:955-971）
   用 `scanFilesForProbes(files, cwd, readFile)` 对磁盘复扫，而非查 hook tracker
   （注释：晚一步 edit 清掉的探针不该再报）。层3 的前置正则门应照抄此模式。
   注意：`security-patterns.ts` 目前只有 `scanContent(filePath, content)`，
   **缺一个文件级封装** `scanFilesForSecurity(files, cwd, readFile)`（类比
   `probe-detector.ts:202`）。`SecurityHit={ruleName,reminder}` 无 severity，
   需自行映射到 review 的 CRITICAL/HIGH/... 分级。

## 推荐方案（复用现有基础设施）

### 门：新增 `RIVET_SECURITY_REVIEW`（默认 off）

新建 `isSecurityReviewEnabled()`（类比 `review-discipline-config.ts` 的
`isReviewDisciplineEnabled`，但默认返回 **false**——opt-in）。所有层2/层3 逻辑
gate 在它后面。不动 `RIVET_REVIEW_DISCIPLINE`。

### 层2：opt-in 时把安全 inspector 加进 auto 审查批次

`review-coordinator-deps.ts` 的 `spawnWiringReviewer`（:473）当前固定跑
接线+静默。改为：`isSecurityReviewEnabled()` 时把「安全审查」inspector 也加进
`requests` 数组。这样 opt-in 后，每次自动 review（auto 模式）就多一路 flash
安全审查子代理，走已有的 detached + AdvisoryBus 投递。**几乎零新增管道。**

### 层3：交付门前置 security 正则复扫（快速门，不花 LLM）

deliver-task.ts:955 探针门之后，加一个同构的安全正则门（gate 在
`isSecurityReviewEnabled()`）：
- 新增 `scanFilesForSecurity(files, cwd, readFile)`（security-patterns.ts）
- ctx 加 `scanSecurity?` 注入点（类比 `scanProbes?`，deliver-task.ts:116-118）
- 命中 → 非阻断 advisory 行（YELLOW，与探针门一致，不 block 交付）
- 这是"快速正则复扫"，与层2 的"LLM 深度审查"互补：正则抓明显模式（零成本），
  LLM 抓跨文件语义（flash 子代理）。

### flash 子代理接线

审查 worker 走 `reviewer` profile（已 tierLock cheap）。要让"默认审查=flash"：
- 方案 A（最小）：把 config `workers.profiles.cheap` 指向 deepseek-v4-flash
  （当前是 MiniMax-M2.7）。影响面大（所有 cheap worker）。
- 方案 B（精准，推荐）：给 reviewer profile 或安全 inspector 的 request 显式
  指定 profile → `cheap-flash`。需确认 coordinator.delegate 是否支持 per-request
  model override（探查中 `request()` 在 review-coordinator-deps.ts:94-118，
  可传 profile；profile→model 经 profileRegistry + routing 解析）。
- **实现前需再确认 B 的 per-request model 覆盖路径。**

### 若要独立 LLM 审查（不走 coordinator worker）的备选

若日后想要层2 完全独立于 review-router（更接近官方插件的"Stop hook 直接调 LLM
审 diff"），复用 cheap-client 原语：
- `buildCheapClient(profile, allProviders)` + `completionFromClient(client, model)`
  （goal-criteria.ts:142 / :102），模板见 loop-factory.ts:493 的
  `buildLazyCopilotCompletion`（懒加载+缓存+fail-to-null）。
- profile 默认取 `workers.profiles['cheap-flash']`（**别抄现有 `.cheap` 硬编码**，
  那是 MiniMax）。
- diff 来源：evidence.filesModified + diff-collector，或 self-verify-hook 的
  postTurn 时机模板（getEvidenceState）。
- prompt 需明确"只审改动行，context 行的漏洞忽略"（照搬官方约束）。

## 验证门（实现时）

- typecheck
- review-router / review-coordinator-deps / deliver-task 相关测试全过
- 端到端：`RIVET_SECURITY_REVIEW=1` 开启后，写一个含 SQL 注入的改动 →
  auto review 应产出安全 finding；默认（不设）→ 无安全审查开销
- 确认默认 off：不设 env 时 `isSecurityReviewEnabled()===false`，层2/层3 全不跑

## 归因纪律

层1 已证明"补内容不补架构"——项目的 hook/review 基础设施比官方那套 6625 行
Python 更完整。层2/层3 同理：**复用 detached review + 已有安全 inspector +
AdvisoryBus，不重造**。独立新建两套是探查前的误判，本文推荐路线已修正。
