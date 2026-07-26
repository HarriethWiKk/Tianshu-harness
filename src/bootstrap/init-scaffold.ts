/**
 * init-scaffold.ts — execution layer for the interactive `/init` wizard.
 *
 * Applies an InitCommit (produced by the headless state machine in
 * src/tui/init-flow.ts) to the project on disk. Every write follows the
 * "create when missing, fill gaps / skip when present" discipline — nothing
 * the user already wrote is ever overwritten:
 *   verify → ensureVerifyDeclaration + .rivet.md ## Stack upsert
 *            (existing keys win; see verify-declaration.ts)
 *   skills → .rivet/skills/<slug>.md (same-name file never clobbered,
 *            RECOMMENDED_MAX_SKILLS soft cap enforced, render→parse validated)
 *   hooks  → .rivet/hooks.json entries merged (array append, never clobber)
 *            + .rivet/hooks/<name>.sh script files (created executable)
 *
 * Zero LLM: all content is deterministic templates derived upstream from the
 * project fingerprint. Re-running the same commit is idempotent.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureVerifyDeclaration, renderRivetMdStack, upsertStackSection } from './verify-declaration.js'
import { countInstalledSkills, parseSkillMarkdown, RECOMMENDED_MAX_SKILLS } from '../skills/skill-loader.js'
import type { HookEntry, HookEvent } from '../hooks/user-hooks-runner.js'

// ── Commit contract (produced by tui/init-flow.ts) ─────────────

export interface InitSkillSpec {
  /** Filename-safe slug; also the frontmatter `name` → .rivet/skills/<slug>.md */
  slug: string
  description: string
  triggers: string[]
  /** Markdown body below the frontmatter. */
  body: string
}

export interface InitHookSpec {
  /** Script file name under .rivet/hooks/ (e.g. "posttool-typecheck.sh"). */
  name: string
  event: HookEvent
  /** Script file content (written with exec permission). */
  script: string
  timeoutMs?: number
  /** One-line purpose shown in the wizard and in the apply report. */
  purpose: string
}

export interface InitCommit {
  verify: boolean
  skills: InitSkillSpec[]
  hooks: InitHookSpec[]
}

// ── Apply report ───────────────────────────────────────────────

export interface InitApplyItem {
  /** Path relative to the project root. */
  path: string
  action: 'created' | 'updated' | 'skipped' | 'error'
  detail: string
}

export interface InitApplyReport {
  items: InitApplyItem[]
}

const ACTION_GLYPH: Record<InitApplyItem['action'], string> = {
  created: '✓',
  updated: '✓',
  skipped: '–',
  error: '✗',
}

const ACTION_VERB: Record<InitApplyItem['action'], string> = {
  created: '已创建',
  updated: '已更新',
  skipped: '跳过',
  error: '失败',
}

/** One static-message-ready rendering of an apply run (TUI + tests share it). */
export function formatInitApplyReport(report: InitApplyReport): string {
  const lines = report.items.map(i => `${ACTION_GLYPH[i.action]} ${i.path} — ${ACTION_VERB[i.action]}：${i.detail}`)
  const errors = report.items.filter(i => i.action === 'error').length
  const changed = report.items.filter(i => i.action === 'created' || i.action === 'updated').length
  lines.push(`完成：${changed} 项写入，${report.items.length - changed - errors} 项跳过${errors > 0 ? `，${errors} 项失败` : ''}。`)
  return lines.join('\n')
}

// ── verify branch ──────────────────────────────────────────────

function applyVerifyBranch(cwd: string, items: InitApplyItem[]): void {
  const decl = ensureVerifyDeclaration(cwd)
  if (decl.fingerprint.language === 'unknown') {
    items.push({ path: '.rivet-config.json', action: 'skipped', detail: '未识别的项目类型，verify 声明需手工填写' })
    return
  }
  items.push({
    path: '.rivet-config.json',
    action: decl.wrote ? 'updated' : 'skipped',
    detail: decl.wrote ? `verify 声明补缺：${decl.filledKeys.join('、')}（已有 key 保留）` : 'verify 声明已是最新，未改动',
  })
  // .rivet.md Stack section — rendered from the declaration (one direction).
  try {
    const rivetMdPath = join(cwd, '.rivet.md')
    const stack = renderRivetMdStack(decl.fingerprint, decl.verify)
    const body = existsSync(rivetMdPath) ? readFileSync(rivetMdPath, 'utf-8') : '# Project\n'
    const next = upsertStackSection(body, stack)
    if (next !== body) {
      writeFileSync(rivetMdPath, next, 'utf-8')
      items.push({ path: '.rivet.md', action: 'updated', detail: '## Stack 段已同步（由声明单向生成）' })
    } else {
      items.push({ path: '.rivet.md', action: 'skipped', detail: '## Stack 段已是最新' })
    }
  } catch (e) {
    items.push({ path: '.rivet.md', action: 'error', detail: `同步失败：${e instanceof Error ? e.message : String(e)}` })
  }
}

// ── skills branch ──────────────────────────────────────────────

/**
 * Render a scaffolded skill as parseable SKILL.md markdown. Mirrors
 * renderSkillDraftMarkdown's frontmatter shape (skill-distill.ts) so the
 * result round-trips through parseSkillMarkdown — which we run as a
 * validation gate before anything touches disk.
 */
