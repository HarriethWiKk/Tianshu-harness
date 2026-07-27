/**
 * GitHub CLI (gh) integration — wraps `gh` commands for PR operations.
 * All calls are best-effort: returns null when `gh` is not installed or not
 * authenticated, so the desktop can gracefully degrade.
 */
import { spawnHidden } from '../tools/spawn-hidden.js'

/** Normalized CI check tri-state (+ anomalous states), shared by rollup and `gh pr checks`. */
export type CiCheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED'

export interface CiCheck {
  name: string
  /** Normalized state — drives the badge tri-state (green/red/yellow). */
  state: CiCheckState
  /** Raw state/conclusion as reported by gh (preserved for display). */
  conclusion?: string
  detailsUrl?: string
}

export interface PrSummary {
  number: number
  title: string
  state: string
  url: string
  headRefName: string
  author: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  isDraft: boolean
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus?: 'CLEAN' | 'BLOCKED' | 'UNSTABLE' | 'HAS_HOOKS' | 'BEHIND' | 'DIRTY' | 'DRAFT' | 'UNKNOWN'
  statusCheckRollup?: CiCheck[]
  autoMergeRequest?: { mergeMethod: string } | null
}

export interface PrDetail extends PrSummary {
  body: string
  comments: PrComment[]
  files: PrFile[]
}

export interface PrComment {
  author: string
  body: string
  createdAt: string
  path?: string
  line?: number
}

export interface PrFile {
  path: string
  additions: number
  deletions: number
  status: string
}

/** A pending inline review comment anchored to a diff line. */
export interface PrReviewComment {
  path: string
  /** Diff line number to anchor on. RIGHT → new-side line; LEFT → old-side line. */
  oldLine?: number
  newLine?: number
  body: string
}

/** Input for submitting a PR review (verdict + summary + inline comments). */
export interface PrReviewInput {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  comments: PrReviewComment[]
}

/** GitHub reviews API payload shape (POST /pulls/:n/reviews). */
export interface GithubReviewPayload {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body?: string
  comments?: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[]
}

/** Result of a write-capable gh invocation (stderr surfaced for the UI). */
export interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

const TIMEOUT_MS = 15_000
/** CI-flavored calls (checks listing, log retrieval, merge) can be slow. */
const CI_TIMEOUT_MS = 60_000

async function runGh(args: string[], cwd: string): Promise<string | null> {
  const res = await runGhCapture(args, cwd)
  return res.ok ? res.stdout : null
}

/**
 * Run `gh` capturing stdout+stderr+exit code, with optional stdin input.
 * Unlike {@link runGh} (which drops stderr and collapses failures to null),
 * this surfaces gh's error message so write operations can report why they
 * failed. `input` is piped to stdin then closed (for `gh api --input -`).
 * `timeoutMs` defaults to the shared 15s; CI/log calls pass CI_TIMEOUT_MS.
 */
export async function runGhCapture(args: string[], cwd: string, input?: string, timeoutMs: number = TIMEOUT_MS): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawnHidden('gh', args, {
      cwd,
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: String(e), code: null }))
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        code,
      })
    })
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

/** JSON field string shared by `pr list` / `pr view` (same GraphQL PR field set). */
const PR_FIELDS = 'number,title,state,url,headRefName,author,createdAt,updatedAt,additions,deletions,reviewDecision,isDraft,mergeable,mergeStateStatus,statusCheckRollup,autoMergeRequest'

