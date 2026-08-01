import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { classifyOrchestrationScale } from '../agent/task-size-gate.js'
import type { TeamRunSummary } from '../agent/team-orchestrator.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks, validateUnifiedPlan } from '../agent/unified-plan.js'
import { groupTeamTasks } from '../agent/team-grouping.js'
import { parseTeamTasks } from '../agent/team-plan.js'
import { formatSealStatus, verifyPlanSeal, type SealedUnifiedPlan } from '../agent/council/council-seal.js'
import { clearPlan, consumePlan, storePlan } from '../agent/plan-store.js'
import { buildTeamPanelModel, encodeTeamPanelModel } from '../tui/team-panel-model.js'
import { validatePathSafe } from './path-validate.js'
import { createActivityStreamer, createDelegationActivityMapper, progressSnippet } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
// Shared execution kernel — the dispatch + scope-health + review gate + telemetry
// closure live in the agent layer so plan_task and team_orchestrate share one path.
import {
  executePlan,
  teamReviewChangedFiles,
  teamReviewForceLevel,
  teamReviewFocusHint,
  type PlanExecutorDeps,
  type PlanExecutorRun,
  type TeamImpactAnalyzer,
} from '../agent/plan-executor.js'

// Back-compat re-exports: TeamOrchestrateCoordinator was the tool-layer name for
// the executor's dependency surface; tests/bootstrap still reference these and the
// review helpers from this module.
export type TeamOrchestrateCoordinator = PlanExecutorDeps
export type { TeamImpactAnalyzer }
export { teamReviewChangedFiles, teamReviewForceLevel, teamReviewFocusHint }

const inputSchema = z.object({
  mode: z.enum(['standard', 'max']).default('standard'),
  objective: z.string().min(1),
  planPath: z.string().optional(),
  planMarkdown: z.string().optional(),
  /** UnifiedPlan JSON from plan_task output — bypasses Markdown parsing and max planner fanout. */
  planJson: z.string().optional(),
  maxParallel: z.number().int().min(1).max(5).optional(),
  fromWave: z.number().int().min(0).optional(),
  /** 两阶段确认（星河收编 #7）：显式 confirm:false → 只展示波次分派方案不派发；
   *  confirm:true → 点火。缺省 undefined → 直接执行（现状行为，向后兼容）。 */
  confirm: z.boolean().optional(),
})

/**
 * Render the council merge ledger (max mode, first wave) so the perspective work
 * isn't silently dropped: cross-perspective conflicts, deferred alternatives, and
 * the risk ledger. Each section is capped to keep the panel readable; a trailing
 * count signals how many were elided. Advisory — never blocks dispatch.
 */
function formatPlanMerge(planMerge: NonNullable<TeamRunSummary['planMerge']>): string[] {
  const CAP = 3
  const lines: string[] = []
  const section = (
    title: string,
    items: string[],
  ): void => {
    if (items.length === 0) return
    lines.push(title)
    for (const item of items.slice(0, CAP)) lines.push(`  - ${item}`)
    if (items.length > CAP) lines.push(`  … (+${items.length - CAP} more)`)
  }
  section(
    'Plan conflicts (council disagreed — adjudicate):',
    planMerge.conflicts.map(c => c.description),
  )
  section(
    '已补入执行图的分片 (orthogonal shards folded in):',
    planMerge.augmented.map(a => `${a.title} — ${a.reason}`),
  )
  section(
    'Deferred alternatives (not in base plan):',
    planMerge.deferred.map(d => `${d.title} — ${d.reason}`),
  )
  section(
    'Risk ledger:',
    planMerge.risks.map(r => `[${r.severity}]${r.taskId ? ` ${r.taskId}:` : ''} ${r.claim}`),
  )
  return lines
}

