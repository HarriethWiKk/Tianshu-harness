/**
 * ask_image — the vision co-pilot's query tool.
 *
 * Lets the main model re-interrogate an image the user (or a tool screenshot)
 * already put into the session, any number of times, from different angles —
 * without the user re-sending it.
 *
 * Two modes, chosen by the session (via the visionAsk handle), transparent to
 * the model:
 *  - Multimodal primary → the original image is forwarded back to the primary so
 *    it sees the pixels itself (this is the path that lights up for free the day
 *    the primary model becomes multimodal).
 *  - Text-only primary → the configured vision bridge answers the specific
 *    question; repeated same-angle asks hit the description cache (zero calls).
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export const ASK_IMAGE_TOOL: Tool = {
  definition: {
    name: 'ask_image',
    description: `就本会话中已发送的图片提出具体问题（视觉副驾）。

### 何时调用
- 用户发过图片，你需要就图中某个细节再确认（"第几行的报错文本"、"这个按钮的坐标"、"配色值"）。
- 你之前拿到的是图片描述，但需要换个角度看同一张图。

### 做了什么
把你的问题定向发给视觉模型（或在主控支持识图时直接看原图），返回针对该问题的答案。
可反复调用、可指定不同图片。

### 字段
- question：你要问的具体问题（越具体越好，如"逐字念出红色报错那一行"）。
- imageId（可选）：目标图片 id（如 img_1）；省略则用最近一张图。`,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '就图片提出的具体问题' },
        imageId: { type: 'string', description: '可选：目标图片 id（如 img_1），省略用最近一张' },
      },
      required: ['question'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const question = params.input.question
    if (typeof question !== 'string' || !question.trim()) {
      return { content: '错误：question 必填（要就图片问的具体问题）', isError: true }
    }
    const imageId = typeof params.input.imageId === 'string' && params.input.imageId.trim()
      ? params.input.imageId.trim()
      : undefined

    if (!params.visionAsk) {
      // worker / 无 registry / 未配视觉桥 → 视觉不可用。
      return {
        content: '视觉功能当前不可用（无已保留的图片，或未配置识图模型）。'
          + '如需识图，请在 Settings → 识图模型 选一个视觉模型。',
        isError: true,
      }
    }

    const result = await params.visionAsk(imageId, question.trim(), params.abortSignal)

    if (result.error) {
      return { content: `视觉查询失败：${result.error}`, isError: true }
    }
    if (result.forwardImage) {
      // 多模态主控：把原图作为 ToolResult.images 返回，tool-execution 的视觉通道会
      // 在 supportsVision 时把它转发给主控原生识图；文本内容作为占位提示。
      return {
        content: `已把图片${imageId ? `（${imageId}）` : ''}附上供你直接查看，请据此回答：${question.trim()}`,
        images: [result.forwardImage],
      }
    }
    if (result.answer) {
      const cacheNote = result.cached ? '（缓存）' : ''
      return { content: `${result.answer}${cacheNote}` }
    }
    return { content: '视觉模型未返回内容，请换个问法或重试。', isError: true }
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe(): boolean {
    return true
  },

  isEnabled(): boolean {
    return true
  },
}
