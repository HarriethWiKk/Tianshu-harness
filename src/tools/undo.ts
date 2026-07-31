import type { Tool, ToolCallParams } from './types.js'
import type { FileHistory } from '../agent/file-history.js'
import { trackFileRestore } from '../agent/recovery-stack.js'

export function createUndoTool(getFileHistory: () => FileHistory | undefined): Tool {
  return {
    definition: {
      name: 'undo',
      description: `撤销最近一次文件改动，将其恢复到之前的备份。恢复前先展示将发生的变化。该操作以文件为单位——只回退上一次工具调用中修改过的文件。`,
      input_schema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: '设为 true 才执行撤销。不带 confirm 时只展示预览。',
          },
        },
      },
    },

    async execute(params: ToolCallParams) {
      const history = getFileHistory()
      if (!history) {
        return { content: '文件历史不可用。', isError: true }
      }

      const latestId = history.getLatestSnapshotId()
      if (!latestId) {
        return { content: '没有可撤销的文件历史快照。' }
      }

      const confirm = params.input.confirm === true

      if (!confirm) {
        const stats = await history.getDiffStats(latestId)
        if (!stats || stats.filesChanged.length === 0) {
          return { content: '最近快照中没有可撤销的变更。' }
        }
        const fileList = stats.filesChanged.map(f => `  - ${f}`).join('\n')
        // B1: note if any files are not owned by the current task
        const unownedFiles = params.ownedFiles?.length
          ? stats.filesChanged.filter(f => !params.ownedFiles!.includes(f))
          : []
        const unownedNote = unownedFiles.length > 0
          ? `\n\n⚠️  警告：${unownedFiles.length} 个文件不属于当前任务，可能属于并行会话：\n${unownedFiles.map(f => `  - ${f}`).join('\n')}\n确认前请核实归属。`
          : ''
        return {
          content: `预览：将恢复 ${stats.filesChanged.length} 个文件：\n${fileList}\n+${stats.insertions}/-${stats.deletions} 行${unownedNote}\n\n传入 confirm: true 以执行。`,
        }
      }

      try {
        const restored = await history.rewind(latestId)
        if (restored.length === 0) {
          return { content: '没有需要恢复的文件。' }
        }
        // Recovery-journal tracking is a best-effort audit side-effect; a write
        // failure (e.g. an unwritable cwd) must not mask an already-successful
        // restore by surfacing it as "Undo failed".
        for (const file of restored) {
          try {
            trackFileRestore(params.cwd, file, 'undo tool restore', 0, params.sessionId)
          } catch { /* audit journal unavailable — restore already applied */ }
        }
        // B1: report if any restored files were not owned
        const unownedRestored = params.ownedFiles?.length
          ? restored.filter(f => !params.ownedFiles!.includes(f))
          : []
        const unownedNote = unownedRestored.length > 0
          ? `\n⚠️  ${unownedRestored.length} 个文件不属于本任务：${unownedRestored.join(', ')}`
          : ''
        return { content: `已恢复 ${restored.length} 个文件：\n${restored.map(f => `  - ${f}`).join('\n')}${unownedNote}` }
      } catch (err) {
        return { content: `撤销失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
