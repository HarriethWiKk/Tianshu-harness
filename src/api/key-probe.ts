/**
 * Provider key probe — 用一个轻量 GET 请求验证 API key 有效 + 端点连通。
 *
 * 选 OpenAI 兼容的 `/models` 端点：所有 OpenAI 兼容 provider 都支持、零 token
 * 消耗（不触发 completion 计费）、仅验证鉴权与连通性。被桌面端 ConnectWizard
 * 在保存 key 前调用，避免无效 key 写入配置直到用户真正发消息时才 401。
 */
import { fetchWithTimeout } from './fetch-timeout.js'

export interface KeyProbeResult {
  /** true = key 有效且端点可达；false = 鉴权失败 / 网络错误 / 超时。 */
  ok: boolean
  /** ok=false 时的可读原因（已 i18n-ready，直接透给前端展示）。 */
  error?: string
  /** HTTP 状态码（网络错误时缺省）。 */
  status?: number
}

/**
 * 向 provider 的 `/models` 端点发 GET 验证 key。
 *
 * @param apiKey 待验证的 key（明文，仅在 sidecar 进程内使用，不落盘不外发）
 * @param baseUrl provider 的 OpenAI 兼容 baseUrl（如 `https://api.deepseek.com/v1`）
 */
export async function probeProviderKey(
  apiKey: string,
  baseUrl: string,
): Promise<KeyProbeResult> {
  const key = apiKey.trim()
  if (!key) return { ok: false, error: 'API key is empty' }
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    }, 12_000)
    if (res.ok) return { ok: true, status: res.status }
    // 401/403 = key 无效；其余（5xx/429）可能是服务端临时问题——区分告诉用户。
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: 'auth-failed' }
    }
    return { ok: false, status: res.status, error: `http-${res.status}` }
  } catch (e) {
    const msg = (e as Error)?.message ?? ''
    // fetch-timeout 抛 AbortError / "timed out" → 归类超时；其余归网络错误。
    if (/timeout|abort/i.test(msg)) return { ok: false, error: 'timeout' }
    return { ok: false, error: 'network-error' }
  }
}
