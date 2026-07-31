/**
 * 安全模式告警（层1）开关。
 *
 * 控制 security-pattern hook 是否装配：写操作后用正则扫描已知危险模式
 * （命令注入 / 反序列化 RCE / XSS / eval / 弱加密 / TLS 校验关闭 / XXE /
 * SQL 注入 / 硬编码密钥），命中经 AdvisoryBus 注入告警。
 *
 * 默认开。层1 是纯正则、零 API 调用、命中才注入，与 probe-tracking、
 * git-clear-guard、dead-end-detector 等默认开的 advisory hook 同档。
 * （层2/层3 的 LLM 安全审查有真实成本，那两层默认关，走独立开关。）
 *
 * 关闭方式（任一生效）：
 *   - config.json：`agent.securityGuidance = false`
 *   - 环境变量：`RIVET_SECURITY_GUIDANCE=0`（同时接受 false/off/no）
 *
 * 两条通道都要：env 适合终端用户和 CI 临时覆盖；config 是桌面端唯一可行的
 * 通道——GUI 启动的 sidecar 继承不到 shell 环境变量。
 */

/**
 * 层1 是否启用。
 *
 * @param configValue config.json 的 `agent.securityGuidance`。undefined =
 *   调用方没有 config 上下文（如独立装配的测试），按默认开处理。
 */
export function isSecurityGuidanceEnabled(configValue?: boolean): boolean {
  if (configValue === false) return false
  const raw = process.env.RIVET_SECURITY_GUIDANCE
  if (raw === undefined) return true
  const lower = raw.trim().toLowerCase()
  return !(lower === '0' || lower === 'false' || lower === 'off' || lower === 'no')
}