const MERGEABLE_VALUES = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
const MERGE_STATE_VALUES = ['CLEAN', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'] as const
const CI_CHECK_STATES = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'] as const

function asCiCheckState(raw: string): CiCheckState {
  return (CI_CHECK_STATES as readonly string[]).includes(raw) ? (raw as CiCheckState) : 'PENDING'
}

/**
 * Map a CheckRun-style conclusion to the tri-state. NEUTRAL/SKIPPED count as
 * passing (GitHub treats them as mergeable); CANCELLED surfaces as ERROR.
 */
function ciStateFromConclusion(conclusion: string): CiCheckState {
  switch (conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'SUCCESS'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'FAILURE'
    case 'CANCELLED':
      return 'ERROR'
    default:
      return 'PENDING'
  }
}

/**
 * Normalize one statusCheckRollup item (CheckRun | StatusContext union) to
 * CiCheck. CheckRun carries status+conclusion; StatusContext carries state
 * directly. Pure (no IO) so it can be unit-tested without spawning gh.
 */
export function normalizeRollupCheck(item: Record<string, unknown>): CiCheck {
  const isStatusContext = item.__typename === 'StatusContext' || (item.context != null && item.name == null)
  if (isStatusContext) {
    const raw = String(item.state ?? 'PENDING')
    return {
      name: String(item.context ?? ''),
      state: asCiCheckState(raw),
      detailsUrl: item.targetUrl ? String(item.targetUrl) : undefined,
    }
  }
  // CheckRun (also the defensive fallback for unknown shapes).
  const conclusion = item.conclusion ? String(item.conclusion) : undefined
  return {
    name: String(item.name ?? ''),
    state: conclusion ? ciStateFromConclusion(conclusion) : 'PENDING',
    conclusion,
    detailsUrl: item.detailsUrl ? String(item.detailsUrl) : undefined,
  }
}

/** Extract the CI fields from a `gh pr list/view --json` record. */
function mapCiFields(p: Record<string, unknown>): Pick<PrSummary, 'mergeable' | 'mergeStateStatus' | 'statusCheckRollup' | 'autoMergeRequest'> {
  const mergeable = (MERGEABLE_VALUES as readonly string[]).includes(String(p.mergeable))
    ? (p.mergeable as PrSummary['mergeable'])
    : undefined
  const mergeStateStatus = (MERGE_STATE_VALUES as readonly string[]).includes(String(p.mergeStateStatus))
    ? (p.mergeStateStatus as PrSummary['mergeStateStatus'])
    : undefined
  const statusCheckRollup = Array.isArray(p.statusCheckRollup)
    ? (p.statusCheckRollup as Record<string, unknown>[]).map(normalizeRollupCheck).filter(c => c.name)
    : undefined
  const autoMergeRequest = typeof p.autoMergeRequest === 'object' && p.autoMergeRequest !== null
    ? { mergeMethod: String((p.autoMergeRequest as Record<string, unknown>).mergeMethod ?? '') }
    : null
  return { mergeable, mergeStateStatus, statusCheckRollup, autoMergeRequest }
}

export async function listPrs(cwd: string, limit = 10): Promise<PrSummary[] | null> {
  const raw = await runGh(['pr', 'list', '--json', PR_FIELDS, '--limit', String(limit)], cwd)
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as Record<string, unknown>[]
    return arr.map(p => ({
      number: Number(p.number),
      title: String(p.title ?? ''),
      state: String(p.state ?? ''),
      url: String(p.url ?? ''),
      headRefName: String(p.headRefName ?? ''),
      author: typeof p.author === 'object' && p.author ? String((p.author as Record<string, unknown>).login ?? '') : '',
      createdAt: String(p.createdAt ?? ''),
      updatedAt: String(p.updatedAt ?? ''),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      reviewDecision: String(p.reviewDecision ?? ''),
      isDraft: Boolean(p.isDraft),
      ...mapCiFields(p),
    }))
  } catch {
    return null
  }
}

export async function getPrDetail(cwd: string, number: number): Promise<PrDetail | null> {
  const fields = `${PR_FIELDS},body`
  const raw = await runGh(['pr', 'view', String(number), '--json', fields], cwd)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    const summary: PrDetail = {
      number: Number(p.number),
      title: String(p.title ?? ''),
      state: String(p.state ?? ''),
      url: String(p.url ?? ''),
      headRefName: String(p.headRefName ?? ''),
      author: typeof p.author === 'object' && p.author ? String((p.author as Record<string, unknown>).login ?? '') : '',
      createdAt: String(p.createdAt ?? ''),
      updatedAt: String(p.updatedAt ?? ''),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      reviewDecision: String(p.reviewDecision ?? ''),
      isDraft: Boolean(p.isDraft),
      ...mapCiFields(p),
      body: String(p.body ?? ''),
      comments: [],
      files: [],
    }

    const commentsRaw = await runGh(['pr', 'view', String(number), '--json', 'comments,reviews'], cwd)
    if (commentsRaw) {
      try {
        const cd = JSON.parse(commentsRaw) as Record<string, unknown>
        const comments = Array.isArray(cd.comments) ? cd.comments : []
        const reviews = Array.isArray(cd.reviews) ? cd.reviews : []
        for (const c of [...comments, ...reviews] as Record<string, unknown>[]) {
          // Skip empty review shells (e.g. an APPROVE with no summary body).
          const body = String(c.body ?? '')
          if (!body) continue
          summary.comments.push({
            author: typeof c.author === 'object' && c.author ? String((c.author as Record<string, unknown>).login ?? '') : '',
            body,
            createdAt: String(c.createdAt ?? ''),
          })
        }
      } catch { /* ignore */ }
    }

    // Inline review comments (path/line) are not exposed by `gh pr view --json`,
    // so pull them from the review-comments API endpoint and merge in.
    const inline = await getPrReviewComments(cwd, number)
    if (inline) summary.comments.push(...inline)

    // Accurate per-file counts + status from the files API (name-only dropped them).
    const filesRaw = await runGh(['pr', 'view', String(number), '--json', 'files'], cwd)
    if (filesRaw) {
      try {
        const fd = JSON.parse(filesRaw) as Record<string, unknown>
        const files = Array.isArray(fd.files) ? (fd.files as Record<string, unknown>[]) : []
        for (const f of files) {
          const path = String(f.path ?? '')
          if (!path) continue
          summary.files.push({
            path,
            additions: Number(f.additions ?? 0),
            deletions: Number(f.deletions ?? 0),
            status: String(f.status ?? 'modified'),
          })
        }
      } catch { /* ignore */ }
    }

    return summary
  } catch {
    return null
  }
}

