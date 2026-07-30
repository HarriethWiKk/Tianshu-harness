/**
 * Security-Pattern Hook — postTool 正则安全告警（层1,零成本零延迟）。
 *
 * 移植自官方 Claude Code security-guidance 插件的 PostToolUse 层。每次写操作
 * （edit_file / write_file / hash_edit / ast_edit）后,用 scanContent 扫描写入
 * 内容,命中已知危险模式（命令注入、反序列化 RCE、XSS、eval、弱加密、TLS
 * 校验关闭、XXE 等 25 条规则）即经 AdvisoryBus 注入中文告警。
 *
 * 与 probe-tracking-hook 同构的双通道设计:
 *   1. postTool hook 记录命中到 session-scoped 表（主信道:供层3 交付门复扫）
 *   2. 同时 submit 一条 advisory（辅信道:命中即提醒改）
 *
 * 缓存安全:命中才注入（语义变化才字节变化）,无命中零注入。文案走 AdvisoryBus
 * → system-reminder 通道,只追加尾部,不重写 frozen 前缀。
 *
 * 来源标签:文案带【安全】前缀（仿官方 PROVENANCE_TAG）,让模型识别这是插件
 * 注入而非未知来源——不是权限声明,只是路标。
 *
 * @module hooks/security-pattern-hook
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { scanContent, type SecurityHit } from '../security-patterns.js'
import { extractWriteContents } from '../../tools/write-tool-helpers.js'

export interface SecurityPatternHookDeps {
  /** Only `submit` is used — narrowed for testability. */
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Session-scoped: file → 本会话在写操作中命中的规则名集合（跨轮累积）。 */
interface SecurityTracker {
  /** Map<filePath, Set<ruleName>> — 供层3 交付门 fs 复扫的输入。 */
  hitsByFile: Map<string, Set<string>>
}

export interface SecurityPatternHook
  extends PostToolRuntimeHook {
  getSecurityTracker(): SecurityTracker
  resetSecurityTracker(): void
}

/**
 * 创建安全模式 hook。
 *
 * tracker 是闭包作用域（非 turn-scoped）,跨轮存活到会话结束:第 3 轮写入的
 * 漏洞、第 10 轮 deliver_task 时仍需能被交付门复扫到（与 probe-tracking 一致）。
 */
export function createSecurityPatternHook(deps: SecurityPatternHookDeps): SecurityPatternHook {
  const tracker: SecurityTracker = { hitsByFile: new Map() }

  return {
    phase: 'postTool',
    name: 'security-pattern',
    getSecurityTracker() { return tracker },
    resetSecurityTracker() { tracker.hitsByFile.clear() },
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const writes = extractWriteContents(tool.name, tool.input as Record<string, unknown> | undefined)
      if (writes.length === 0) return

      // 按 (filePath) 聚合命中,同一文件多规则合并进一条 advisory。
      const hitsByFile = new Map<string, SecurityHit[]>()
      for (const w of writes) {
        const hits = scanContent(w.filePath, w.content)
        if (hits.length === 0) continue
        const existing = hitsByFile.get(w.filePath) ?? []
        existing.push(...hits)
        hitsByFile.set(w.filePath, existing)
      }
      if (hitsByFile.size === 0) return

      // 记录到 session-scoped tracker（主信道）。
      for (const [filePath, hits] of hitsByFile) {
        const ruleSet = tracker.hitsByFile.get(filePath) ?? new Set<string>()
        for (const h of hits) ruleSet.add(h.ruleName)
        tracker.hitsByFile.set(filePath, ruleSet)
      }

      // 组装单条 advisory 文案（辅信道）。多文件/多规则合并,去重 reminder。
      const lines: string[] = []
      for (const [filePath, hits] of hitsByFile) {
        const uniqueReminders = [...new Map(hits.map(h => [h.ruleName, h.reminder])).values()]
        lines.push(`【安全】${filePath}:`)
        for (const reminder of uniqueReminders) lines.push(reminder)
      }

      deps.advisoryBus.submit({
        key: 'security-pattern',
        priority: 0.55,
        category: 'discipline',
        content: lines.join('\n'),
        ttl: 1,
      })
    },
  }
}
