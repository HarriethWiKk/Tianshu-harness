/**
 * 装配断裂审计 — CI 级源码扫描测试。
 *
 * 防止「配置定义存在，但到真实消费点的链路断了」这类静默失效。
 * 每次 push 自动跑，新增断裂必须进 allowlist 并注明理由 + reviewDate。
 *
 * 检查项：
 * 1. StarDomain / ProfileDefinition 字段消费覆盖
 * 2. RuntimeHookDeps ↔ loop-factory 实参键集合 diff
 * 3. env 开关注册表双向 completeness
 *
 * 模式选择：
 * - 字段消费 → architecture-guards 正则扫描 + allowlist
 * - hook deps → plan-mode completeness 模式
 * - env 注册表 → plan-mode completeness 模式
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_ROOT = join(process.cwd(), 'src')

function collectTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      if (entry === '__tests__') continue
      collectTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

/** 收集所有 .ts 文件（含测试），用于 env 注册表全量扫描 */
function collectAllTsFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      collectAllTsFiles(full, results)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

const allSrcFiles = collectTsFiles(SRC_ROOT)
const productionFiles = allSrcFiles.filter(f => !f.includes('/__tests__/'))
const allFilesIncludingTests = collectAllTsFiles(SRC_ROOT)

// ── allowlist 条目 ──

interface AllowlistEntry {
  field: string
  source: string
  category: 'display-only' | 'INERT' | 'pending' | 'reserved'
  note: string
  reviewDate: string
}

const FIELD_ALLOWLIST: AllowlistEntry[] = [
  {
    field: 'decisionStyle',
    source: 'StarDomain',
    category: 'display-only',
    note: '仅 TUI 展示（main.ts commitStatic + slash-commands display），G3 已有设计讨论，待数据支撑后接线',
    reviewDate: '2027-01-22',
  },
  {
    field: 'uiPersona',
    source: 'StarDomain',
    category: 'display-only',
    note: '仅 TUI 渲染层消费（overlay/glance-bar/team-panel），非行为面字段',
    reviewDate: '2027-01-22',
  },
  {
    field: 'systemPromptSuffix',
    source: 'StarDomain',
    category: 'display-only',
    note: '行为注入由 volatileBlock 承载（冻结 <star-domain> 前缀，主循环与 worker 同源，volatile.ts:1027）；本字段仅桌面图鉴法则面板展示（desktop CouncilSurface）。若恢复注入属独立设计决策——辅的 volatileBlock 自述「suffix 定义你怎么做」与此现状有张力，发版后需决议（2026-07-27 审查记录）。',
    reviewDate: '2027-01-22',
  },
  {
    field: 'defaultKind',
    source: 'ProfileDefinition',
    category: 'pending',
    note: '仅 parser + 测试消费，零生产行为读取。待决策：接线或删除',
    reviewDate: '2027-01-22',
  },
  {
    field: 'llmSpeculation',
    source: 'AgentConfig',
    category: 'INERT',
    note: 'schema 接收但 loop-factory.ts:974-980 明确不构造引擎（SEALED），对齐 loop-factory 注释',
    reviewDate: '2027-01-22',
  },
]

// ── 检查项 1：字段消费覆盖扫描 ──

interface FieldAudit {
  field: string
  source: string
  excludeFiles: string[]
  consumers: string[]
}

function scanFieldConsumers(fieldName: string, excludeFiles: string[]): string[] {
  const consumers: string[] = []
  const dotPattern = new RegExp(`\\.${fieldName}\\b`)
  const bracketPattern = new RegExp(`\\[['\"\`]${fieldName}['\"\`]\\]`)
  for (const file of productionFiles) {
    if (excludeFiles.some(e => file.endsWith(e))) continue
    const content = readFileSync(file, 'utf8')
    if (dotPattern.test(content) || bracketPattern.test(content)) {
      consumers.push(relative(SRC_ROOT, file))
    }
  }
  return consumers
}

