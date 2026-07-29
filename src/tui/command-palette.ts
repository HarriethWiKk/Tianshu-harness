/**
 * 命令面板数据层 — 命令清单与模糊过滤（纯函数，零 React/Ink）。
 *
 * 渲染与按键交互在 T9：`format/overlay.ts::renderCommandPalette` +
 * `engine/app.ts` 的 overlay 导航。本模块只提供数据。
 */

export interface PaletteCommand {
  name: string
  description: string
  category?: 'command' | 'surface'
  /** 已生效的键位提示，渲染为 ` [x]`。**只填真的能按的键**（如 `Ctrl+R`）。
   *
   *  这里曾给 4 个 surface 填过 `c`/`p`/`s`/`h`，但面板里任何可打印字符都进过滤框，
   *  从没有按键路径消费它们——纯装饰的可供性。要让单字母生效就得像 lazygit 那样把
   *  过滤改成显式前缀（`/` 过名字、`@` 过键位），代价是砸掉当前正常工作的「打字即
   *  过滤」；而这 4 个界面本就各有两条可达路径（面板打名字、或 /cockpit /pager
   *  /starmap /chronicle），并没有能力缺口。故移除假标记，保留本字段给真实绑定。 */
  hotkey?: string
  /** 可选参数提示（ghost text）：见 format/slash-hint.ts slashArgsHint。 */
  argsHint?: string
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query) return [...commands]
  const lower = query.toLowerCase()
  return commands
    .filter(c => {
      if (c.name.toLowerCase().includes(lower)) return true
      if (c.description.toLowerCase().includes(lower)) return true
      let qi = 0
      for (let i = 0; i < c.name.length && qi < lower.length; i++) {
        if (c.name[i]!.toLowerCase() === lower[qi]) qi++
      }
      return qi === lower.length
    })
    .sort((a, b) => {
      const aStart = a.name.toLowerCase().startsWith(lower) ? 0 : 1
      const bStart = b.name.toLowerCase().startsWith(lower) ? 0 : 1
      return aStart - bStart || a.name.localeCompare(b.name)
    })
}

