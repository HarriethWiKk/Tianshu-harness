/**
 * DeepSeek 平台 API 客户端 — 成本明细与用量趋势。
 *
 * 参考 DeepSeekDesktopAssistant 逆向的三条 platform.deepseek.com API：
 *   1. GET /api/v0/users/get_user_summary  — 当天/当月花费汇总
 *   2. GET /api/v0/usage/cost?month=&year= — 按模型按天的成本明细
 *   3. GET /api/v0/usage/amount?month=     — 余额明细（赠送/充值分项）
 *
 * 鉴权优先平台网页登录（~/.rivet/deepseek-platform-auth.json，桌面端 webview
 * 持久化），回退 API Key（Authorization: Bearer）。三个查询都返回
 * `PlatformResult`——`failure` 让 UI 区分「未登录」与「网络错」。
 *
 * 注意：cost_in_cents 单位是**分**（不是元），展示时需 /100。
 */
import { fetchWithTimeout } from './fetch-timeout.js'

// ── 响应类型（从 exe 逆向的 serde 结构） ──────────────────────────

/** DeepSeek 平台通用响应包装：{ biz_code, biz_data } 嵌套两层。 */
interface PlatformEnvelope<T> {
  biz_code?: number
  biz_data?: T
}

export interface DeepSeekUserSummary {
  is_account_available: boolean
  current_day_cost: number
  current_month_cost: number
  current_day_requests: number
  flash_usage: number
  pro_usage: number
  balance_info: {
    currency: string
    total_balance: number
    granted_balance?: number
    topped_up_balance?: number
  }
}

export interface DeepSeekCostEntry {
  total_tokens: number
  cost_in_cents: number
  input_cache_hit_tokens: number
  input_cache_miss_tokens: number
  output_tokens: number
  request_count: number
  /** ISO date string or day-of-month, populated by the caller from context. */
  date?: string
}

export interface DeepSeekModelCost {
  model: string
  usage: DeepSeekCostEntry[]
}

export interface DeepSeekCostReport {
  total: { cost_in_cents: number; total_tokens: number }
  /** 按 model 分组，每组内按天列出 usage。 */
  models: DeepSeekModelCost[]
}

export interface DeepSeekAmountDetail {
  total_balance: number
  granted_balance: number
  topped_up_balance: number
  currency: string
}

// ── 鉴权判断 ──────────────────────────────────────────────────────

function isDeepSeekProvider(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  return /api\.deepseek\.com/i.test(baseUrl)
}

/** 从 provider baseUrl 推导 platform.deepseek.com 基础 URL。 */
function platformBaseUrl(baseUrl: string | undefined): string {
  // api.deepseek.com → platform.deepseek.com（同域不同子域）
  return 'https://platform.deepseek.com'
}

/** Load persisted platform auth (from webview login). Returns null if not logged in. */
export function loadPlatformAuth(): { token: string; cookies: string } | null {
  try {
    // Must match the path resolution used by config-routes.ts (which writes
    // the file via rivetHome()). The previous implementation used
    // `process.env.RIVET_HOME || ''`, which fell back to an empty string
    // when RIVET_HOME was unset — causing filePath to resolve to the
    // filesystem root (/deepseek-platform-auth.json) and silently miss the
    // real file. Using rivetHome() guarantees read/write see the same path.
    const { rivetHome } = require('../config/paths')
    const { join } = require('node:path')
    const filePath = join(rivetHome(), 'deepseek-platform-auth.json')
    // Use dynamic require to avoid pulling fs into the browser bundle
    const { existsSync, readFileSync } = require('node:fs')
    if (!existsSync(filePath)) return null
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as { token?: string; cookies?: string }
    if (!data.token) return null
    return { token: data.token, cookies: data.cookies ?? '' }
  } catch {
    return null
  }
}

// ── 结果类型 ──────────────────────────────────────────────────────

/**
 * 失败原因。UI 需要区分「没登录」（引导用户去桌面端登录）与「网络/服务端错」
 * （重试即可）——旧实现一律 `null`，两种情况在界面上无从分辨。
 * - `no-credentials`：既无平台网页登录凭证，也无 DeepSeek API key
 * - `unauthorized`：凭证过期/无效（HTTP 401/403，或平台 biz_code 40003）
 * - `network`：连接失败或超时
 * - `malformed`：HTTP 200 但响应不是预期结构
 */
export type PlatformFailure = 'no-credentials' | 'unauthorized' | 'network' | 'malformed'

export interface PlatformResult<T> {
  data: T | null
  failure?: PlatformFailure
  message?: string
}