/** Full unified diff for a PR (`gh pr diff <n>`). Null when gh unavailable. */
export async function getPrDiff(cwd: string, number: number): Promise<string | null> {
  return runGh(['pr', 'diff', String(number)], cwd)
}

/**
 * Inline review comments (path + line) via the review-comments API endpoint.
 * `gh pr view --json` only exposes top-level comment/review bodies, so this
 * recovers the per-line threads that would otherwise be dropped.
 */
export async function getPrReviewComments(cwd: string, number: number): Promise<PrComment[] | null> {
  const raw = await runGh(['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'], cwd)
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as Record<string, unknown>[]
    if (!Array.isArray(arr)) return []
    return arr.map(c => ({
      author: typeof c.user === 'object' && c.user ? String((c.user as Record<string, unknown>).login ?? '') : '',
      body: String(c.body ?? ''),
      createdAt: String(c.created_at ?? ''),
      path: c.path ? String(c.path) : undefined,
      // `line` is the new-side line; fall back to original_line for outdated threads.
      line: c.line != null ? Number(c.line) : (c.original_line != null ? Number(c.original_line) : undefined),
    })).filter(c => c.body)
  } catch {
    return null
  }
}

/**
 * Map a review verdict + inline comments to the GitHub reviews API payload.
 * Pure (no IO) so it can be unit-tested. Comments without any usable line
 * anchor are dropped (the API rejects comments missing path+line). New-side
 * lines map to RIGHT, deletions (old-side only) map to LEFT.
 */
