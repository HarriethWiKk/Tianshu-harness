/**
 * Commands the filesystem sandbox structurally cannot cover.
 *
 * Whitelisting their paths (/opt/homebrew, the docker socket, the login
 * keychain) would hollow out the boundary for every other command. Instead we
 * bypass the FS wrap for these and keep the "crossing the line needs a human"
 * semantics by forcing them through approval.
 *
 * Matching is prefix/word based on the command text. False negatives are safe
 * (the command just fails under the sandbox and the denial attribution explains
 * why); false positives cost an approval prompt.
 */
export interface IncompatibleMatch {
  /** Rule id, for logs and tests. */
  id: string
  /** Human-readable reason shown in the sandbox note. */
  reason: string
}

interface Rule {
  id: string
  pattern: RegExp
  reason: string
}

const RULES: readonly Rule[] = [
  { id: 'sudo', pattern: /(^|[;&|]\s*)sudo\s/, reason: 'sudo 提权本身即越界' },
  { id: 'brew', pattern: /(^|[;&|]\s*)brew\s+(install|uninstall|upgrade|link|unlink|tap|reinstall)\b/, reason: 'Homebrew 写 /opt/homebrew 或 /usr/local' },
  { id: 'docker', pattern: /(^|[;&|]\s*)(docker|podman)\s+(build|run|compose|push|pull|buildx)\b/, reason: '容器运行时需写 docker socket，Seatbelt 的 deny file-write* 会挡住 socket 写' },
  { id: 'npm-global', pattern: /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(i|install|add|global)\b[^;&|]*\s(-g|--global)\b/, reason: '全局安装写 node 全局 prefix' },
  { id: 'codesign', pattern: /(^|[;&|]\s*)(codesign|security|productsign)\s/, reason: '签名需访问 keychain 与系统信任库' },
  { id: 'notarize', pattern: /(^|[;&|]\s*)xcrun\s+(notarytool|altool)\b/, reason: '公证需写 Xcode 私有状态目录' },
  { id: 'system-update', pattern: /(^|[;&|]\s*)(softwareupdate|xcode-select|xcodebuild\s+-license)\b/, reason: '系统级配置变更' },
  { id: 'version-manager', pattern: /(^|[;&|]\s*)(nvm|asdf|rbenv|pyenv|sdk)\s+(install|use|global)\b/, reason: '版本管理器写自身 HOME 目录树' },
]

/** Returns the matching rule, or null when the sandbox can cover this command. */
export function sandboxIncompatibleCommand(command: string): IncompatibleMatch | null {
  for (const r of RULES) {
    if (r.pattern.test(command)) return { id: r.id, reason: r.reason }
  }
  return null
}
