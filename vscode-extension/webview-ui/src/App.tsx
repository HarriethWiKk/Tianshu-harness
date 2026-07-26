import { useEffect, useMemo, useReducer, useRef, useState, useCallback, type DragEvent } from 'react'
import {
  onHostMessage,
  send,
  type DomainEntry,
  type HostMsg,
  type ModelEntry,
  type PlanDocument,
  type ProviderConfigList,
  type SessionEvent,
  type SessionRecord,
} from './bridge.js'
import { renderMarkdown } from './markdown.js'
import { initialChatState, reduceEvent, type ChatState, type ChatItem, type QuestionSpec } from './model.js'

type SidecarState = 'starting' | 'ready' | 'dead'

function chatReducer(state: ChatState, action: { type: 'event'; ev: SessionEvent } | { type: 'reset' }): ChatState {
  if (action.type === 'reset') return initialChatState
  return reduceEvent(state, action.ev)
}

let fileReqSeq = 0

export function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [sidecar, setSidecar] = useState<SidecarState>('starting')
  const [sidecarDetail, setSidecarDetail] = useState('')
  const [live, setLive] = useState(false)
  const [errorBanner, setErrorBanner] = useState('')
  const [models, setModels] = useState<ModelEntry[]>([])
  const [domains, setDomains] = useState<DomainEntry[]>([])
  const [fileHits, setFileHits] = useState<string[]>([])
  const fileReqRef = useRef(0)
  const [chat, dispatch] = useReducer(chatReducer, initialChatState)
  const bottomRef = useRef<HTMLDivElement>(null)
  // undefined=探测中 / null=内核无 config 路由（不挡对话）/ list=已知配置面
  const [providerConfig, setProviderConfig] = useState<ProviderConfigList | null | undefined>(undefined)
  const [plans, setPlans] = useState<Record<string, PlanDocument>>({})
  const [planDecisions, setPlanDecisions] = useState<Record<string, string>>({})
  // SSE 曾经连上过（用于区分「首连中」与「断线重连中」）
  const everLiveRef = useRef(false)

  useEffect(() => {
    const off = onHostMessage((msg: HostMsg) => {
      switch (msg.type) {
        case 'sessions':
          setSessions(msg.sessions)
          break
        case 'sessionCreated':
          setSessions((prev) => [msg.session, ...prev])
          setActiveId(msg.session.id)
          send({ type: 'listPickers', sessionId: msg.session.id })
          break
        case 'sessionAttached':
          setActiveId(msg.sessionId)
          dispatch({ type: 'reset' })
          everLiveRef.current = false
          send({ type: 'listPickers', sessionId: msg.sessionId })
          break
        case 'event':
          dispatch({ type: 'event', ev: msg.event })
          break
        case 'streamState':
          if (msg.live) everLiveRef.current = true
          setLive(msg.live)
          break
        case 'sidecarState':
          setSidecar(msg.state)
          setSidecarDetail(msg.detail ?? '')
          // 内核就绪即探测 provider 配置（首启无 key → Setup 卡）
          if (msg.state === 'ready') send({ type: 'listProviders' })
          break
        case 'pickers':
          setModels(msg.models)
          setDomains(msg.domains)
          break
        case 'files':
          if (msg.reqId === fileReqRef.current) setFileHits(msg.files)
          break
        case 'error':
          setErrorBanner(msg.message)
          break
        case 'providers':
          setProviderConfig(msg.config)
          break
        case 'plan':
          setPlans((prev) => ({ ...prev, [msg.plan.slug]: msg.plan }))
          break
        case 'planDecisionResult':
          if (msg.ok) {
            setPlanDecisions((prev) => ({ ...prev, [msg.slug]: msg.decision }))
          } else {
            setErrorBanner(msg.message ?? '计划操作失败')
          }
          break
      }
    })
    send({ type: 'ready' })
    send({ type: 'listProviders' })
    return off
  }, [])

  // 新内容到达时贴底滚动（用户上滚查看历史时不打扰）。
  useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const scroller = el.parentElement
    if (!scroller) return
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    if (nearBottom) el.scrollIntoView()
  }, [chat.items])

  const running = chat.status === 'running'
  // 有任何一个 provider 有可用 key 即视为已配置；null（旧内核）不挡对话
  const needsSetup =
    providerConfig !== undefined &&
    providerConfig !== null &&
    !providerConfig.providers.some((p) => p.keyStatus.source !== 'none')
  const reconnecting = sidecar === 'ready' && !!activeId && !live && everLiveRef.current

  const submit = useCallback(
    (text: string) => {
      setErrorBanner('')
      if (!activeId) {
        send({ type: 'createSession', prompt: text })
        return
      }
      send({ type: running ? 'steer' : 'prompt', sessionId: activeId, text })
    },
    [activeId, running],
  )

  const queryFiles = useCallback(
    (q: string) => {
      if (!activeId) return
      const reqId = ++fileReqSeq
      fileReqRef.current = reqId
      send({ type: 'queryFiles', sessionId: activeId, q, reqId })
    },
    [activeId],
  )

  return (
    <div className="app">
      <Header
        sessions={sessions}
        activeId={activeId}
        live={live}
        sidecar={sidecar}
        onSelect={(id) => send({ type: 'selectSession', sessionId: id })}
        onNew={() => {
          setActiveId(undefined)
          dispatch({ type: 'reset' })
        }}
      />
      {activeId && (
        <Toolbar
          sessionId={activeId}
          models={models}
          domains={domains}
          planMode={chat.planMode}
          planDrafting={chat.planDrafting}
          running={running}
          approvalMode={sessions.find((s) => s.id === activeId)?.approvalMode ?? 'manual'}
          onApprovalMode={(mode) => {
            send({ type: 'setApprovalMode', sessionId: activeId, mode })
            setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, approvalMode: mode } : s)))
          }}
          onTogglePlanMode={() =>
            send({ type: 'setPlanMode', sessionId: activeId, state: chat.planMode === 'planning' ? 'off' : 'planning' })
          }
        />
      )}
      {sidecar === 'dead' && (
        <div className="banner error">内核不可用：{sidecarDetail || '进程已退出'}（命令面板 → 天枢: 重启内核）</div>
      )}
      {sidecar === 'starting' && sidecarDetail && <div className="banner">{sidecarDetail}</div>}
      {reconnecting && <div className="banner">连接断开，重连中…</div>}
      {errorBanner && <div className="banner error">{errorBanner}</div>}
      {chat.todos.length > 0 && <TodoPanel todos={chat.todos} />}
      {needsSetup ? (
        <SetupCard config={providerConfig} />
      ) : (
      <div className="messages">
        {chat.items.length === 0 && (
          <div className="empty">
            {activeId ? '（空会话）' : '输入首条任务开始新会话；agent 与 CLI 端同源，会话数据互通。'}
          </div>
        )}
        {chat.items.map((item, i) => (
          <Item
            key={i}
            item={item}
            sessionId={activeId}
            running={running}
            streaming={running && i === chat.items.length - 1}
            plans={plans}
            planDecisions={planDecisions}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      )}
      <Composer
        running={running}
        disabled={sidecar === 'dead' || needsSetup}
        fileHits={fileHits}
        onQueryFiles={queryFiles}
        onClearFiles={() => setFileHits([])}
        onSubmit={submit}
        onAbort={() => activeId && send({ type: 'abort', sessionId: activeId })}
      />
    </div>
  )
}

function Header(props: {
  sessions: SessionRecord[]
  activeId?: string
  live: boolean
  sidecar: SidecarState
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="header">
      <select
        value={props.activeId ?? ''}
        onChange={(e) => e.target.value && props.onSelect(e.target.value)}
        title="切换会话"
      >
        <option value="">— 选择会话 —</option>
        {props.sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {(s.title ?? s.id.slice(0, 8)) + (s.status === 'running' ? ' ⏵' : '')}
          </option>
        ))}
      </select>
      <button onClick={props.onNew} title="新建会话">＋</button>
      <span className={`dot ${props.sidecar === 'ready' ? (props.live ? 'live' : 'idle') : 'dead'}`} title={`内核: ${props.sidecar}${props.live ? ' · 流已连接' : ''}`} />
    </div>
  )
}