function fail<T>(failure: PlatformFailure, message?: string): PlatformResult<T> {
  return { data: null, failure, message }
}

// ── API 调用 ──────────────────────────────────────────────────────

/** 平台侧「未认证」应用层错误码：HTTP 200 但 biz_code 40003。 */
const BIZ_CODE_UNAUTHORIZED = 40003

async function platformFetch(
  path: string,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<PlatformResult<unknown>> {
  // Auth priority: platform webview login (cookie+token) > API Key
  const platformAuth = loadPlatformAuth()
  if (!platformAuth && (!apiKey || !isDeepSeekProvider(baseUrl))) {
    return fail('no-credentials', 'DeepSeek 平台未登录，且无可用 API key')
  }

  const url = `${platformBaseUrl(baseUrl)}${path}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (platformAuth) {
    headers['Authorization'] = `Bearer ${platformAuth.token}`
    if (platformAuth.cookies) headers['Cookie'] = platformAuth.cookies
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  headers['Origin'] = 'https://platform.deepseek.com'
  headers['Referer'] = 'https://platform.deepseek.com/usage'

  let res: Response
  try {
    res = await fetchWithTimeout(url, { headers, signal }, 10_000)
  } catch (err) {
    return fail('network', (err as Error).message)
  }
  if (res.status === 401 || res.status === 403) {
    return fail('unauthorized', `平台返回 ${res.status}，凭证已失效`)
  }
  if (!res.ok) return fail('network', `平台返回 HTTP ${res.status}`)
  try {
    return { data: await res.json() }
  } catch (err) {
    return fail('malformed', (err as Error).message)
  }
}

/**
 * 解嵌 { biz_code, biz_data: { biz_code, biz_data: <payload> } } 两层包装。
 * biz_code 非 0 时不再当成「无数据」静默丢弃——40003 映射为凭证失效。
 */
function unwrap<T>(result: PlatformResult<unknown>): PlatformResult<T> {
  if (result.data === null) return result as PlatformResult<T>
  const raw = result.data
  if (!raw || typeof raw !== 'object') return fail('malformed', '响应不是对象')
  const outer = raw as PlatformEnvelope<PlatformEnvelope<unknown>>
  if (typeof outer.biz_code === 'number' && outer.biz_code !== 0) {
    return outer.biz_code === BIZ_CODE_UNAUTHORIZED
      ? fail('unauthorized', 'biz_code 40003：平台未认证（需网页登录）')
      : fail('malformed', `平台 biz_code ${outer.biz_code}`)
  }
  const inner = outer.biz_data
  if (!inner || typeof inner !== 'object') return fail('malformed', '响应缺少 biz_data')
  // 有些端点只有一层 biz_data（直接是 payload），有些有两层
  const payload = (inner as PlatformEnvelope<unknown>).biz_data ?? inner
  return { data: payload as T }
}

/**
 * 1. 用户摘要：当天/当月花费、余额、Flash/Pro 用量。
 * GET /api/v0/users/get_user_summary
 */
export async function getDeepSeekUserSummary(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<PlatformResult<DeepSeekUserSummary>> {
  return unwrap<DeepSeekUserSummary>(
    await platformFetch('/api/v0/users/get_user_summary', apiKey, baseUrl, signal),
  )
}

/**
 * 2. 成本明细：按模型按天的 token/cost 明细。
 * GET /api/v0/usage/cost?month=<M>&year=<Y>
 *
 * month 是 1-12（不是 YYYY-MM），year 是四位年。
 */
export async function getDeepSeekCostReport(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  month: number,
  year: number,
  signal?: AbortSignal,
): Promise<PlatformResult<DeepSeekCostReport>> {
  const result = unwrap<{ total: DeepSeekCostReport['total']; days?: DeepSeekModelCost[] }>(
    await platformFetch(`/api/v0/usage/cost?month=${month}&year=${year}`, apiKey, baseUrl, signal),
  )
  if (!result.data) return result as PlatformResult<DeepSeekCostReport>
  return {
    data: {
      total: result.data.total ?? { cost_in_cents: 0, total_tokens: 0 },
      models: result.data.days ?? [],
    },
  }
}

/**
 * 3. 余额明细：总额/赠送/充值分项。
 * GET /api/v0/usage/amount?month=<YYYY-MM>
 */
export async function getDeepSeekAmount(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  month: string, // YYYY-MM format
  signal?: AbortSignal,
): Promise<PlatformResult<DeepSeekAmountDetail>> {
  return unwrap<DeepSeekAmountDetail>(
    await platformFetch(`/api/v0/usage/amount?month=${month}`, apiKey, baseUrl, signal),
  )
}
