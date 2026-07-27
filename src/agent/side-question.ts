/**
 * `/btw` 侧问（Wave 1-3）。
 *
 * 定位是 subagent 的逆命题：**subagent 有完整工具但从空上下文开始，侧问看得见
 * 完整对话却没有任何工具**。用来问"刚才那个报错是什么意思""这个改动为什么要这么
 * 做"这类**关于当前会话本身**的问题——答案已经在上下文里，缺的只是把它说出来。
 *
 * 三条硬性边界：
 *
 * 1. **永不进入对话历史。** 问与答都活在一个可关闭的浮层里。这是它便宜的根本
 *    原因：主对话的字节一个都没动，下一个主 turn 的前缀依旧逐字节命中。若把侧问
 *    写回历史，就退化成一次普通提问，还白白改了前缀。
 *
 * 2. **无工具。** 只能基于已在上下文里的内容回答。答不上来就说答不上来，
 *    不许猜——猜出来的答案在这个场景里比"不知道"更糟。
 *
 * 3. **不打断主 turn。** agent 干活时也能问，走侧路并发，主流程无感。
 */

import { askSidePath, type SidePathAskDeps } from './side-path-ask.js'

export type SideQuestionDeps = SidePathAskDeps

export interface SideQuestionParams {
  question: string
  timeoutMs?: number
  signal?: AbortSignal
  onDelta?: (chunk: string) => void
}

const DEFAULT_TIMEOUT_MS = 45_000

export function buildSideQuestionInstruction(question: string): string {
  return [
    '【侧路提问】用户在不打断当前任务的前提下问了一个问题。',
    '你的回答**不会进入对话历史**，也不会影响正在进行的工作。',
    '',
    '规则：',
    '- 你**没有任何工具**。只能基于上面已有的对话内容回答。',
    '- 需要读文件、跑命令、查外部资料才能答的，直接说明需要什么，不要猜。',
    '- 不要执行任务、不要改代码、不要给出待办清单——这是一次问答，不是一次委派。',
    '- 简洁作答，能一段说清就不要分点。',
    '',
    '问题：',
    question,
  ].join('\n')
}

/**
 * 就当前会话上下文回答一个侧问。返回 null 表示不可用（无客户端 / 出错 / 超时 /
 * 无输出），调用方静默降级。
 */
export async function askSideQuestion(
  deps: SideQuestionDeps,
  params: SideQuestionParams,
): Promise<string | null> {
  const question = params.question.trim()
  if (!question) return null

  return askSidePath(deps, {
    instruction: buildSideQuestionInstruction(question),
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    onDelta: params.onDelta,
  })
}