export function renderInitSkillMarkdown(spec: InitSkillSpec): string {
  const triggersYaml = '[' + spec.triggers.map(t => `'${t.replace(/'/g, '')}'`).join(', ') + ']'
  return [
    '---',
    `name: ${spec.slug}`,
    `description: ${spec.description}`,
    `triggers: ${triggersYaml}`,
    '---',
    '',
    spec.body.trim(),
    '',
  ].join('\n')
}

function applySkillsBranch(cwd: string, specs: InitSkillSpec[], items: InitApplyItem[]): void {
  const dir = join(cwd, '.rivet', 'skills')
  let installed = countInstalledSkills(cwd)
  for (const spec of specs) {
    const rel = `.rivet/skills/${spec.slug}.md`
    if (installed >= RECOMMENDED_MAX_SKILLS) {
      items.push({ path: rel, action: 'skipped', detail: `已达技能建议上限 ${RECOMMENDED_MAX_SKILLS} 个` })
      continue
    }
    // 同名不覆盖：flat <slug>.md 或目录形式 <slug>/SKILL.md 都算已存在。
    if (existsSync(join(cwd, rel)) || existsSync(join(dir, spec.slug, 'SKILL.md'))) {
      items.push({ path: rel, action: 'skipped', detail: '同名 skill 已存在，未覆盖' })
      continue
    }
    const content = renderInitSkillMarkdown(spec)
    try {
      parseSkillMarkdown(content, `${spec.slug}.md`)
    } catch (e) {
      items.push({ path: rel, action: 'error', detail: `渲染结果未通过 skill 校验：${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(cwd, rel), content, 'utf-8')
      installed++
      items.push({ path: rel, action: 'created', detail: spec.description })
    } catch (e) {
      items.push({ path: rel, action: 'error', detail: `写入失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }
}

// ── hooks branch ───────────────────────────────────────────────

function applyHooksBranch(cwd: string, specs: InitHookSpec[], items: InitApplyItem[]): void {
  const rivetDir = join(cwd, '.rivet')
  const hooksJsonPath = join(rivetDir, 'hooks.json')
  let raw: { hooks?: HookEntry[] } = {}
  if (existsSync(hooksJsonPath)) {
    try {
      raw = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as { hooks?: HookEntry[] }
    } catch {
      // 与 ensureVerifyDeclaration 同一纪律：畸形文件不 clobber，报告后由用户手修。
      items.push({ path: '.rivet/hooks.json', action: 'error', detail: '已有 hooks.json 不是合法 JSON，未改动（请手工修复后重试）' })
      return
    }
  }
  const entries = Array.isArray(raw.hooks) ? raw.hooks : []
  let jsonChanged = false

  for (const spec of specs) {
    const scriptRel = `.rivet/hooks/${spec.name}`
    // 脚本文件先行：不存在才创建（+x），存在不动用户内容；脚本没就绪就不登记条目。
    const scriptAbs = join(cwd, scriptRel)
    let scriptReady = existsSync(scriptAbs)
    if (scriptReady) {
      items.push({ path: scriptRel, action: 'skipped', detail: '脚本已存在，未覆盖' })
    } else {
      try {
        mkdirSync(join(rivetDir, 'hooks'), { recursive: true })
        writeFileSync(scriptAbs, spec.script, 'utf-8')
        try { chmodSync(scriptAbs, 0o755) } catch { /* Windows 无 exec 位，尽力即可 */ }
        items.push({ path: scriptRel, action: 'created', detail: spec.purpose })
        scriptReady = true
      } catch (e) {
        items.push({ path: scriptRel, action: 'error', detail: `写入失败：${e instanceof Error ? e.message : String(e)}` })
      }
    }
    if (!scriptReady) continue
    // hooks.json 数组合并：同 event+script 的条目不重复添加。
    if (!entries.some(h => h.event === spec.event && h.script === scriptRel)) {
      entries.push({ event: spec.event, script: scriptRel, ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) })
      jsonChanged = true
      items.push({ path: '.rivet/hooks.json', action: 'updated', detail: `合并 ${spec.event} → ${scriptRel}` })
    } else {
      items.push({ path: '.rivet/hooks.json', action: 'skipped', detail: `${spec.event} → ${scriptRel} 条目已存在` })
    }
  }

  if (jsonChanged) {
    try {
      mkdirSync(rivetDir, { recursive: true })
      writeFileSync(hooksJsonPath, JSON.stringify({ ...raw, hooks: entries }, null, 2) + '\n', 'utf-8')
    } catch (e) {
      items.push({ path: '.rivet/hooks.json', action: 'error', detail: `写入失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }
}

// ── entry ──────────────────────────────────────────────────────

/**
 * Apply an InitCommit to the project. Idempotent: re-running the same commit
 * creates nothing twice (hooks entries dedup, skill files skipped, verify
 * keys preserved). Returns a per-item report for the TUI summary.
 */
export function applyInitCommit(cwd: string, commit: InitCommit): InitApplyReport {
  const items: InitApplyItem[] = []
  if (commit.verify) applyVerifyBranch(cwd, items)
  if (commit.skills.length > 0) applySkillsBranch(cwd, commit.skills, items)
  if (commit.hooks.length > 0) applyHooksBranch(cwd, commit.hooks, items)
  return { items }
}
