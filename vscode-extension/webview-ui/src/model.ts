/**
 * SSE 事件流 → 可渲染消息模型的 reducer。
 *
 * 事实源是 server 事件（历史与实时同一条流，seq 有序），本层只做展示聚合：
 * 连续 text_delta 并入同一 assistant 气泡、tool_result 按 id 追加到对应
 * tool 卡、审批按 requestId 配对 resolved。未知事件类型一律忽略（向后兼容）。
 */
import type { SessionEvent } from './bridge.js'

export interface QuestionSpec {
  id: string
  prompt: string
  options: string[]
  allowMultiple?: boolean
}

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result: string; isError: boolean }
  | { kind: 'approval'; requestId: string; toolName: string; input: unknown; decision?: string }
  | { kind: 'question'; toolUseId: string; questions: QuestionSpec[]; answered?: boolean }
  | { kind: 'plan'; slug: string; title: string; status: string }
  | { kind: 'info'; text: string }

export interface TodoItem {
  id: string
  content: string
  status: string
}

export interface ChatState {
  items: ChatItem[]
  status: string
  /** 有未决审批时 > 0，驱动输入区置顶提示。 */
  pendingApprovals: number
  /** todo 工具最新写入的任务清单（todo_state 全量镜像）。 */
  todos: TodoItem[]
  /** plan mode: 'off' | 'planning' */
  planMode: string
  /** plan mode 起草中（plan_draft 帧驱动的轻量指示，不渲染正文）。 */
  planDrafting: boolean
  /** 当前模型/星域（事件驱动，选择器懒加载列表）。 */
  model?: string
  domain?: string
}

export const initialChatState: ChatState = {
  items: [],
  status: 'idle',
  pendingApprovals: 0,
  todos: [],
  planMode: 'off',
  planDrafting: false,
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function reduceEvent(state: ChatState, ev: SessionEvent): ChatState {
  const items = state.items
  const last = items[items.length - 1]
  const d = ev.data ?? {}

  switch (ev.type) {
    case 'user':
      return push(state, { kind: 'user', text: asText(d.text) })

    case 'text_delta': {
      if (last?.kind === 'assistant') {
        return replaceLast(state, { ...last, text: last.text + asText(d.text) })
      }
      return push(state, { kind: 'assistant', text: asText(d.text) })
    }

    case 'thinking_delta': {
      if (last?.kind === 'thinking') {
        return replaceLast(state, { ...last, text: last.text + asText(d.text) })
      }
      return push(state, { kind: 'thinking', text: asText(d.text) })
    }

    case 'tool_use':
      return push(state, {
        kind: 'tool',
        id: asText(d.id),
        name: asText(d.name),
        input: d.input,
        result: '',
        isError: false,
      })

    case 'tool_result': {
      // result 可能分块多条（server 侧按字节 coalesce），按 id 向后查找追加。
      const id = asText(d.id)
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it?.kind === 'tool' && it.id === id) {
          const next = [...items]
          next[i] = { ...it, result: it.result + asText(d.result), isError: it.isError || d.isError === true }
          return { ...state, items: next }
        }
      }
      return state
    }

    case 'approval_required':
      return {
        ...push(state, {
          kind: 'approval',
          requestId: asText(d.requestId),
          toolName: asText(d.toolName),
          input: d.input,
        }),
        pendingApprovals: state.pendingApprovals + 1,
      }

    case 'approval_resolved': {
      const rid = asText(d.requestId)
      const next = items.map((it) =>
        it.kind === 'approval' && it.requestId === rid && !it.decision
          ? { ...it, decision: asText(d.decision) || 'approve' }
          : it,
      )
      return { ...state, items: next, pendingApprovals: Math.max(0, state.pendingApprovals - 1) }
    }

    case 'user_question': {
      const raw = Array.isArray(d.questions) ? d.questions : []
      const questions: QuestionSpec[] = raw
        .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
        .map((q) => ({
          id: asText(q.id),
          prompt: asText(q.prompt),
          options: Array.isArray(q.options) ? q.options.map((o) => asText(o)).filter(Boolean) : [],
          allowMultiple: q.allowMultiple === true,
        }))
        .filter((q) => q.prompt && q.options.length > 0)
      if (questions.length === 0) return state
      return push(state, { kind: 'question', toolUseId: asText(d.toolUseId), questions })
    }

    case 'todo_state': {
      const raw = Array.isArray(d.items) ? d.items : []
      const todos: TodoItem[] = raw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({ id: asText(t.id), content: asText(t.content), status: asText(t.status) }))
        .filter((t) => t.content)
      return { ...state, todos }
    }

    case 'plan_mode': {
      const mode = asText(d.state) || state.planMode
      // 退出 plan mode 时清起草指示（草稿要么已 submit 要么已废弃）
      return { ...state, planMode: mode, planDrafting: mode === 'planning' && state.planDrafting }
    }

    case 'plan_draft':
      return { ...state, planDrafting: true }

    case 'model_switched':
      return { ...state, model: asText(d.modelId) || state.model }

    case 'domain_changed':
      return { ...state, domain: asText(d.name) || asText(d.key) || state.domain }

    case 'status':
      return { ...state, status: asText(d.status) || state.status }

    case 'done':
      // Run 收束——落终态（completed/failed/aborted）。缺了这一分支 status 会
      // 永远停在 'running'，下一条消息被误当 steer 发送（server 409）。
      return { ...state, status: asText(d.status) || 'idle' }

    case 'error':
      return push(state, { kind: 'info', text: `⚠ ${asText(d.message) || asText(d.error) || '未知错误'}` })

    case 'steer_queued':
      return push(state, { kind: 'info', text: '↪ 已排队插话，将在下一个工具边界注入' })

    case 'plan_submitted': {
      const slug = asText(d.slug)
      const title = asText(d.title)
      const status = asText(d.status) || 'submitted'
      if (!slug) return push(state, { kind: 'info', text: '📋 计划已提交审批' })
      // 同一计划的状态更新（reject → 再 submit）原位刷新，不重复出卡
      const idx = items.findIndex((it) => it.kind === 'plan' && it.slug === slug)
      const drafted = { ...state, planDrafting: false }
      if (idx >= 0) {
        const next = [...items]
        next[idx] = { kind: 'plan', slug, title: title || (items[idx] as { title: string }).title, status }
        return { ...drafted, items: next }
      }
      return push(drafted, { kind: 'plan', slug, title, status })
    }

    default:
      return state
  }
}

function push(state: ChatState, item: ChatItem): ChatState {
  return { ...state, items: [...state.items, item] }
}

function replaceLast(state: ChatState, item: ChatItem): ChatState {
  return { ...state, items: [...state.items.slice(0, -1), item] }
}