describe('assembly audit — field consumption coverage', () => {
  const starDomainFields: FieldAudit[] = [
    { field: 'id', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'name', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'motto', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'volatileBlock', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'decisionStyle', source: 'StarDomain', excludeFiles: ['star-domain.ts', 'star-domain-registry.ts'], consumers: [] },
    { field: 'courageThreshold', source: 'StarDomain', excludeFiles: ['star-domain.ts', 'star-domain-registry.ts'], consumers: [] },
    { field: 'keywords', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'isCustom', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'toolWhitelist', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'mainToolTier', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'systemPromptSuffix', source: 'StarDomain', excludeFiles: ['star-domain.ts'], consumers: [] },
    { field: 'uiPersona', source: 'StarDomain', excludeFiles: ['star-domain.ts', 'star-domain-registry.ts'], consumers: [] },
  ]

  const profileFields: FieldAudit[] = [
    { field: 'name', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'role', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'allowedTools', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'expertisePrompt', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'defaultKind', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'defaultMaxTokens', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'defaultTimeoutMs', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'builtIn', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
    { field: 'tierLock', source: 'ProfileDefinition', excludeFiles: ['profile-registry.ts'], consumers: [] },
  ]

  for (const f of [...starDomainFields, ...profileFields]) {
    f.consumers = scanFieldConsumers(f.field, f.excludeFiles)
  }

  test('all StarDomain fields have production consumers or are allowlisted', () => {
    const violations: string[] = []
    for (const f of starDomainFields) {
      if (f.consumers.length === 0) {
        const entry = FIELD_ALLOWLIST.find(e => e.field === f.field && e.source === f.source)
        if (!entry) {
          violations.push(`  ${f.source}.${f.field}: zero production consumers, not in allowlist`)
        }
      }
    }
    assert.equal(violations.length, 0,
      `StarDomain fields with zero production consumers (not allowlisted):\n${violations.join('\n')}`)
  })

  test('all ProfileDefinition fields have production consumers or are allowlisted', () => {
    const violations: string[] = []
    for (const f of profileFields) {
      if (f.consumers.length === 0) {
        const entry = FIELD_ALLOWLIST.find(e => e.field === f.field && e.source === f.source)
        if (!entry) {
          violations.push(`  ${f.source}.${f.field}: zero production consumers, not in allowlist`)
        }
      }
    }
    assert.equal(violations.length, 0,
      `ProfileDefinition fields with zero production consumers (not allowlisted):\n${violations.join('\n')}`)
  })

  test('allowlist entries are still in source interfaces (no stale entries)', () => {
    const allFields = new Set([
      ...starDomainFields.map(f => `${f.source}.${f.field}`),
      ...profileFields.map(f => `${f.source}.${f.field}`),
    ])
    const stale: string[] = []
    for (const entry of FIELD_ALLOWLIST) {
      if (entry.source === 'AgentConfig') continue
      if (!allFields.has(`${entry.source}.${entry.field}`)) {
        stale.push(`  ${entry.source}.${entry.field}: in allowlist but not found in source`)
      }
    }
    assert.equal(stale.length, 0,
      `Stale allowlist entries (field no longer exists in source):\n${stale.join('\n')}`)
  })

  test('allowlist entries have reviewDate within 12 months', () => {
    const now = new Date()
    const oneYear = 365 * 24 * 60 * 60 * 1000
    const expired: string[] = []
    for (const entry of FIELD_ALLOWLIST) {
      const date = new Date(entry.reviewDate)
      if (isNaN(date.getTime()) || date.getTime() < now.getTime() - oneYear) {
        expired.push(`  ${entry.source}.${entry.field}: reviewDate ${entry.reviewDate}`)
      }
    }
    assert.equal(expired.length, 0,
      `Allowlist entries with expired/invalid reviewDate:\n${expired.join('\n')}`)
  })

  test('allowlist size report (size growth is an alert signal)', () => {
    const byCategory: Record<string, number> = {}
    for (const entry of FIELD_ALLOWLIST) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1
    }
    const report = Object.entries(byCategory)
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join('\n')
    console.log(`[assembly-audit] allowlist size: ${FIELD_ALLOWLIST.length}\n${report}`)
    assert.ok(FIELD_ALLOWLIST.length < 20,
      `allowlist has ${FIELD_ALLOWLIST.length} entries — review for audit effectiveness decay`)
  })

  test('decisionStyle: confirmed display-only (regression guard)', () => {
    const decisionStyleConsumers = starDomainFields
      .find(f => f.field === 'decisionStyle')!.consumers
      .filter(f => !f.includes('tui/') && !f.includes('main.ts'))
    const expectedTuiOnly = decisionStyleConsumers.every(
      f => f.includes('tui/') || f.includes('main.ts'),
    )
    assert.ok(expectedTuiOnly,
      `decisionStyle has non-TUI consumers — review whether behavioral wiring was intended:\n${decisionStyleConsumers.join('\n')}`)
  })
})