const APPROVAL_MODES: { value: string; label: string; hint: string }[] = [
  { value: 'manual', label: '手动审批', hint: '每个敏感操作都需确认' },
  { value: 'auto-safe', label: '自动·安全', hint: '只读/安全操作自动放行，写操作仍需确认' },
  { value: 'auto-accept', label: '自动接受', hint: '全部自动放行（信任当前任务时使用）' },
]

function Toolbar(props: {
  sessionId: string
  models: ModelEntry[]
  domains: DomainEntry[]
  planMode: string
  planDrafting: boolean
  running: boolean
  approvalMode: string
  onApprovalMode: (mode: string) => void
  onTogglePlanMode: () => void
}) {
  const currentModel = props.models.find((m) => m.current)
  const currentDomain = props.domains.find((d) => d.current)
  return (
    <div className="toolbar">
      <select
        value={currentModel?.id ?? ''}
        disabled={props.running || props.models.length === 0}
        title="切换模型（仅空闲时；保留历史）"
        onChange={(e) => {
          if (e.target.value) {
            send({ type: 'switchModel', sessionId: props.sessionId, modelId: e.target.value })
            send({ type: 'listPickers', sessionId: props.sessionId })
          }
        }}
      >
        {props.models.length === 0 && <option value="">模型</option>}
        {props.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.alias || m.id}（{m.provider}）
          </option>
        ))}
      </select>
      <select
        value={currentDomain?.key ?? 'auto'}
        disabled={props.domains.length === 0}
        title="切换星域。⚠ 会话中途切换会使前缀缓存整体失效（成本约 10 倍+），建议新会话时选择"
        onChange={(e) => {
          send({ type: 'setDomain', sessionId: props.sessionId, key: e.target.value })
          send({ type: 'listPickers', sessionId: props.sessionId })
        }}
      >
        {props.domains.length === 0 && <option value="auto">星域</option>}
        {props.domains.map((d) => (
          <option key={d.key} value={d.key} title={d.motto}>
            {d.name}
          </option>
        ))}
      </select>
      <select
        value={APPROVAL_MODES.some((m) => m.value === props.approvalMode) ? props.approvalMode : 'manual'}
        title="审批模式"
        onChange={(e) => props.onApprovalMode(e.target.value)}
      >
        {APPROVAL_MODES.map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
      <button
        className={`plan-toggle ${props.planMode === 'planning' ? 'active' : ''}`}
        title={props.planMode === 'planning' ? '退出计划模式，恢复正常执行' : '进入计划模式（只读规划，产出计划待审批）'}
        onClick={props.onTogglePlanMode}
      >
        📋 {props.planMode === 'planning' ? '退出计划' : '计划'}
      </button>
      {props.planMode === 'planning' && (
        <span className="badge plan">📋 Plan Mode{props.planDrafting ? ' · 起草中…' : ''}</span>
      )}
    </div>
  )
}

