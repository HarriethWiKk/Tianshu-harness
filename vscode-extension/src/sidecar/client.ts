/**
 * Sidecar REST + SSE 客户端（扩展宿主侧）。
 *
 * SSE 断线自动以 lastSeq 重连（server 的 GET /stream?since=N 重放尾部），
 * 事件经回调直接透传给 webview 桥——客户端不做业务解释，保持薄。
 */
import type {
  ApprovalAnswer,
  CreateSessionRequest,
  DomainEntry,
  ModelEntry,
  PlanDocument,
  ProviderConfigList,
  SessionEvent,
  SessionRecord,
  SetupCustomProviderRequest,
  SetupProviderRequest,
  WorkingTreeFile,
} from './protocol.js'

export class SidecarClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl
    this.token = token
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* non-json */ }
      throw new Error(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    return (await res.json()) as T
  }

  async listSessions(): Promise<SessionRecord[]> {
    const body = await this.request<{ sessions: SessionRecord[] }>('GET', '/sessions')
    return body.sessions
  }

  createSession(req: CreateSessionRequest): Promise<SessionRecord> {
    return this.request('POST', '/sessions', req)
  }

  getSession(id: string): Promise<SessionRecord> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}`)
  }

  prompt(id: string, prompt: string, images?: string[]): Promise<SessionRecord> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/prompt`, { prompt, images })
  }

  /**
   * T3 — 运行中插话。409（提交瞬间 run 恰好收束）返回 'idle' 而不抛错，
   * 由调用方回退 /prompt 开新 turn——与桌面端 steerSession 同一约定，输入不丢。
   */
  async steer(id: string, text: string): Promise<'queued' | 'idle'> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/steer`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text }),
    })
    if (res.status === 409) return 'idle'
    if (!res.ok) {
      let detail = ''
      try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* non-json */ }
      throw new Error(`POST /sessions/${encodeURIComponent(id)}/steer → ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    return 'queued'
  }

  abort(id: string): Promise<{ aborted: boolean }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/abort`, {})
  }

  resume(id: string): Promise<{ resumed: boolean }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/resume`, {})
  }

  answerApproval(id: string, requestId: string, answer: ApprovalAnswer): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/interventions/${encodeURIComponent(requestId)}/answer`,
      answer,
    )
  }

  setApprovalMode(id: string, mode: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/approval-mode`, { approvalMode: mode })
  }

  async listModels(id: string): Promise<ModelEntry[]> {
    const body = await this.request<{ models: ModelEntry[] }>('GET', `/sessions/${encodeURIComponent(id)}/models`)
    return body.models
  }

  switchModel(id: string, modelId: string): Promise<SessionRecord> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/model`, { modelId })
  }

  async listDomains(id: string): Promise<DomainEntry[]> {
    const body = await this.request<{ entries: DomainEntry[] }>('GET', `/sessions/${encodeURIComponent(id)}/domains`)
    return body.entries
  }

  setDomain(id: string, key: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/domain`, { key })
  }

  /** 会话工作树变更（相对任务基线 baselineHead，中途 commit 仍可见）。 */
  async sessionWorkingTree(id: string): Promise<{ files: WorkingTreeFile[]; isRepo: boolean }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/git/working-tree`)
  }

  /** 文件在任务基线处的全量内容（原生双栏 diff 左侧）。 */
  async fileAtBase(id: string, path: string): Promise<{ exists: boolean; content: string }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/git/file-base?path=${encodeURIComponent(path)}`)
  }

  /** 回滚预览：available=false 表示无 checkpoint 或无可回滚内容。 */
  async rollbackPreview(id: string): Promise<{ available: boolean; text?: string; confirmationToken?: string }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/rollback/preview`)
  }

  rollback(id: string, confirmationToken: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/rollback`, { confirmationToken })
  }

  /** @file 提及候选（server 侧 gitignore 过滤 + 相关度排序）。 */
  async listFiles(id: string, q: string, limit = 30): Promise<string[]> {
    const body = await this.request<{ files: string[] }>(
      'GET',
      `/sessions/${encodeURIComponent(id)}/files?q=${encodeURIComponent(q)}&limit=${limit}`,
    )
    return body.files
  }

  /** 首启引导 — provider 配置面（与桌面 Settings 同一 REST）。 */
  listProviders(): Promise<ProviderConfigList> {
    return this.request('GET', '/config/providers')
  }

  /** 预设 provider 一步配置（key + makeDefault 同请求）。 */
  setupProvider(req: SetupProviderRequest): Promise<{ ok: boolean; providerName: string }> {
    return this.request('POST', '/config/providers', req)
  }

  /** OpenAI 兼容自定义端点配置。 */
  setupCustomProvider(req: SetupCustomProviderRequest): Promise<{ ok: boolean; providerName: string }> {
    return this.request('POST', '/config/providers/custom', req)
  }

  /** Plan mode — 计划正文（原生审批卡数据源）。 */
  async readPlan(id: string, slug: string): Promise<PlanDocument> {
    const body = await this.request<{ plan: PlanDocument }>(
      'GET',
      `/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(slug)}`,
    )
    return body.plan
  }

  approvePlan(id: string, slug: string, selectedApproach?: string): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(slug)}/approve`,
      selectedApproach ? { selectedApproach } : {},
    )
  }

  rejectPlan(id: string, slug: string, comment?: string): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(slug)}/reject`,
      comment ? { comment } : {},
    )
  }

  /** Plan 编辑 — 仅 submitted 状态可改（server 侧 409 闸门），保存后调用方重拉 readPlan。 */
  editPlan(id: string, slug: string, content: string): Promise<{ ok: boolean }> {
    return this.request('PUT', `/sessions/${encodeURIComponent(id)}/plans/${encodeURIComponent(slug)}`, { content })
  }

  /** 手动进出 plan mode（state 驱动走 plan_mode SSE 事件回流，客户端不做本地臆测）。 */
  setPlanMode(id: string, state: 'planning' | 'off'): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/plan-mode`, { state })
  }

  /** E4 — register / heartbeat client landing capabilities. */
  registerDelegateCapabilities(id: string, clientId: string, kinds: Array<'apply_edit' | 'terminal_exec'>): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/delegate-capabilities`, { clientId, kinds })
  }

  /** E4 — post landing result (accept / reject / terminal output). */
  answerDelegation(
    id: string,
    requestId: string,
    result: { content: string; isError?: boolean; uiContent?: string; status?: 'ok' | 'rejected' },
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/delegate/${encodeURIComponent(requestId)}/result`,
      result,
    )
  }

  /**
   * Probe protocol version via any REST call headers. Returns 0 when header absent.
   */
  async probeProtocolVersion(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      headers: { authorization: `Bearer ${this.token}` },
    })
    const raw = res.headers.get('x-tianshu-protocol')
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  }

  /**
   * 订阅会话 SSE。返回取消函数。断线后按最后收到的 seq 自动重连（指数退避，
   * 上限 10s）；重复事件由 seq 去重。
   * `clientId` 绑到 server 能力槽：SSE teardown 时自动清除委托能力。
   */
  subscribe(
    id: string,
    since: number,
    onEvent: (ev: SessionEvent) => void,
    onStateChange?: (live: boolean) => void,
    opts?: { clientId?: string },
  ): () => void {
    let cancelled = false
    let lastSeq = since
    let retryMs = 500
    const clientQ = opts?.clientId ? `&clientId=${encodeURIComponent(opts.clientId)}` : ''

    const connect = async (): Promise<void> => {
      while (!cancelled) {
        try {
          const res = await fetch(
            `${this.baseUrl}/sessions/${encodeURIComponent(id)}/stream?since=${lastSeq}${clientQ}`,
            { headers: { authorization: `Bearer ${this.token}` } },
          )
          if (!res.ok || !res.body) throw new Error(`stream → ${res.status}`)
          onStateChange?.(true)
          retryMs = 500
          await this.consumeSse(res.body, (ev) => {
            if (ev.seq > lastSeq) {
              lastSeq = ev.seq
              onEvent(ev)
            }
          })
        } catch {
          // fall through to retry
        }
        if (cancelled) return
        onStateChange?.(false)
        await new Promise((r) => setTimeout(r, retryMs))
        retryMs = Math.min(retryMs * 2, 10_000)
      }
    }
    void connect()
    return () => { cancelled = true }
  }

  /** 解析 SSE 帧：`event: <type>` + `data: <json SessionEvent>`；`:` 开头为心跳注释。 */
  private async consumeSse(body: ReadableStream<Uint8Array>, onEvent: (ev: SessionEvent) => void): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        try {
          const ev = JSON.parse(dataLines.join('\n')) as SessionEvent
          if (typeof ev?.seq === 'number' && typeof ev?.type === 'string') onEvent(ev)
        } catch {
          // 忽略无法解析的帧（向后兼容：未知格式不致命）
        }
      }
    }
  }
}