export function buildReviewPayload(input: PrReviewInput): GithubReviewPayload {
  const payload: GithubReviewPayload = { event: input.event }
  const body = input.body?.trim()
  if (body) payload.body = body
  const comments = (input.comments ?? [])
    .map((c) => {
      const side: 'LEFT' | 'RIGHT' = c.newLine != null ? 'RIGHT' : 'LEFT'
      const line = c.newLine != null ? c.newLine : c.oldLine
      if (!c.path || line == null || !c.body?.trim()) return null
      return { path: c.path, line, side, body: c.body.trim() }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
  if (comments.length > 0) payload.comments = comments
  return payload
}

/**
 * Submit a PR review (verdict + summary + inline comments) as one GitHub review
 * via `gh api --method POST .../reviews --input -` (JSON piped over stdin;
 * gh fills {owner}/{repo} from the cwd repo). Returns gh's result so the caller
 * can surface stderr on failure.
 */
export async function submitPrReview(cwd: string, number: number, input: PrReviewInput): Promise<GhResult> {
  const payload = buildReviewPayload(input)
  return runGhCapture(
    ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'],
    cwd,
    JSON.stringify(payload),
  )
}

export async function isGhAvailable(cwd: string): Promise<boolean> {
  const result = await runGh(['auth', 'status'], cwd)
  return result !== null
}

export interface CreatePrResult {
  ok: boolean
  /** PR URL on success. */
  url?: string
  error?: string
}

/**
 * Create a PR from the current branch of `cwd` via `gh pr create`. The branch
 * must already be pushed (the caller handles `git push -u`). Without a title,
 * `--fill` derives title/body from the commits.
 */
export async function createPr(
  cwd: string,
  opts: { title?: string; body?: string; draft?: boolean } = {},
): Promise<CreatePrResult> {
  const args = ['pr', 'create']
  if (opts.title?.trim()) {
    args.push('--title', opts.title.trim(), '--body', opts.body ?? '')
  } else {
    args.push('--fill')
  }
  if (opts.draft) args.push('--draft')
  const res = await runGhCapture(args, cwd)
  if (!res.ok) return { ok: false, error: (res.stderr || res.stdout).trim() || 'gh pr create failed' }
  // gh prints the PR URL as the last stdout line.
  const url = res.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('https://')).pop()
  return { ok: true, url }
}

// ── CI checks / merge (PR CI loop) ─────────────────────────────────────

/**
 * List a PR's check runs via `gh pr checks --json` (gh 2.20+; the `bucket`
 * field gives the tri-state directly). 60s timeout — checks listing hits the
 * rollup API which can lag. Null when gh fails.
 */
export async function listPrChecks(cwd: string, number: number): Promise<CiCheck[] | null> {
  const res = await runGhCapture(
    ['pr', 'checks', String(number), '--json', 'name,state,link,bucket,workflow,startedAt,completedAt'],
    cwd,
    undefined,
    CI_TIMEOUT_MS,
  )
  if (!res.ok) return null
  try {
    const arr = JSON.parse(res.stdout) as Record<string, unknown>[]
    if (!Array.isArray(arr)) return []
    return arr.map(c => ({
      name: String(c.name ?? ''),
      state: checkStateFromBucket(String(c.bucket ?? '')),
      conclusion: c.state ? String(c.state) : undefined,
      detailsUrl: c.link ? String(c.link) : undefined,
    })).filter(c => c.name)
  } catch {
    return null
  }
}

/** `gh pr checks` bucket → tri-state. `skipping` passes; `cancel` is anomalous. */
function checkStateFromBucket(bucket: string): CiCheckState {
  switch (bucket) {
    case 'pass':
    case 'skipping':
      return 'SUCCESS'
    case 'fail':
      return 'FAILURE'
    case 'cancel':
      return 'ERROR'
    default:
      return 'PENDING'
  }
}

/**
 * Extract a GitHub Actions run id from a check's detailsUrl
 * (`…/actions/runs/<id>`). Null for external CI (CircleCI/Buildkite/…) —
 * their logs are not reachable via gh. Pure, unit-tested.
 */
export function parseActionsRunId(detailsUrl: string | undefined): number | null {
  if (!detailsUrl) return null
  const m = /github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/.exec(detailsUrl)
  return m ? Number(m[1]) : null
}

export type CheckRunLogResult = { log: string } | { externalUrl: string }

/**
 * Fetch a failed check's log. Primary path: parse the Actions run id from
 * detailsUrl, then `gh run view <id> --log-failed` (plain text, works with the
 * gh CLI user token). External CI (non-Actions detailsUrl) degrades to
 * { externalUrl } — the caller offers the link instead of a log.
 * NOTE: the check-runs/<id>/logs API endpoint is GitHub-App-credentials only
 * and is deliberately not used. Null when gh fails or no URL is available.
 */
export async function getCheckRunLog(cwd: string, check: Pick<CiCheck, 'detailsUrl'>): Promise<CheckRunLogResult | null> {
  const runId = parseActionsRunId(check.detailsUrl)
  if (runId == null) return check.detailsUrl ? { externalUrl: check.detailsUrl } : null
  const res = await runGhCapture(['run', 'view', String(runId), '--log-failed'], cwd, undefined, CI_TIMEOUT_MS)
  if (!res.ok) return null
  return { log: res.stdout }
}

export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** Pure: assemble `gh pr merge` args (unit-tested). */
export function buildMergeArgs(number: number, method: MergeMethod, opts?: { auto?: boolean; deleteBranch?: boolean }): string[] {
  const args = ['pr', 'merge', String(number), `--${method}`]
  if (opts?.auto) args.push('--auto')
  if (opts?.deleteBranch) args.push('--delete-branch')
  return args
}

/**
 * Merge a PR via `gh pr merge`. `opts.auto` arms GitHub native auto-merge
 * (the repo must have it enabled — gh surfaces the error otherwise, and the
 * caller maps stderr to an actionable message). Returns GhResult so stderr
 * reaches the UI.
 */
export async function mergePr(
  cwd: string,
  number: number,
  method: MergeMethod,
  opts?: { auto?: boolean; deleteBranch?: boolean },
): Promise<GhResult> {
  return runGhCapture(buildMergeArgs(number, method, opts), cwd, undefined, CI_TIMEOUT_MS)
}