// ── 检查项 2：RuntimeHookDeps ↔ loop-factory 实参键 diff ──

describe('assembly audit — RuntimeHookDeps key diff', () => {
  const UNASSIGNED_OPTIONAL_ALLOWLIST = new Set([
    'chronicle',
    'getChronicleEntries',
    'onAntiAnchoringMCTSResult',
    'dedupGuardThreshold',
    'skillDistillDisabled',
  ])

  test('all RuntimeHookDeps optional keys are either assigned in loop-factory or allowlisted', () => {
    const depsSource = readFileSync(join(SRC_ROOT, 'agent', 'create-runtime-hooks.ts'), 'utf8')
    const optionalKeyPattern = /^\s{2}(\w+)\?(?::|:)/gm
    const optionalKeys: string[] = []
    let m
    while ((m = optionalKeyPattern.exec(depsSource)) !== null) {
      optionalKeys.push(m[1]!)
    }

    const factorySource = readFileSync(join(SRC_ROOT, 'agent', 'loop-factory.ts'), 'utf8')
    const pipelineCallIdx = factorySource.indexOf('createRuntimeHooksPipeline')
    if (pipelineCallIdx === -1) {
      assert.fail('Could not locate createRuntimeHooksPipeline call in loop-factory.ts')
    }
    const assignedKeyPattern = /^\s{4,8}(\w+):\s/gm
    const assignedKeys = new Set<string>()
    const EXCLUDED_KEYS = new Set([
      'lines', 'return', 'if', 'for', 'while', 'const', 'let', 'var',
      'try', 'catch', 'finally', 'switch', 'case', 'default', 'new',
      'else', 'break', 'continue', 'throw', 'assert', 'import', 'export',
      'error', 'parse', 'separator', 'accent', 'glyph', 'id', 'name',
    ])
    while ((m = assignedKeyPattern.exec(factorySource)) !== null) {
      const key = m[1]!
      if (key.length > 1 && !EXCLUDED_KEYS.has(key)) {
        assignedKeys.add(key)
      }
    }

    const unassigned = optionalKeys.filter(k => !assignedKeys.has(k) && !UNASSIGNED_OPTIONAL_ALLOWLIST.has(k))
    assert.equal(unassigned.length, 0,
      `RuntimeHookDeps optional keys not assigned in loop-factory (not allowlisted):\n${unassigned.map(k => `  ${k}`).join('\n')}\n\nAdd to UNASSIGNED_OPTIONAL_ALLOWLIST if intentional, or wire in loop-factory.`)
  })

  test('allowlisted unassigned deps still exist in RuntimeHookDeps interface', () => {
    const depsSource = readFileSync(join(SRC_ROOT, 'agent', 'create-runtime-hooks.ts'), 'utf8')
    const stale: string[] = []
    for (const key of UNASSIGNED_OPTIONAL_ALLOWLIST) {
      if (!depsSource.includes(key)) {
        stale.push(key)
      }
    }
    assert.equal(stale.length, 0,
      `Allowlisted deps no longer in RuntimeHookDeps (remove from allowlist):\n${stale.join('\n')}`)
  })

  test('getCourageThreshold getter references sessionDomain (not hardcoded dead value)', () => {
    // 回归哨兵：loop-factory.ts:554 的 getCourageThreshold getter 必须引用
    // self.sessionDomain?.courageThreshold。若有人改成 () => 0.5 之类的死 getter，
    // hook 级测试全绿但运行时域切换永远不生效——deps key diff 只保 key 存在不保语义。
    const factorySource = readFileSync(join(SRC_ROOT, 'agent', 'loop-factory.ts'), 'utf8')
    const pattern = /getCourageThreshold:\s*\(\s*\)\s*=>/
    const match = pattern.exec(factorySource)
    assert.ok(match, 'getCourageThreshold assignment not found in loop-factory.ts')
    const rest = factorySource.slice(match.index, match.index + 120)
    assert.ok(
      rest.includes('self.sessionDomain?.courageThreshold'),
      `getCourageThreshold getter must reference self.sessionDomain?.courageThreshold (not hardcoded dead value):\n  ${rest.slice(0, 100).trim()}`,
    )
  })
})

