import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { MeridianIndexer } from '../../repo/meridian-indexer.js'
import { relativizePhysarumFileTarget } from './physarum-file-access-hook.js'

export interface ImportGraphPredictionBatch {
  afterToolName: string
  predictions: Array<{ file: string; score: number }>
}

export interface ImportGraphPredictHookDeps {
  getIndexer: () => MeridianIndexer | null
  onPredictions?: (batch: ImportGraphPredictionBatch) => void
}

/**
 * 经络 import-graph 观察臂（P2-2）：read_file 成功后查出边 top-5 入队。
 * 镜像 physarum-file-access-hook 形状；装配门控在 loop-factory
 * （RIVET_SPEC_OBSERVE=1 且 meridianIndexer 存在）——封存态零 sqlite 查询。
 * 目标经 relativizePhysarumFileTarget 归一化为仓库相对形（与 ShadowQueue
 * 匹配键同基准），非索引/逃逸目标跳过（口径：观察臂只统计可索引文件类目标）。
 */
export function createImportGraphPredictHook(deps: ImportGraphPredictHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'import-graph-predict',
    run(ctx, tool) {
      if (!tool.success || tool.name !== 'read_file') return
      const structuredPath = typeof tool.input?.file_path === 'string' ? tool.input.file_path : undefined
      const filePath = relativizePhysarumFileTarget(ctx.snapshot.cwd, structuredPath)
      if (!filePath) return

      const indexer = deps.getIndexer()
      if (!indexer) return
      const forward = indexer.getDb().getForwardDependencies(filePath)
      if (forward.length === 0) return

      deps.onPredictions?.({
        afterToolName: tool.name,
        predictions: forward.slice(0, 5).map(dep => ({ file: dep.file, score: dep.weight })),
      })
    },
  }
}
