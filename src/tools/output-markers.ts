/**
 * 工具输出的结构化文案标记——桌面端镜像层（browser-mirror / walkthrough-recorder
 * / ToolGroup）靠这些前缀从工具输出文本中提取结构信息。
 *
 * HARD CONSTRAINT: 零依赖叶子模块（桌面端经 src/server/ui-shared.ts 引用，
 * 任何 import 都会把内核运行时拖进前端图谱）。改文案必须两端同步——用常量
 * 共享，禁止两边各自手抄。原定义位置（browser.ts / computer-use/tool.ts）
 * re-export 以保持内核调用方不变。
 */

/**
 * 导航结果 URL 前缀——desktop browser-mirror / walkthrough-recorder 靠此前缀
 * 提取当前页。
 */
export const BROWSER_NAVIGATED_PREFIX = '已导航至'

/**
 * 截图结果 URL 前缀——同上。尾随 ` → artifact <id>` 为结构标记，不译。
 */
export const BROWSER_SCREENSHOT_OF_PREFIX = '截图于'

/**
 * 快照结果中可访问性树段落前缀——desktop browser-mirror 靠 includes 保留树文本。
 */
export const COMPUTER_USE_A11Y_TREE_PREFIX = '可访问性树'