/**
 * 首启 Setup 引导卡：选 provider 预设 + 填 API key，一步配好默认模型。
 * key 只经 postMessage 一次性交宿主调 REST，不进 webview 状态持久化。
 */
function SetupCard({ config }: { config: ProviderConfigList }) {
  const CUSTOM = '__custom__'
  // 候选：未配置的预设 + 已配置但无 key 的 provider
  const presets = useMemo(() => {
    const noKey = config.providers
      .filter((p) => p.keyStatus.source === 'none')
      .map((p) => ({ key: p.name, label: p.label }))
    const fresh = config.unconfigured.map((u) => ({ key: u.key, label: u.label }))
    const seen = new Set<string>()
    return [...noKey, ...fresh].filter((p) => !seen.has(p.key) && seen.add(p.key))
  }, [config])

  const [provider, setProvider] = useState(presets[0]?.key ?? CUSTOM)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [customName, setCustomName] = useState('custom')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    return onHostMessage((msg: HostMsg) => {
      if (msg.type === 'providerSetupResult') {
        setBusy(false)
        if (!msg.ok) setError(msg.message ?? '保存失败')
        // 成功时宿主会紧跟重发 providers，App 层 needsSetup 自动翻转放行
      }
    })
  }, [])

  const isCustom = provider === CUSTOM
  const canSave = !busy && (isCustom ? !!(customName.trim() && baseUrl.trim() && modelId.trim()) : !!apiKey.trim())

  const save = () => {
    if (!canSave) return
    setError('')
    setBusy(true)
    if (isCustom) {
      send({
        type: 'setupProvider',
        providerName: customName.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        custom: true,
      })
    } else {
      send({ type: 'setupProvider', providerName: provider, apiKey: apiKey.trim() })
    }
    setApiKey('')
  }

  return (
    <div className="messages">
      <div className="setup-card">
        <h3>欢迎使用天枢</h3>
        <p>还没有可用的 API key。选择一个模型提供商完成配置，即可开始对话（配置写入 ~/.rivet，与 CLI 端共用）。</p>
        <label>
          提供商
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
            {presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>自定义端点（OpenAI 兼容）</option>
          </select>
        </label>
        {isCustom && (
          <>
            <label>
              名称
              <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="my-provider" disabled={busy} />
            </label>
            <label>
              Base URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" disabled={busy} />
            </label>
            <label>
              模型 ID
              <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="例如 deepseek-chat / qwen3:32b" disabled={busy} />
            </label>
          </>
        )}
        <label>
          API key{isCustom ? '（本地端点可留空）' : ''}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </label>
        {error && <div className="banner error">{error}</div>}
        <div className="actions">
          <button className="approve" onClick={save} disabled={!canSave}>
            {busy ? '保存中…' : '保存并开始'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TodoPanel({ todos }: { todos: ChatState['todos'] }) {
  const doneCount = todos.filter((t) => t.status === 'completed').length
  return (
    <details className="todo-panel" open>
      <summary>
        任务清单 {doneCount}/{todos.length}
      </summary>
      <ul>
        {todos.map((t) => (
          <li key={t.id || t.content} className={t.status}>
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : t.status === 'cancelled' ? '✕' : '○'} {t.content}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** 工具输入里常见的文件路径字段，用于渲染跳转链接。 */
function toolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const v = o[key]
    if (typeof v === 'string' && v && !v.startsWith('/')) return v
  }
  return undefined
}

function Item({
  item,
  sessionId,
  running,
  streaming,
  plans,
  planDecisions,
}: {
  item: ChatItem
  sessionId?: string
  running: boolean
  /** 该条是否为流式尾巴——流式中保持纯文本，完成后才 markdown 化（避免逐帧重排）。 */
  streaming: boolean
  plans: Record<string, PlanDocument>
  planDecisions: Record<string, string>
}) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'assistant':
      return streaming ? <div className="msg assistant">{item.text}</div> : <AssistantMarkdown text={item.text} />
    case 'thinking':
      return (
        <details className="msg thinking">
          <summary>思考过程</summary>
          <pre>{item.text}</pre>
        </details>
      )
    case 'tool': {
      const filePath = toolFilePath(item.input)
      return (
        <details className={`msg tool ${item.isError ? 'error' : ''}`}>
          <summary>
            🔧 {item.name}
            {filePath && (
              <a
                className="file-link"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  send({ type: 'openFile', path: filePath })
                }}
              >
                {filePath}
              </a>
            )}
            {item.isError ? ' ⚠' : ''}
          </summary>
          <pre className="tool-input">{safeJson(item.input)}</pre>
          {item.result && <pre className="tool-result">{truncate(item.result, 4000)}</pre>}
        </details>
      )
    }
    case 'approval':
      return <ApprovalCard item={item} sessionId={sessionId} />
    case 'question':
      return <QuestionCard toolUseId={item.toolUseId} questions={item.questions} sessionId={sessionId} running={running} />
    case 'plan':
      return (
        <PlanCard
          slug={item.slug}
          title={item.title}
          status={item.status}
          sessionId={sessionId}
          plan={plans[item.slug]}
          decision={planDecisions[item.slug]}
        />
      )
    case 'info':
      return <div className="msg info">{item.text}</div>
  }
}

function AssistantMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="msg assistant md" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * 工具审批卡。批准/拒绝之外对齐桌面端 handleApproval 的两个深度能力：
 * 「改参数后批准」（editedInput，JSON 解析失败 fail-closed 不发送）与
 * 「记住本次会话同类决策」（remember）。
 */
function ApprovalCard({ item, sessionId }: { item: Extract<ChatItem, { kind: 'approval' }>; sessionId?: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [parseError, setParseError] = useState('')
  const [remember, setRemember] = useState(false)

  const answer = (decision: 'approve' | 'deny', editedInput?: Record<string, unknown>) => {
    if (!sessionId) return
    send({
      type: 'approval',
      sessionId,
      requestId: item.requestId,
      decision,
      ...(editedInput ? { editedInput } : {}),
      ...(remember ? { remember: true } : {}),
    })
  }

  const approveEdited = () => {
    try {
      const parsed: unknown = JSON.parse(draft)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setParseError('参数必须是 JSON 对象')
        return
      }
      setParseError('')
      answer('approve', parsed as Record<string, unknown>)
    } catch (err) {
      setParseError(`JSON 解析失败：${(err as Error).message}`)
    }
  }

  return (
    <div className="msg approval">
      <div>
        🛡 <b>{item.toolName}</b> 请求执行
      </div>
      {editing ? (
        <textarea
          className="approval-edit"
          value={draft}
          rows={Math.min(14, draft.split('\n').length + 1)}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <pre>{truncate(safeJson(item.input), 1200)}</pre>
      )}
      {item.decision ? (
        <div className="decision">{item.decision === 'approve' ? '✓ 已批准' : `✗ ${item.decision}`}</div>
      ) : (
        <>
          {parseError && <div className="approval-error">{parseError}</div>}
          <label className="approval-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住本次会话同类决策
          </label>
          <div className="actions">
            {editing ? (
              <>
                <button className="approve" onClick={approveEdited}>
                  以修改后参数批准
                </button>
                <button
                  onClick={() => {
                    setEditing(false)
                    setParseError('')
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button className="approve" onClick={() => answer('approve')}>
                  批准
                </button>
                <button
                  onClick={() => {
                    setDraft(JSON.stringify(item.input ?? {}, null, 2))
                    setEditing(true)
                  }}
                >
                  改参数…
                </button>
                <button className="deny" onClick={() => answer('deny')}>
                  拒绝
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Plan 审批卡：plan_submitted 帧出卡 → 展开时按需拉正文（GET /plans/:slug）
 * → 批准/驳回走 plans REST。驳回意见组装为普通文本输入。
 * 对齐桌面端 PlanPanel：多方案（options≥2）radio 选择随批准回传 selectedApproach；
 * submitted 状态可编辑正文（PUT /plans/:slug，保存后宿主重推 plan 刷新）。
 */
function PlanCard(props: {
  slug: string
  title: string
  status: string
  sessionId?: string
  plan?: PlanDocument
  decision?: string
}) {
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [selectedApproach, setSelectedApproach] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [editError, setEditError] = useState('')
  const requested = useRef(false)

  const fetchPlan = () => {
    if (requested.current || props.plan || !props.sessionId) return
    requested.current = true
    send({ type: 'readPlan', sessionId: props.sessionId, slug: props.slug })
  }

  // 编辑保存结果回流（宿主保存成功后会紧跟重推 plan，props.plan 自动刷新）
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === 'planEditResult' && msg.slug === props.slug) {
        if (msg.ok) {
          setEditing(false)
          setEditError('')
        } else {
          setEditError(msg.message ?? '保存失败')
        }
      }
    })
  }, [props.slug])

  const decided = props.decision ?? (props.status !== 'submitted' ? props.status : undefined)
  const html = useMemo(() => (props.plan ? renderMarkdown(props.plan.content) : ''), [props.plan])
  const options = props.plan?.options ?? []

  return (
    <div className="msg plan-card">
      <div className="plan-head">
        📋 <b>{props.title || props.slug}</b>
        <span className={`badge plan-status ${decided ?? 'submitted'}`}>
          {decided === 'approve' || decided === 'approved' || decided === 'executed'
            ? '✓ 已批准'
            : decided === 'reject' || decided === 'rejected'
              ? '✗ 已驳回'
              : '待审批'}
        </span>
      </div>
      <details onToggle={(e) => (e.target as HTMLDetailsElement).open && fetchPlan()}>
        <summary>查看计划正文</summary>
        {props.plan ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="empty">加载中…</div>}
      </details>
      {editing && (
        <>
          <textarea
            className="plan-edit"
            value={editDraft}
            rows={Math.min(24, editDraft.split('\n').length + 1)}
            onChange={(e) => setEditDraft(e.target.value)}
          />
          {editError && <div className="approval-error">{editError}</div>}
          <div className="actions">
            <button
              className="approve"
              onClick={() => {
                if (!editDraft.trim()) {
                  setEditError('计划内容不能为空')
                  return
                }
                setEditError('')
                send({ type: 'editPlan', sessionId: props.sessionId!, slug: props.slug, content: editDraft })
              }}
            >
              保存修改
            </button>
            <button
              onClick={() => {
                setEditing(false)
                setEditError('')
              }}
            >
              取消
            </button>
          </div>
        </>
      )}
      {!decided && !editing && options.length >= 2 && props.sessionId && (
        <div className="plan-options">
          <div className="plan-options-label">选择执行方案</div>
          {options.map((opt) => (
            <label key={opt.id} className={`plan-option ${selectedApproach === opt.label ? 'active' : ''}`}>
              <input
                type="radio"
                name={`plan-option-${props.slug}`}
                checked={selectedApproach === opt.label}
                onChange={() => setSelectedApproach(opt.label)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
      {!decided && !editing && props.sessionId && (
        <div className="actions">
          {rejecting ? (
            <>
              <input
                value={comment}
                placeholder="驳回意见（可选，会作为修订反馈回传）"
                onChange={(e) => setComment(e.target.value)}
              />
              <button
                className="deny"
                onClick={() =>
                  send({ type: 'planDecision', sessionId: props.sessionId!, slug: props.slug, decision: 'reject', comment: comment.trim() || undefined })
                }
              >
                确认驳回
              </button>
              <button onClick={() => setRejecting(false)}>取消</button>
            </>
          ) : (
            <>
              <button
                className="approve"
                onClick={() =>
                  send({
                    type: 'planDecision',
                    sessionId: props.sessionId!,
                    slug: props.slug,
                    decision: 'approve',
                    ...(options.length >= 2 && selectedApproach ? { selectedApproach } : {}),
                  })
                }
              >
                批准并执行
              </button>
              <button
                onClick={() => {
                  if (!props.plan) {
                    fetchPlan()
                    return
                  }
                  setEditDraft(props.plan.content)
                  setEditing(true)
                }}
                title={props.plan ? '修改计划正文' : '先加载计划正文'}
              >
                编辑…
              </button>
              <button className="deny" onClick={() => setRejecting(true)}>
                驳回…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * ask_user_question 结构化提问卡。答案不走新 API——组装成普通用户消息回传
 * （与桌面端同一约定，server 侧 ask_user_question 工具只回占位符 + endTurn）。
 */
function QuestionCard(props: { toolUseId: string; questions: QuestionSpec[]; sessionId?: string; running: boolean }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [sent, setSent] = useState(false)

  const toggle = (qid: string, option: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[qid] ?? []
      if (!multi) return { ...prev, [qid]: [option] }
      return { ...prev, [qid]: cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option] }
    })
  }

  const submit = () => {
    if (!props.sessionId || sent) return
    const lines = props.questions.map((q) => {
      const ans = picked[q.id]?.join('、') || '（未选择）'
      return props.questions.length > 1 ? `${q.prompt}: ${ans}` : ans
    })
    const text = lines.join('\n')
    send({ type: props.running ? 'steer' : 'prompt', sessionId: props.sessionId, text })
    setSent(true)
  }

  return (
    <div className="msg question">
      {props.questions.map((q) => (
        <div key={q.id} className="q-block">
          <div className="q-prompt">❓ {q.prompt}</div>
          <div className="q-options">
            {q.options.map((opt) => (
              <button
                key={opt}
                className={picked[q.id]?.includes(opt) ? 'picked' : ''}
                disabled={sent}
                onClick={() => toggle(q.id, opt, q.allowMultiple === true)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
      {sent ? (
        <div className="decision">✓ 已回答</div>
      ) : (
        <div className="actions">
          <button className="approve" onClick={submit} disabled={Object.keys(picked).length === 0}>
            提交回答
          </button>
        </div>
      )}
    </div>
  )
}

function Composer(props: {
  running: boolean
  disabled: boolean
  fileHits: string[]
  onQueryFiles: (q: string) => void
  onClearFiles: () => void
  onSubmit: (text: string) => void
  onAbort: () => void
}) {
  const [text, setText] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 编辑器右键「发送到天枢」→ 追加到草稿
  useEffect(() => {
    return onHostMessage((msg: HostMsg) => {
      if (msg.type === 'insertText') {
        setText((prev) => (prev ? `${prev}\n${msg.text}` : msg.text))
        textareaRef.current?.focus()
      }
    })
  }, [])

  /** 光标前最后一个 @token（未闭合的提及查询），无则 null。 */
  const mentionQuery = (value: string): string | null => {
    const m = /(?:^|\s)@([\w\-./]*)$/.exec(value)
    return m ? m[1] ?? '' : null
  }

  const onChange = (value: string) => {
    setText(value)
    const q = mentionQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q === null) {
      props.onClearFiles()
      return
    }
    debounceRef.current = setTimeout(() => props.onQueryFiles(q), 200)
  }

  const pickFile = (path: string) => {
    setText((prev) => prev.replace(/(^|\s)@[\w\-./]*$/, `$1@file:${path} `))
    props.onClearFiles()
    textareaRef.current?.focus()
  }

  const fire = () => {
    const t = text.trim()
    if (!t) return
    props.onSubmit(t)
    setText('')
    props.onClearFiles()
  }

  const onDropFiles = (e: DragEvent) => {
    e.preventDefault()
    const uris: string[] = []
    const uriList = e.dataTransfer.getData('text/uri-list')
    if (uriList) {
      for (const line of uriList.split('\n')) {
        const t = line.trim()
        if (t && !t.startsWith('#')) uris.push(t)
      }
    }
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const f = e.dataTransfer.files[i]
      // Electron/VS Code may expose path on File
      const p = (f as File & { path?: string }).path
      if (p) uris.push(p)
    }
    if (uris.length === 0) return
    const mentions = uris
      .map((u) => {
        try {
          const path = decodeURIComponent(u.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'))
          // Prefer basename-ish relative: strip to last meaningful segment chain
          const parts = path.split(/[/\\]/)
          // Keep last 3 segments as a soft relative hint when absolute
          return `@file:${parts.slice(-3).join('/')}`
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .join(' ')
    if (mentions) setText((prev) => (prev ? `${prev} ${mentions} ` : `${mentions} `))
  }

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      {props.fileHits.length > 0 && (
        <div className="mention-list">
          {props.fileHits.slice(0, 12).map((f) => (
            <div key={f} className="mention-item" onClick={() => pickFile(f)}>
              {f}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        disabled={props.disabled}
        placeholder={props.running ? '运行中——输入将作为插话在下一工具边界注入' : '给天枢一个任务…（@ 提及文件，拖拽文件，Enter 发送，Shift+Enter 换行）'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            fire()
          }
          if (e.key === 'Escape') props.onClearFiles()
        }}
      />
      <div className="composer-actions">
        {props.running && (
          <button className="abort" onClick={props.onAbort} title="中止当前运行">
            ■ 中止
          </button>
        )}
        <button onClick={fire} disabled={props.disabled || !text.trim()}>
          {props.running ? '插话' : '发送'}
        </button>
      </div>
    </div>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return String(v)
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} 字符已截断)` : s
}