export function formatTeamSummary(summary: TeamRunSummary, fromWave = 0): string {
  const lines: string[] = [
    `team ${summary.mode}: ${summary.dispatched} dispatched, ${summary.waves.length} waves, ${summary.blocked.length} blocked${summary.planCacheHit ? ' (plan cache hit — planner fanout skipped)' : ''}`,
  ]
  if (summary.waves.length > 0) {
    lines.push('Waves:')
    for (const w of summary.waves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
  }
  if (summary.blocked.length > 0) {
    lines.push('Blocked:')
    for (const b of summary.blocked) lines.push(`  - ${b}`)
  }
  if (summary.planMerge) {
    const mergeLines = formatPlanMerge(summary.planMerge)
    if (mergeLines.length > 0) lines.push('', ...mergeLines)
  }
  if (summary.advisories && summary.advisories.length > 0) {
    lines.push('', '分片建议(不阻断):')
    for (const a of summary.advisories.slice(0, 3)) lines.push(`  - ${a}`)
    if (summary.advisories.length > 3) lines.push(`  … (+${summary.advisories.length - 3} more)`)
  }
  const nextWave = fromWave + 1
  if (summary.waves.length > nextWave) {
    // Whole-wave failure: every worker missed its bar. Advancing on top of a
    // failed/stale wave compounds breakage, so replace the next-wave nudge with
    // a stop warning. Only triggers when an actual run is present (post-dispatch),
    // not for the onPlanReady pre-render where summary.run is absent.
    const run = summary.run
    const allFailed = !!run && run.results.length > 0 && run.results.every(r => r.status !== 'passed')
    if (allFailed) {
      lines.push('', `⚠ wave ${fromWave}: all ${run!.results.length} workers failed — integrate/retry before advancing; do NOT dispatch fromWave ${nextWave} until fixed.`)
    } else {
      lines.push('', `To run the next wave after integrating this wave's diffs: call team_orchestrate again with fromWave: ${nextWave}.`)
    }
  }
  lines.push('', summary.packet)
  return lines.join('\n')
}

export function createTeamOrchestrateTool(
  coordinator: TeamOrchestrateCoordinator,
  options?: {
    defaultMaxParallel?: number
    /** Pro gate: mode:'max'（多视角 planner fanout）仅 Pro 可用。缺省 true
     *  以保持直接构造方（测试等）行为不变；bootstrap 按 pro-license 传真值。 */
    teamMaxEnabled?: boolean
  },
  /** H4-D4：team_orchestrate 派发 worker 完成后标记已完成 orderId */
  getAttackStore?: () => import('../agent/problem-attack-loop.js').ProblemAttackStore | null,
): Tool {
  return {
    definition: {
      name: 'team_orchestrate',
      description:
        '运行确定性 team 编排器：解析计划（standard 模式），按文件冲突与依赖把任务分组成波次（wave），派发第一个就绪波次的 worker。返回波次调度与派发摘要。不自动提交（NOT auto-commit）。\n\n分片（SHARDING）：把工作水平切成正交分片——每个分片是完整自包含的单元（实现 + 跑 tsc/lint/相关测试），由一个有能力的 flash 端到端负责。不要按阶段垂直切分（不拆独立的 lint/type/import/test 角色任务）。让分片落在不相交的文件上以并行执行；两个分片必须改同一文件时，设 dependsOn 排序（校验器会对未排序的重叠发出警告）。worker 直接写入控制器的单一共享工作区——没有逐 worker 的 diff 要合并；用 git diff 审查聚合结果。\n\n传 planJson（plan_task 输出的 UnifiedPlan）可跳过 Markdown 解析与 planner fanout，直接执行。',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['standard', 'max'], description: 'standard: 执行已有计划。max: 先做多视角规划。' },
          objective: { type: 'string', description: '任务目标陈述。' },
          planPath: { type: 'string', description: '项目内 Markdown 计划文件路径（可选，standard 模式）。' },
          planMarkdown: { type: 'string', description: '内联 Markdown 计划（可选）；优先级高于 planPath。' },
          planJson: { type: 'string', description: 'plan_task 输出的 UnifiedPlan JSON。提供时跳过 Markdown 解析与 max planner fanout。' },
          maxParallel: { type: 'number', description: '每波次最大并行 worker 数（1-5，默认 3）。' },
          fromWave: { type: 'number', description: '整合前序波次 diff 后，派发这个从零开始的波次索引。' },
          confirm: { type: 'boolean', description: '两阶段确认（收编 #7）：显式 false → 只展示波次分派方案不派发；true → 点火。缺省 → 直接执行（兼容）。' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `无效输入：${parsed.error.message}`, isError: true, errorKind: 'format_error' }
      const { mode, objective, planPath, planMarkdown, planJson: explicitPlanJson, maxParallel, fromWave } = parsed.data
      // Bridge: auto-consume the plan stored by plan_task when planJson is omitted.
      const planJson = explicitPlanJson ?? consumePlan(params.sessionId)
      // Stale-plan hygiene: an explicit planJson takes priority, so drop any plan
      // left in the session store — otherwise it would be wrongly auto-consumed by
      // a later bare call.
      if (explicitPlanJson) clearPlan(params.sessionId)

      // Task-size gate: block small tasks from triggering heavy orchestration
      const scale = classifyOrchestrationScale(objective)
      if (scale.blocked) {
        return {
          content: `team_orchestrate 已拦截：${scale.reason}\n\n请改为内联完成此任务——不需要并行编排。\n（若要绕过：在 objective 前加前缀 "force:"）`,
          isError: true,
        }
      }

      // Pre-parsed tasks from plan_task UnifiedPlan JSON
      let tasks: ReturnType<typeof unifiedPlanToTeamTasks> | undefined
      let planAdvisoryNote = ''
      if (planJson) {
        const plan = deserializeUnifiedPlan(planJson)
        if (!plan) return { content: 'team_orchestrate 已拦截：planJson 不是合法的 UnifiedPlan', isError: true }
        const validation = validateUnifiedPlan(plan)
        if (!validation.valid) {
          const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
          return { content: `team_orchestrate 已拦截：计划校验失败：\n${errors.map(e => `  - ${e}`).join('\n')}`, isError: true }
        }
        if (validation.warnings.length > 0) {
          planAdvisoryNote = `\n\n分片建议(不阻断):\n${validation.warnings.map(w => `  - ${w}`).join('\n')}`
        }
        // Atropos 密封校验（Phase 3）：议事会密封过的契约被静默改写 → 消费入口
        // 硬拦。未密封计划（plan_task/manual 产出）不受影响；修订走豁免协议
        // （revisePlanSeal 复封后 version+1，此处放行）。
        const sealCheck = verifyPlanSeal(plan as SealedUnifiedPlan)
        if (sealCheck.status === 'broken') {
          return {
            content: `team_orchestrate 已拦截：${formatSealStatus(plan as SealedUnifiedPlan)}`,
            isError: true,
          }
        }
        if (sealCheck.status === 'intact') {
          planAdvisoryNote += `\n\n${formatSealStatus(plan as SealedUnifiedPlan)}`
        }
        tasks = unifiedPlanToTeamTasks(plan)
        // Re-store for multi-wave: consumePlan cleared it, but subsequent
        // waves need it too.  Only re-store when the model didn't pass an
        // explicit planJson (explicit always takes priority).
        if (!explicitPlanJson) storePlan(planJson, params.sessionId)
      }

      let markdown = planMarkdown
      if (!markdown && !tasks && planPath) {
        const safe = validatePathSafe(params.cwd, planPath)
        if (!safe.ok) return { content: `team_orchestrate 已拦截：${safe.error}`, isError: true }
        try {
          markdown = readFileSync(safe.path, 'utf8')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: `team_orchestrate 已拦截：无法读取 planPath「${planPath}」：${msg}`, isError: true }
        }
      }

      // ── Pro gate: team max ──
      // 多视角 planner fanout 是 Pro 功能。有现成计划时降级 standard 继续执行
      // (不浪费已有工作),没有计划时明确拒绝并给出 Basic 可用的替代路径。
      let effectiveMode = mode
      let proGateNote = ''
      if (mode === 'max' && !(options?.teamMaxEnabled ?? true)) {
        if (tasks || markdown) {
          effectiveMode = 'standard'
          proGateNote = '\n\n[Pro] team max（多视角规划）是 Pro 功能——已降级为 standard 模式执行现有计划。升级 Pro 解锁多视角 planner fanout。'
        } else {
          return {
            content: 'team_orchestrate: mode "max"（多视角规划 fanout）是 Pro 功能。Basic 替代路径：先用 plan_task 生成计划，再以 standard 模式执行；或升级 Pro 解锁。',
            isError: true,
          }
        }
      }

      // Standard mode needs a plan to execute; max mode generates one via planner
      // fanout, so only guard the standard path. A clear message beats the
      // "no dispatchable waves" weak result when nothing was provided/stored.
      if (effectiveMode === 'standard' && !tasks && !markdown) {
        return {
          content: 'team_orchestrate 已拦截：未提供计划，也未找到已存储的计划。请先运行 plan_task，或传入 planJson/planPath。',
          isError: true,
        }
      }

      // T9 P3 text stream + T4 structured per-worker updates (subagent panel).
      // objectiveById is filled from live activity events (coordinator attaches
      // order.objective) so terminal callbacks can re-emit the full objective.
      const objectiveById = new Map<string, string>()
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity, {
            objectiveOf: (id) => objectiveById.get(id),
          })
        : undefined
      const onActivity = (textStreamer || activityMapper)
        ? (ev: WorkerActivityEvent) => {
            if (ev.objective) objectiveById.set(ev.workOrderId, ev.objective)
            textStreamer?.(ev)
            activityMapper?.(ev)
          }
        : undefined

      // T4: per-worker terminal status for the subagent panel. Same dual-emission
      // contract as delegate_batch: settle-time via onWorkerSettled (fast worker
      // flips to ✓ immediately), batch-end loop below as backstop (fleet dedupes).
      const emitTerminal = params.onWorkerActivity
        ? (r: import('../agent/work-order.js').WorkerResult) => {
            params.onWorkerActivity!({
              workOrderId: r.workOrderId,
              parentToolId: params.toolUseId,
              objective: objectiveById.get(r.workOrderId),
              status: r.status,
              progressLine: progressSnippet(r.summary),
              summary: r.summary,
              failureReason: r.failureReason,
              model: r.model,
              provider: r.provider,
              usage: r.usage,
              artifactId: r.diffArtifactId,
              changedFiles: r.changedFiles.length > 0 ? r.changedFiles : undefined,
              findingsCount: r.findings.length > 0 ? r.findings.length : undefined,
              topFinding: r.findings[0]?.claim,
              verificationBrief: r.verification
                ? { status: r.verification.status, passed: r.verification.passed, failed: r.verification.failed }
                : undefined,
              evidenceStatus: r.evidenceStatus,
            })
          }
        : undefined

      const effectiveFromWave = fromWave ?? 0

      // ── Phase 1: Proposal (explicit confirm:false) ─────────────────
      // 星河收编 #7：只展示波次分派方案，不派发任何 worker。缺省/true 直接
      // 执行（向后兼容——此前 team_orchestrate 没有 proposal 阶段）。
      if (parsed.data.confirm === false) {
        const lines = ['🚀 team 编排方案', '', `目标：${objective}`, '', `mode：${effectiveMode}${proGateNote ? '（Pro 门降级）' : ''}`]
        if (tasks && tasks.length > 0) {
          lines.push('', `任务（${tasks.length}）：`, ...tasks.map(t => `  ${t.id}`))
          // 静态波次预览：与执行同用 groupTeamTasks 且**同参数**——执行路径
          // （team-orchestrator.ts）三处均不传 options（恒 MAX_WRITE_WORKERS），
          // 预览传参会让 maxTeamParallel≠3 时展示与真实分波不一致。
          const previewWaves = groupTeamTasks(tasks)
          lines.push('', '波次分派（静态预览）：')
          for (const w of previewWaves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
        } else if (markdown) {
          // proposal 阶段同步解析 markdown 做波次预览（与 executePlan 同一
          // 解析器），展示即真相。
          const parsedTasks = parseTeamTasks(markdown)
          if (parsedTasks.length > 0) {
            lines.push('', `任务（${parsedTasks.length}）：`, ...parsedTasks.map(t => `  ${t.id}`))
            // 同 tasks 分支：参数必须与执行路径一致（不传 options）。
            const previewWaves = groupTeamTasks(parsedTasks)
            lines.push('', '波次分派（静态预览）：')
            for (const w of previewWaves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
          } else {
            lines.push('', '计划已提供（Markdown），解析未产生任务。')
          }
        } else {
          lines.push('', effectiveMode === 'max'
            ? '将先做多视角规划（planner fanout）再分组执行。'
            : '需要 planJson / planMarkdown / planPath 之一。')
        }
        lines.push('', '调用 team_orchestrate({..., confirm: true}) 点火执行。')
        return { content: lines.join('\n'), uiContent: `🚀 team 方案 · ${tasks?.length ?? '?'} 任务` }
      }

      let run: PlanExecutorRun
      try {
        run = await executePlan(
          {
            mode: effectiveMode,
            objective,
            tasks,
            planMarkdown: markdown,
            fromWave: effectiveFromWave,
            maxParallel: maxParallel ?? options?.defaultMaxParallel,
            sessionId: params.sessionId,
            parentTurnId: params.toolUseId,
            reviewDepth: params.reviewDepth ?? 0,
            cwd: params.cwd,
            abortSignal: params.abortSignal,
            // team_orchestrate IS the review-bearing path.
            reviewGate: true,
            // T9 P3: live worker token/tool stream into the team tool card.
            onActivity,
            // Fleet viz: emit the wave/task DAG (all waiting) before dispatch so
            // the TUI shows the plan up front; the engine overlays running state.
            onPlanReady: params.onOutput
              ? (skeleton, wave) => {
                  params.onOutput!(`\n${encodeTeamPanelModel(buildTeamPanelModel(skeleton, wave))}\n`)
                }
              : undefined,
            onProgress: params.onOutput
              ? (completed, total) => {
                  const done = Math.max(0, Math.min(completed, total))
                  params.onOutput!(`✦ team progress: ${done}/${total} workers done\n`)
                }
              : undefined,
            onWorkerSettled: emitTerminal ?? undefined,
          },
          coordinator,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `team_orchestrate 失败：${msg}`, isError: true }
      }

      const { summary, reviewVerdict, notes } = run

      // T4: terminal per-worker status for the subagent panel (backstop loop —
      // per-worker settle events were already emitted via onWorkerSettled).
      if (emitTerminal && summary.run) {
        const attackStore = getAttackStore?.() ?? null
        for (const r of summary.run.results) {
          emitTerminal(r)
          // H4-D4：标记已完成 worker，供 PAL worker: 引用验真
          if (r.status === 'passed' && attackStore) {
            attackStore.markWorkerCompleted(r.workOrderId)
          }
        }
      }

      const panelModel = buildTeamPanelModel(summary, effectiveFromWave, reviewVerdict, undefined, run.gate, run.reviewDetail)
      return {
        content: formatTeamSummary(summary, effectiveFromWave) + notes.reviewNote + notes.scopeHealthNote + notes.impactNote + notes.waveGateNote + notes.deliverySynthesis + planAdvisoryNote + proGateNote,
        uiContent: encodeTeamPanelModel(panelModel),
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: () => 600_000,
  }
}
