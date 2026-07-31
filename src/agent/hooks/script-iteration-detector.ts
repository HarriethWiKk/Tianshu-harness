/**
 * Script-Iteration Detector — postTool 检测「编辑脚本 → bash 运行 → 看截断输出 →
 * 再编辑」的迭代停滞模式（2026-08-01）。
 *
 * 现有死路检测体系的盲区：dead-end-detector 要求 edit→verify-fail，
 * stigmergy dead-end 要求 bash 失败，doom-loop 要求 fingerprint 重复——
 * 脚本迭代循环中所有工具都成功，三个检测器全部沉默。
 *
 * 本 hook 不依赖工具失败，而是靠「同文件 edit + 相邻 bash 执行 + 输出截断 +
 * 无诊断工具」的组合模式识别循环。触发阈值 3 次完整迭代（与 dead-end-detector
 * 的 CYCLE_THRESHOLD 对齐），每次迭代 = edit_file + 之后 bash 执行该脚本 +
 * 截断标记。
 *
 * 与 dead-end-detector 互补：那边管 edit→verify-fail（代码级），这边管
 * edit→bash→edit（脚本/模拟器迭代级）。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import { WRITE_TOOL_NAMES, extractWriteFilePaths } from '../../tools/write-tool-helpers.js'

export interface ScriptIterationDetectorDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  deposit?: (deposit: PheromoneDeposit) => Promise<void>
}

/** 触发阈值：edit→bash→edit 完整循环数。与 dead-end-detector CYCLE_THRESHOLD 对齐。 */
const ITERATION_THRESHOLD = 3

/** 诊断工具——出现即重置计数器（agent 在真正调查而非盲跑） */
const DIAGNOSIS_TOOLS = new Set([
  'read_file', 'grep', 'semantic_search',
  'lsp_find_references', 'lsp_goto_definition',
])

/** 脚本文件扩展名——写这些文件时进入跟踪 */
const SCRIPT_EXTENSIONS = new Set([
  '.py', '.sh', '.bash', '.zsh', '.js', '.ts', '.mjs', '.cjs',
  '.rb', '.pl', '.lua', '.r', '.go', '.rs',
])

/**
 * bash runner 模式：匹配解释器/运行时 + 文件路径。
 * 来源：外部会话日志 `python sim4.py | head -70`、`node script.js` 等。
 * 每个正则的捕获组 2 是脚本文件路径。
 */
const SCRIPT_RUNNER_PATTERNS: RegExp[] = [
  /\bpython3?\d*\.?\d*\s+(['"]?)([^'"\s;|&]+)\1/g,
  /\bnode\s+(['"]?)([^'"\s;|&]+)\1/g,
  /\bbash\s+(['"]?)([^'"\s;|&]+)\1/g,
  /\b(?:tsx|ts-node)\s+(['"]?)([^'"\s;|&]+)\1/g,
  /\b(?:ruby|rb)\s+(['"]?)([^'"\s;|&]+)\1/g,
]

/** 从 bash 命令中提取所有引用的脚本文件路径 */
function extractScriptPaths(command: string): string[] {
  const paths = new Set<string>()
  for (const pattern of SCRIPT_RUNNER_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      const p = match[2]!
      if (p.length > 0 && !p.startsWith('-')) {
        paths.add(p)
      }
    }
  }
  return [...paths]
}

/** 检查工具输出是否含截断标记 */
function isOutputTruncated(resultContent: string | undefined): boolean {
  if (!resultContent) return false
  // output-store.ts 的两种截断格式（`src/tools/output-store.ts:120,141`）
  return resultContent.includes('[output truncated:') || resultContent.includes('lines omitted')
}

/** 检查文件是否是脚本文件（按扩展名） */
function isScriptFile(filePath: string): boolean {
  for (const ext of SCRIPT_EXTENSIONS) {
    if (filePath.endsWith(ext)) return true
  }
  return false
}

interface IterState {
  iterations: number           // 已完成的 edit→bash(truncated) 完整迭代数
  editPending: boolean         // 上次编辑后还没见过 bash（等待 bash 结算迭代）
  fired: boolean               // 本会话已对该文件触发 advisory（一次性）
}

export function createScriptIterationDetectorHook(
  deps: ScriptIterationDetectorDeps,
): PostToolRuntimeHook & { getIterationCount: (file: string) => number } {
  const files = new Map<string, IterState>()

  function stateFor(file: string): IterState {
    let s = files.get(file)
    if (!s) {
      s = { iterations: 0, editPending: false, fired: false }
      files.set(file, s)
    }
    return s
  }

  const hook: PostToolRuntimeHook & { getIterationCount: (file: string) => number } = {
    phase: 'postTool',
    name: 'script-iteration-detector',
    getIterationCount(file: string) { return files.get(file)?.iterations ?? 0 },

    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // ── 诊断工具：agent 在真正调查 → 清空所有状态（循环被打破）─────
      if (DIAGNOSIS_TOOLS.has(tool.name)) {
        files.clear()
        return
      }

      // ── 编辑脚本文件：标记 editPending，等待 bash 来结算迭代 ─────
      if (WRITE_TOOL_NAMES.has(tool.name) && tool.success) {
        for (const file of extractWriteFilePaths(tool.name, tool.input as Record<string, unknown> | undefined)) {
          if (!isScriptFile(file)) continue
          stateFor(file).editPending = true
        }
        return
      }

      // ── bash 执行：结算迭代（edit 时只标记，bash 时计数）─────────
      if (tool.name === 'bash' && tool.success) {
        const command = (tool.input?.command as string) ?? tool.target ?? ''
        const scriptPaths = extractScriptPaths(command)
        const truncated = isOutputTruncated(tool.resultContent)
        for (const sp of scriptPaths) {
          for (const [trackedFile, s] of files) {
            if (!(trackedFile.endsWith(sp) || sp.endsWith(trackedFile) || trackedFile === sp)) continue
            // edit→bash：上次编辑后首次遇到 bash → 结算。迭代定义要求截断标记
            // （docstring：edit + bash 执行 + 截断），无截断只清 editPending 不计数。
            if (s.editPending) {
              if (truncated) s.iterations++
              s.editPending = false
            }
            if (s.iterations >= ITERATION_THRESHOLD && !s.fired) {
              s.fired = true
              deps.advisoryBus.submit({
                key: 'script-iteration-stall',
                priority: 0.7,
                category: 'dead_end',
                tier: 'operational',
                content: `── 脚本迭代停滞 ──\n⚠ ${trackedFile} 已 ${s.iterations} 次「编辑→运行→看截断输出」迭代，每次运行成本高但信息增量低（输出被截断，中间状态不可见）。\n\n建议：\n1. 脚本参数化：加 --dump-trace / --output-file 选项，全量落盘后用 read_file + grep 定位——不要每轮重跑\n2. 换方向：连续 ${ITERATION_THRESHOLD} 轮未果，先搜公开资料、简化测试用例、或请用户提供更多信息\n── 脚本迭代停滞 ──`,
                ttl: 2,
                expect: { kind: 'tool_appears', tools: ['read_file', 'grep', 'web_search', 'ask_user_question'], withinTurns: 2 },
                channel: 'system-reminder',
              })
              try {
                deps.deposit?.({ path: trackedFile, signal: 'dead-end', strength: 0.7 })
              } catch { /* best-effort */ }
            }
            break  // 一个 bash 命令最多匹配一个跟踪文件
          }
        }
        return
      }
    },
  }

  return hook
}
