import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Render-Verify Hook（渲染自检）— postTurn advisory。
 *
 * 失败模式：agent 改完 UI 文件（.tsx/.jsx/.vue/.svelte/.css/.html）后直接
 * 交付，不检查渲染结果——纯代码审查无法捕获布局错位、样式断裂、组件缺失
 * 等视觉问题。
 *
 * 机制：
 *   - 检测本会话是否编辑了 UI 文件（touchedUiFiles flag）
 *   - 检测是否出现了视觉验证动作（browser screenshot / computer_use
 *     snapshot / browser_debug — sawVisualVerify flag）
 *   - 有 UI 编辑 + 零视觉验证 → 提交 advisory
 *   - 能力降级：browser / computer_use 未注册时 advisory 切换为人工过目提示
 *   - 冷却：每会话最多 2 次
 *   - 环境变量 RIVET_RENDER_VERIFY=0 禁用
 *
 * 反证 3（误报防护）：.tsx 纯逻辑重构也可触发 touchedUiFiles。v1 由扩展名
 * 判断，admitting 一定误报率；后续可加 diff 启发（className/style/标签结构）
 * 收紧判据。冷却机制兜底。
 */

/** UI 文件扩展名（不含测试和 scratch）。 */
const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.css', '.html'])

/** 视觉验证工具名。 */
const VISUAL_TOOLS = new Set(['browser', 'computer_use', 'browser_debug'])

export interface RenderVerifyHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 检查 browser/computer_use 是否已注册（能力降级分支）。缺省假定可用。 */
  getVisualToolsAvailable?: () => boolean
  /** 每会话最大触发次数。默认 2。 */
  maxFires?: number
}

export function createRenderVerifyHook(deps: RenderVerifyHookDeps): PostTurnRuntimeHook {
  const maxFires = deps.maxFires ?? 2
  let fireCount = 0

  return {
    phase: 'postTurn',
    name: 'render-verify',
    run(ctx: RuntimeHookContext) {
      const { snapshot } = ctx
      if (!snapshot.touchedUiFiles) return
      if (snapshot.sawVisualVerify) return
      if (fireCount >= maxFires) return

      fireCount++

      const visualAvailable = deps.getVisualToolsAvailable?.() ?? true
      const advice = visualAvailable
        ? 'UI 文件已修改但尚未检查渲染结果。交付前用 browser_debug 自证：open → navigate 到 dev server → screenshot 看布局 + console 查报错；原生桌面应用场景用 computer_use snapshot（未挂载时经 /tools enable computer_use 或 delegate_task 派发）。确认渲染无误后再交付。'
        : 'UI 文件已修改，但当前环境缺少视觉验证工具（无 Playwright 或非 Pro——browser_debug 需要 Playwright，computer_use 需要 Pro + macOS/Windows）。交付前请人工过目渲染结果，确认视觉无误后再交付。'

      deps.advisoryBus.submit({
        key: 'render-verify',
        priority: 0.55,
        category: 'discipline',
        tier: 'operational',
        content: advice,
        ttl: 1,
        // 没有 expect 的条目 adopted 恒 0，会被 efficacy 负反馈环当成零采纳
        // 逐步冷却直至本会话静默——这条提醒一直走在被系统自己掐掉的轨道上。
        // 精度局限：tool_appears 只认工具名，`browser_debug open`/`navigate`
        // 这种操作类调用也会记成采纳（谓词表达不了 isVerifyCall 的 action 过滤），
        // 所以它的 lift 数据偏高，够用来免于静音，别当精确读数。
        // 工具不可用的分支催的是人工过目，没有工具痕迹可核销，故不挂 expect
        // （该分支有 fireCount 上限兜底）。
        ...(visualAvailable
          ? {
              expect: {
                kind: 'tool_appears' as const,
                tools: ['browser_debug', 'browser', 'computer_use'],
                withinTurns: 3,
              },
            }
          : {}),
      })
    },
  }
}

/**
 * 判断文件路径是否为 UI 文件（扩展名匹配，排除测试和 scratch）。
 */
export function isUiFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  // 排除测试文件
  if (lower.includes('__tests__') || lower.includes('.test.') || lower.includes('.spec.')) return false
  // 排除 scratch 临时探针
  if (lower.includes('.rivet/scratch/')) return false
  // 扩展名匹配
  for (const ext of UI_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

/**
 * 判断文件路径是否为视觉验证工具调用目标。
 */
export function isVisualVerifyTool(toolName: string): boolean {
  return VISUAL_TOOLS.has(toolName)
}