export function getPaletteCommands(): PaletteCommand[] {
  return [
    { name: '__surface:cockpit', description: 'Cockpit — trace / verify / context', category: 'surface' },
    { name: '__surface:pager', description: 'Scrollback — browse session history', category: 'surface' },
    { name: '__surface:starmap', description: 'Starmap — 星图总览', category: 'surface' },
    { name: '__surface:chronicle', description: 'Chronicle — 阶段传说', category: 'surface' },
    { name: '/help', description: 'Show all commands', category: 'command' },
    { name: '/btw', description: '侧问 — 就当前会话问一句，不进对话历史', argsHint: '<问题>' },
    { name: '/compact', description: 'Compact conversation context' },
    { name: '/connect', description: '连接模型服务商（选内置或自定义，填写 API 密钥）' },
    { name: '/config', description: '设置面板 — 子代理路由 / 审查子代理 / 识图模型 / 基础项' },
    { name: '/model', description: 'Show or switch model', argsHint: 'list|<model-id>' },
    { name: '/model list', description: 'List available models' },
    { name: '/chat', description: 'Switch to lightweight chat mode' },
    { name: '/task', description: '任务模式（已废弃：意图自动检测；子代理面板用 /tasks）' },
    { name: '/tasks', description: '打开子代理任务面板（查看/切入 f/停止 x，运行中·已完成·全部）' },
    { name: '/jobs', description: '打开后台任务面板（bash 后台启动的 shell 任务列表）' },
    { name: '/mode', description: 'Show or switch prompt mode' },
    { name: '/verify', description: 'Show verification status' },
    { name: '/verbose', description: 'Toggle verbose tool output' },
    { name: '/clear', description: 'Clear screen' },
    { name: '/sessions', description: 'List saved sessions' },
    { name: '/rollback', description: 'Preview checkpoint changes' },
    { name: '/evidence', description: 'Show last turn evidence' },
    { name: '/context', description: 'Show context ledger' },
    { name: '/memory', description: 'Show session memory' },
    { name: '/skill list', description: 'List available skills' },
    { name: '/skill install', description: 'Install skill from .claude/skills into .rivet/skills' },
    { name: '/skill review', description: 'Review auto-distilled skill drafts' },
    { name: '/skill approve', description: 'Promote a skill draft into .rivet/skills' },
    { name: '/skill reject', description: 'Reject and delete a skill draft' },
    { name: '/permission', description: '权限模式：Manual / Auto / YOLO 三档统一入口（无参弹选择器，持久化默认）' },
    { name: '/yes', description: '一键 YOLO（/yes off 退出）— 持久化为默认', argsHint: 'off' },
    { name: '/mission', description: '天契 — 当前任务契约', category: 'command' },
    { name: '/goal', description: 'Set a persistent goal — agent auto-continues until achieved', argsHint: '<objective>' },
    { name: '/cancel-goal', description: 'Cancel the active goal' },
    { name: '/goal-resume', description: 'Resume a paused or blocked goal' },
    { name: '/mcp', description: 'Show MCP server status' },
    { name: '/cockpit', description: 'Toggle cockpit panel' },
    { name: '/scroll', description: 'Browse output history' },
    { name: '/theme', description: 'Switch color theme' },
    { name: '/fork', description: 'Fork current session' },
    { name: '/handoff', description: '写结构化交接文档（五章节），归档后自动注入新会话', argsHint: '[备注]' },
    { name: '/vim', description: 'Toggle vim keybindings' },
    { name: '/effort', description: 'Set reasoning effort (off|low|medium|high|max)', argsHint: 'off|low|medium|high|max' },
    { name: '/domain', description: '查看或切换星域人格 (list|<name>|auto|off)', argsHint: 'list|<name>|auto|off' },
    { name: '/interview', description: 'Deep interview to clarify requirements' },
    { name: '/team', description: 'Run team-mode workflow skeleton', argsHint: 'max' },
    { name: '/team max', description: 'Run team-mode planning-first workflow' },
    { name: '/council', description: 'Convene a star-domain council (single round; --rounds 2+ enables debate)', argsHint: '[--rounds N]' },
    { name: '/plan', description: 'Create implementation plan (writing-plans workflow)' },
    { name: '/write-plan', description: 'Alias of /plan — same writing-plans workflow' },
    { name: '/plan-mode', description: 'Enter/exit plan authoring mode (/plan-mode toggles)' },
    { name: '/ask', description: 'Enter/exit Ask mode — read-only Q&A (/ask toggles)' },
    { name: '/plan-list', description: 'List submitted plans awaiting approval' },
    { name: '/plan-approve', description: 'Approve a plan and start execution' },
    { name: '/plan-reject', description: 'Reject a plan with feedback for revision' },
    { name: '/plan-close', description: 'Preview or apply implementation plan closure' },
    { name: '/review', description: 'Trigger L2 adversarial code review on current changes', argsHint: 'max|off|on' },
    { name: '/review max', description: 'Trigger L3 Review Squadron (5 inspectors) on current changes' },
    { name: '/review off', description: '关闭本会话自动审查门（省 token）；/review on 恢复，手动 /review 始终可用' },
    { name: '/constellation', description: '星图 — Project blueprint & milestone chronicle' },
    { name: '/leave', description: '离开仪式 — Leave your mark in the starmap' },
    { name: '/enter', description: 'Resume a worker session (e.g. /enter wo_team:T1 continue)', argsHint: '<orderId> [prompt]' },
    { name: '/exit', description: 'Save session and exit' },
    { name: '/update', description: 'Check and install the latest Rivet release' },
    { name: '/doctor', description: 'Environment health check + which shell the bash tool uses' },
    { name: '/logs', description: '本会话的日志落点（会话 / 缓存 / 六维 / 桌面），含门控与回收说明', argsHint: '[open [desktop]]' },
    { name: '/init', description: '交互式项目初始化：verify 声明 / skills / hooks 脚手架' },
    { name: '/cd', description: '会话中途切换工作目录（保前缀缓存，会话归属迁往新项目）', argsHint: '<path>' },
  ]
}
