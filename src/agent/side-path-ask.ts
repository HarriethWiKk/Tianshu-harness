/**
 * 侧路提问的公共骨架。
 *
 * 「侧路」指不进入对话历史、不占用主 turn 的一次性问答：审批风险解释、`/btw`
 * 侧问都属此类。它们共享同一套缓存与安全纪律，这里是唯一实现：
 *
 * 1. **复用主前缀**——请求 = 完整对话历史 + 一条追加指令。前缀与主对话逐字节
 *    一致，所以这是缓存**命中**而非碎裂，成本接近只付新增的那点尾巴。
 *
 * 2. **不碰主路径探针**——`buildOaiRequest({ sidePath: true })` 保证请求的
 *    `prefixProbe` 为 undefined 且不记 wire 基线（见 prompt/engine.ts:795,800）。
 *    侧路带上探针会让下一个主轮报幻影 wireDiverged（2026-07-06 事故）。
 *
 * 3. **绝不原地改写调用方的消息**——同一批消息对象会被多个 `stream()` 重入，
 *    原地拼接会让主请求的字节中途翻转，整段前缀失效且成本隐形。这里只做展开。
 *
 * 4. **不给工具**——侧路只回答，不动手。
 *
 * 5. **成本要记账**——侧路照样计费。`recordUsage` 把它落进 `cache-log.jsonl` 的
 *    `side_path` 行，别再制造一次成本盲区。
 */

import type { OaiMessage } from '../api/oai-types.js'
import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { PromptEngine } from '../prompt/engine.js'

export interface SidePathAskDeps {
  client: StreamClient | undefined
  promptEngine: PromptEngine
  getMessages: () => OaiMessage[]
  contextWindow: number
  recordUsage?: (usage: Partial<Usage>, model: string) => void
}

export interface SidePathAskParams {
  /** 追加到历史末尾的指令消息内容。 */
  instruction: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 增量回调，用于把回答边生成边渲染出来。 */
  onDelta?: (chunk: string) => void
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 发一次侧路请求，返回完整文本。
 *
 * 返回 null 表示不可用（无客户端 / 流报错 / 超时 / 被取消 / 无输出）。调用方一律
 * 静默降级——侧路是锦上添花，拿不到不该影响主流程。
 */
export async function askSidePath(
  deps: SidePathAskDeps,
  params: SidePathAskParams,
): Promise<string | null> {
  if (!deps.client) return null

  const request = deps.promptEngine.buildOaiRequest(
    [...deps.getMessages(), { role: 'user' as const, content: params.instruction }],
    undefined,
    deps.contextWindow,
    { sidePath: true },
  )
  request.tools = undefined
  request.tool_choice = 'none'

  const chunks: string[] = []
  let errored = false
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal

  try {
    await deps.client.stream(request, {
      onTextDelta: text => {
        chunks.push(text)
        params.onDelta?.(text)
      },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (_reason, usage) => {
        if (usage && (usage.input_tokens ?? 0) > 0) {
          deps.recordUsage?.(usage, request.model)
        }
      },
      onError: () => { errored = true },
    }, signal)
  } catch {
    return null
  }

  if (errored) return null
  const text = chunks.join('').trim()
  return text.length > 0 ? text : null
}