// ── 检查项 3：env 开关注册表双向 completeness ──

describe('assembly audit — env registry completeness', () => {
  /** 从文件集合中提取所有 RIVET_* 变量名（含间接引用模式） */
  function collectRivetVars(files: string[]): Set<string> {
    const vars = new Set<string>()
    const directPattern = /process\.env\.(RIVET_[A-Z_]+)/g
    const destructuredPattern = /\benv\.(RIVET_[A-Z_]+)\b/g
    const fnPattern = /\b(?:envInt|envStr|envBool)\s*\(\s*'(RIVET_[A-Z_]+)'\)/g

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const pattern of [directPattern, destructuredPattern, fnPattern]) {
        let m
        while ((m = pattern.exec(content)) !== null) {
          vars.add(m[1]!)
        }
      }
    }
    return vars
  }

  test('every RIVET_* in source code is in registry', () => {
    const codeVars = collectRivetVars(allFilesIncludingTests)

    let registryVars: Set<string>
    try {
      const regContent = readFileSync(join(SRC_ROOT, 'config', 'env-registry.ts'), 'utf8')
      registryVars = new Set<string>()
      const regPattern = /name:\s*'(RIVET_[A-Z_]+)'/g
      let rm
      while ((rm = regPattern.exec(regContent)) !== null) {
        registryVars.add(rm[1]!)
      }
    } catch {
      assert.fail('env-registry.ts not found — run: npx tsx scripts/gen-env-registry.ts')
      return
    }

    const missing = [...codeVars].filter(v => !registryVars.has(v)).sort()
    assert.equal(missing.length, 0,
      `RIVET_* variables in code but NOT in env-registry.ts:\n${missing.map(v => `  ${v}`).join('\n')}\n\nRun: npx tsx scripts/gen-env-registry.ts`)
  })

  test('every registry entry has a corresponding RIVET_* reference in source code', () => {
    const codeVars = collectRivetVars(allFilesIncludingTests)

    let registryVars: string[]
    try {
      const regContent = readFileSync(join(SRC_ROOT, 'config', 'env-registry.ts'), 'utf8')
      registryVars = []
      const regPattern = /name:\s*'(RIVET_[A-Z_]+)'/g
      let rm
      while ((rm = regPattern.exec(regContent)) !== null) {
        registryVars.push(rm[1]!)
      }
    } catch {
      assert.fail('env-registry.ts not found')
      return
    }

    const stale = registryVars.filter(v => !codeVars.has(v)).sort()
    assert.equal(stale.length, 0,
      `Registry entries with no RIVET_* reference in source code (stale entries):\n${stale.map(v => `  ${v}`).join('\n')}\n\nRun: npx tsx scripts/gen-env-registry.ts`)
  })
})
