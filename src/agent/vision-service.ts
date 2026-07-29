/**
 * Vision bridge — describes images through a dedicated multimodal model.
 *
 * When the primary model does not support vision, user-supplied image data URLs
 * are routed here to produce a text description, which is then prepended to the
 * primary prompt so the main model still receives the image content.
 */

import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest, OaiContentPart } from '../api/oai-types.js'

const DEFAULT_VISION_PROMPT = '请用中文详细描述这张图片的内容、文字、界面元素和可能的用途。'

export interface DescribeImagesOptions {
  /** Prompt template for the vision model. */
  prompt?: string
  /** Max output tokens for the description. */
  maxTokens?: number
  /** Abort signal. */
  signal?: AbortSignal
}

/**
 * Send one or more images to a multimodal model and return a text description.
 *
 * The client is assumed to be already configured with the correct provider and
 * model (e.g. built by create-agent-config's vision bridge). This function wraps
 * the streaming interface into a one-shot completion.
 */
export async function describeImages(
  client: StreamClient,
  images: string[],
  options: DescribeImagesOptions = {},
): Promise<string> {
  if (images.length === 0) return ''

  const prompt = options.prompt ?? DEFAULT_VISION_PROMPT
  const parts: OaiContentPart[] = [{ type: 'text', text: prompt }]
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } })
  }

  const request: OaiChatRequest = {
    model: '', // client already binds the model
    messages: [{ role: 'user', content: parts }],
    max_tokens: options.maxTokens ?? 1024,
    stream: true,
  }

  // 两个回调携带的是**同一段文本**，不是两半：onTextDelta 是流式增量（给 UI），
  // onContentBlock 在收流结束时把累积的完整文本再发一次（给持久化——openai-client
  // 那处注释写明 agent loop 靠 content block 落库）。消费方必须取其一；原先两边都
  // 往一个数组里塞，于是每次桥接的描述都被精确复制一遍：注入主历史的 token 翻倍，
  // 模型读到的还是一段自我重复的文字。实测 MiniMax-M3 描述一张截图返回 3516 字，
  // 其中一半是复本。以 content block 为准（它是权威终值），没有它才退回增量拼接
  // （早退/中断/未实现该回调的 client）。
  const deltas: string[] = []
  const blocks: string[] = []
  let error: Error | undefined
  let stopReason = ''

  await client.stream(
    request,
    {
      onTextDelta: (text) => { deltas.push(text) },
      onThinkingDelta: () => { /* vision models rarely stream reasoning; ignore */ },
      onContentBlock: (block) => {
        if (block.type === 'text' && block.text) blocks.push(block.text)
      },
      onStopReason: (reason) => { stopReason = reason },
      onError: (err) => { error = err },
    },
    options.signal,
  )

  if (error) throw error
  const text = blocks.length > 0 ? blocks.join('') : deltas.join('')

  return (stopReason === 'length' ? `${text}\n[图片描述被截断]` : text).trim()
}
