/**
 * Security-Pattern Hook — postTool 正则安全告警（层1,零成本零延迟）。
 *
 * 移植自官方 Claude Code security-guidance 插件的 PostToolUse 层。每次成功的写
 * 操作（edit_file / write_file / hash_edit / ast_edit / apply_patch）后,用
 * scanContent 扫描写入内容,命中已知危险模式（命令注入、反序列化 RCE、XSS、
 * eval、弱加密、TLS 校验关闭、XXE、SQL 注入、硬编码密钥等）即经 AdvisoryBus
 * 注入中文告警。apply_patch 的内容藏在 diff 里,单独解析（见 collectWrites）——
 * 否则换个写工具就能绕过全部规则。
 *
 * 与 probe-tracking-hook 同构的双通道设计:
 *   1. postTool hook 记录命中到 session-scoped 表（主信道:供层3 交付门复扫,
 *      并兼作跨轮去重依据——同一 (文件, 规则) 全会话只提醒一次）
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
import {
  extractWriteContents,
  extractPatchContents,
  type WriteFileContent,
} from '../../tools/write-tool-helpers.js'

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
/**
 * 本次写操作落盘的 (文件, 新增内容)。
 *
 * apply_patch 的 input 是 diff 文本，没有 file_path/content 字段，
 * extractWriteContents 对它恒为空——只接那一个入口的话，模型改用 apply_patch
 * 写入的代码就绕过全部 25 条规则。工具选择不该决定检测是否生效。
 */
function collectWrites(tool: RuntimeToolEvent): WriteFileContent[] {
  const input = tool.input as Record<string, unknown> | undefined
  if (tool.name === 'apply_patch') {
    // check_only 只校验不落盘，没有新内容可查。
    if (input?.check_only === true || input?.check_only === 'true') return []
    return typeof input?.diff === 'string' ? extractPatchContents(input.diff) : []
  }
  return extractWriteContents(tool.name, input)
}

export function createSecurityPatternHook(deps: SecurityPatternHookDeps): SecurityPatternHook {
  const tracker: SecurityTracker = { hitsByFile: new Map() }

  return {
    phase: 'postTool',
    name: 'security-pattern',
    getSecurityTracker() { return tracker },
    resetSecurityTracker() { tracker.hitsByFile.clear() },
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // 写失败（权限/edit 未匹配）或被 syntax-check 判 fatal 回滚时，内容并没有
      // 落盘——对不存在的代码发安全告警是纯噪音。
      if (!tool.success) return

      const writes = collectWrites(tool)
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

      // 记录到 session-scoped tracker，同时挑出本会话首次出现的 (file, rule)。
      // AdvisoryBus 的 key 去重只在同轮内生效，跨轮不抑制——不做这层过滤，反复
      // 编辑同一文件会每轮重发同一份几百字的 reminder 全文。
      const freshByFile = new Map<string, SecurityHit[]>()
      for (const [filePath, hits] of hitsByFile) {
        const ruleSet = tracker.hitsByFile.get(filePath) ?? new Set<string>()
        const fresh: SecurityHit[] = []
        for (const h of hits) {
          if (!ruleSet.has(h.ruleName)) fresh.push(h)
          ruleSet.add(h.ruleName)
        }
        tracker.hitsByFile.set(filePath, ruleSet)
        if (fresh.length > 0) freshByFile.set(filePath, fresh)
      }
      // 已提醒过的模式仍留在 tracker 里（供交付前复扫），但不再重复注入。
      if (freshByFile.size === 0) return

      // 组装单条 advisory 文案（辅信道）。多文件/多规则合并,去重 reminder。
      const lines: string[] = []
      for (const [filePath, hits] of freshByFile) {
        const uniqueReminders = [...new Map(hits.map(h => [h.ruleName, h.reminder])).values()]
        lines.push(`【安全】${filePath}:`)
        for (const reminder of uniqueReminders) lines.push(reminder)
      }

      deps.advisoryBus.submit({
        key: 'security-pattern',
        priority: 0.62,
        category: 'discipline',
        content: lines.join('\n'),
        ttl: 1,
        // 采纳 = 模型回去改这些文件（修掉被指出的模式）。缺省不填则该条只计
        // 送达、不参与采纳率统计，advisory 竞争排序拿不到它的真实增益。
        expect: { kind: 'file_touched', paths: [...freshByFile.keys()], withinTurns: 3 },
      })
    },
  }
}
