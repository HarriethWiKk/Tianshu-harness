import { statSync } from 'node:fs'
import { relative, resolve, sep, join } from 'node:path'
import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PhysarumEngine } from '../../repo/physarum-engine.js'
import { isIndexablePhysarumFile } from '../../repo/physarum-engine.js'
import { validatePathSafe } from '../../tools/path-validate.js'

export interface PhysarumFilePredictionBatch {
  sourceFile: string
  afterToolName: string
  predictions: Array<{ file: string; score: number }>
}

export interface PhysarumFileAccessHookDeps {
  getPhysarum: () => PhysarumEngine | null
  onPredictions?: (batch: PhysarumFilePredictionBatch) => void
}

const FILE_ACCESS_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'hash_edit'])

/**
 * 纯路径归一化（P2-1 入队侧）：绝对/相对 → 仓库相对形，逃逸与非索引目标拒绝。
 * **不做存在性校验**——入队侧预测可能指向尚未读取的文件，stat 校验会错误丢弃
 * 这类预测（其 miss 本应由 enqueue 后 stat 失败如实记录）。
 */
export function relativizePhysarumFileTarget(cwd: string, target: string | undefined): string | null {
  if (!target) return null

  const validated = validatePathSafe(cwd, target)
  if (!validated.ok) return null

  const rel = relative(resolve(cwd), validated.path).split(sep).join('/')
  if (!rel || rel.startsWith('../') || rel === '..') return null
  if (!isIndexablePhysarumFile(rel)) return null
  return rel
}

/**
 * 窥视侧归一化（P2-1）：相对化 + 存在性校验（read_file 成功的文件必然存在）。
 * 归一化失败（非索引文件/文件瞬逝/逃逸路径）→ 返回 null，调用方跳过统计——
 * 口径 =「观察臂只统计可索引文件类目标」，解读报告时勿把漏计当假 miss。
 */
export function canonicalizePhysarumFileTarget(cwd: string, target: string | undefined): string | null {
  const rel = relativizePhysarumFileTarget(cwd, target)
  if (!rel) return null

  try {
    if (!statSync(join(resolve(cwd), rel)).isFile()) return null
  } catch {
    return null
  }
  return rel
}

function getStructuredFilePath(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!FILE_ACCESS_TOOLS.has(toolName)) return undefined
  return typeof input?.file_path === 'string' ? input.file_path : undefined
}

export function createPhysarumFileAccessHook(deps: PhysarumFileAccessHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'physarum-file-access',
    run(ctx, tool) {
      if (!tool.success) return

      const structuredPath = getStructuredFilePath(tool.name, tool.input)
      const filePath = canonicalizePhysarumFileTarget(ctx.snapshot.cwd, structuredPath)
      if (!filePath) return

      const physarum = deps.getPhysarum()
      if (!physarum) return
      physarum.recordFileAccess(filePath, ctx.snapshot.turn)

      const predictions = physarum.predictNext(filePath, 3)
      if (predictions.length > 0) {
        deps.onPredictions?.({
          sourceFile: filePath,
          afterToolName: tool.name,
          predictions,
        })
      }
    },
  }
}
