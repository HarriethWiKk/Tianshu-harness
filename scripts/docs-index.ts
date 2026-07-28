/**
 * docs-index — 文档索引生成器（规范见 docs/README.md）
 *
 * 扫描 docs 下全部 markdown，按「frontmatter 优先，blockquote 元信息头 / 文件名日期前缀 / H1 兜底」
 * 提取元数据，生成三件套：
 *   docs/INDEX.md    — 人读索引（按 type 分组表格）
 *   docs/docs.json   — 机读索引（PEP peps.json 极简翻版）
 *   docs/MINDMAP.md  — markmap 兼容大纲（思维导图）
 *
 * 用法：
 *   tsx scripts/docs-index.ts          # 生成三件套
 *   tsx scripts/docs-index.ts --check  # 只校验不生成；frontmatter 非法时非零退出
 *
 * 零依赖（仅 node:fs / node:path）；frontmatter 只解析 YAML 子集（key: value 与数组）。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

const REPO_ROOT = process.cwd()
const DOCS_DIR = join(REPO_ROOT, 'docs')

const TYPES = [
  'plan', 'spec', 'design', 'decision', 'analysis',
  'research', 'changelog', 'issue', 'release', 'guide', 'reference',
] as const
type DocType = (typeof TYPES)[number]
const STATUSES = ['draft', 'active', 'accepted', 'done', 'deprecated', 'superseded'] as const

const TYPE_LABEL: Record<DocType | 'unclassified', string> = {
  plan: '执行计划',
  spec: '事前规格',
  design: '技术设计',
  decision: '决策记录',
  analysis: '分析复盘',
  research: '外部调研',
  changelog: '变更记录',
  issue: '问题追踪',
  release: '版本发布',
  guide: '手册指南',
  reference: '参考资料',
  unclassified: '未分类',
}

/** 不参与索引的路径（目录索引页、模板、归档、生成物自身） */
function excluded(rel: string): boolean {
  const base = rel.split('/').pop() ?? ''
  if (base.toLowerCase() === 'readme.md') return true
  if (rel === 'INDEX.md' || rel === 'MINDMAP.md') return true
  if (rel.startsWith('_templates/') || rel.startsWith('archive/') || rel.startsWith('seed-capsule-archive/')) return true
  return false
}

/** 目录 → type 推断（frontmatter.type 优先，此为兜底） */
function inferType(rel: string): DocType | 'unclassified' {
  const segs = rel.split('/')
  const top = segs[0]
  const base = segs[segs.length - 1]
  if (segs.length > 1) {
    const dirMap: Record<string, DocType> = {
      plans: 'plan', specs: 'spec', design: 'design', decisions: 'decision',
      analysis: 'analysis', research: 'research', changelog: 'changelog',
      'known-issues': 'issue', releases: 'release', guides: 'guide', reference: 'reference',
      stars: 'reference', brand: 'reference', dev: 'guide', 'prompt-changelog': 'changelog',
      'prompt-versions': 'reference', sessions: 'analysis', tasks: 'plan', reviews: 'analysis',
      teamtask: 'analysis', 'cache-baseline': 'reference',
    }
    if (top === 'superpowers' && segs.length > 2) {
      const sub = segs[1]
      const subMap: Record<string, DocType> = {
        plans: 'plan', specs: 'spec', tasks: 'plan', impl: 'plan',
        analysis: 'analysis', retrospectives: 'analysis', handoff: 'analysis', status: 'analysis',
        reviews: 'analysis', validations: 'analysis', reports: 'analysis', baselines: 'analysis',
        'ab-harness': 'analysis', collaboration: 'analysis',
        briefs: 'reference', brainstorm: 'design', strategy: 'design',
      }
      if (subMap[sub]) return subMap[sub]
    }
    if (dirMap[top]) return dirMap[top]
  }
  // docs 顶层散落文件按文件名特征推断
  if (/^changelog-\d{4}/.test(base)) return 'changelog'
  if (/^(user-guide|desktop-guide|WINDOWS-|publishing|DESKTOP-RELEASE|skills-guide|Mac桌面端打包)/i.test(base)) return 'guide'
  if (/^seed-capsule/.test(base)) return 'reference'
  return 'unclassified'
}

interface DocMeta {
  path: string // 相对 docs/ 的 posix 路径
  title: string
  type: DocType | 'unclassified'
  typeSource: 'frontmatter' | 'inferred'
  status: string
  statusSource: 'frontmatter' | 'blockquote' | 'none'
  date: string
  related: string[]
  supersedes: string
  tags: string[]
  hasFrontmatter: boolean
}

/** 解析 YAML frontmatter 子集（与 src/utils/frontmatter.ts 相同的 BOM/CRLF 预处理） */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') // eslint-disable-line -- BOM 预处理同 src/utils/frontmatter.ts
  const m = normalized.match(/^---\n([\s\S]*?)\n---(\n|$)/)
  if (!m) return null
  const data: Record<string, unknown> = {}
  let currentKey: string | null = null
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) {
      currentKey = kv[1]
      const value = kv[2].trim()
      if (value.startsWith('[') && value.endsWith(']')) {
        data[currentKey] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      } else if (value !== '') {
        data[currentKey] = value.replace(/^["']|["']$/g, '')
      } else {
        data[currentKey] = undefined // 可能是后续的 - 列表
      }
      continue
    }
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = []
      ;(data[currentKey] as string[]).push(item[1].trim().replace(/^["']|["']$/g, ''))
    }
  }
  return data
}

function extractMeta(rel: string, content: string): DocMeta {
  const fm = parseFrontmatter(content)
  const head = content.split('\n').slice(0, 40).join('\n')
  const base = rel.split('/').pop() ?? rel

  // 标题：frontmatter > 首个 H1 > 文件名
  const h1 = head.match(/^#\s+(.+)$/m)?.[1].trim()
  const title = (typeof fm?.title === 'string' && fm.title) || h1 || base.replace(/\.md$/, '')

  // 日期：frontmatter > 文件名前缀 > blockquote
  const fileDate = base.match(/^(\d{4}-\d{2}-\d{2})-/)?.[1]
  const quoteDate = head.match(/^>\s*(?:日期|时间|date)[:：]\s*(\d{4}-\d{2}-\d{2})/im)?.[1]
  const date = (typeof fm?.date === 'string' && fm.date) || fileDate || quoteDate || ''

  // 状态：frontmatter > blockquote「> 状态：」> 独立「状态：**x**」行
  const quoteStatus =
    head.match(/^>\s*状态[:：]\s*(.+?)\s*$/m)?.[1]?.replace(/\*\*/g, '') ??
    head.match(/^状态[:：]\s*\*\*(.+?)\*\*\s*$/m)?.[1]
  const fmStatus = typeof fm?.status === 'string' ? fm.status : ''
  const status = fmStatus || quoteStatus || ''
  const statusSource: DocMeta['statusSource'] = fmStatus ? 'frontmatter' : quoteStatus ? 'blockquote' : 'none'

  const fmType = typeof fm?.type === 'string' ? fm.type.trim() : ''
  const type = (TYPES as readonly string[]).includes(fmType)
    ? (fmType as DocType)
    : inferType(rel)

  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])

  return {
    path: rel,
    title,
    type,
    typeSource: (TYPES as readonly string[]).includes(fmType) ? 'frontmatter' : 'inferred',
    status,
    statusSource,
    date,
    related: list(fm?.related),
    supersedes: typeof fm?.supersedes === 'string' ? fm.supersedes : '',
    tags: list(fm?.tags),
    hasFrontmatter: fm !== null,
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

function cmpDoc(a: DocMeta, b: DocMeta): number {
  if (a.date !== b.date) return a.date > b.date ? -1 : 1 // 日期倒序，无日期排后
  return a.path < b.path ? -1 : 1
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function collectHygieneWarnings(): string[] {
  const warnings: string[] = []
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      const rel = relative(DOCS_DIR, full).split('\\').join('/')
      if (entry.isDirectory()) {
        scan(full)
        continue
      }
      if (/^2025-\d{2}-\d{2}-/.test(entry.name)) warnings.push(`疑似错误年份日期前缀：docs/${rel}`)
      if (entry.name.endsWith('.rej')) warnings.push(`合并残留 .rej 文件：docs/${rel}`)
      if (/\.(rtf|docx?|xlsx?|pptx?)$/i.test(entry.name)) warnings.push(`二进制文档混入 markdown 库：docs/${rel}`)
    }
  }
  scan(DOCS_DIR)
  return warnings
}

function buildIndex(groups: Map<string, DocMeta[]>, total: number, fmCount: number): string {
  const lines: string[] = [
    '# 天枢文档索引',
    '',
    '> 本文件由 `scripts/docs-index.ts` 自动生成（`npm run docs:index`），请勿手工编辑。',
    '> 文档规范见 [README.md](README.md)；思维导图见 [MINDMAP.md](MINDMAP.md)（markmap 渲染）。',
    '',
    `共 ${total} 篇，其中 ${fmCount} 篇带 frontmatter。`,
    '',
    '## 概览',
    '',
    '| 类型 | 职责 | 数量 |',
    '|------|------|------|',
  ]
  for (const t of [...TYPES, 'unclassified' as const]) {
    const n = groups.get(t)?.length ?? 0
    if (n > 0) lines.push(`| \`${t}\` | ${TYPE_LABEL[t]} | ${n} |`)
  }
  for (const t of [...TYPES, 'unclassified' as const]) {
    const docs = groups.get(t)
    if (!docs?.length) continue
    lines.push('', `## ${t} — ${TYPE_LABEL[t]}（${docs.length}）`, '', '| 日期 | 文档 | 状态 |', '|------|------|------|')
    for (const d of docs) {
      lines.push(`| ${d.date || '—'} | [${escapeCell(d.title)}](${d.path}) | ${escapeCell(d.status) || '—'} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

const MINDMAP_GROUP_CAP = 20

function buildMindmap(groups: Map<string, DocMeta[]>): string {
  const lines: string[] = [
    '# 天枢文档思维导图',
    '',
    '> 本文件由 `scripts/docs-index.ts` 自动生成，用 VSCode markmap 插件打开，',
    '> 或 `npx markmap-cli docs/MINDMAP.md --no-open` 渲染为 HTML。每个分组仅展开最近 ' + MINDMAP_GROUP_CAP + ' 篇，全量见 [INDEX.md](INDEX.md)。',
    '',
    '- **天枢文档库**',
  ]
  for (const t of [...TYPES, 'unclassified' as const]) {
    const docs = groups.get(t)
    if (!docs?.length) continue
    lines.push(`  - **${t} · ${TYPE_LABEL[t]}** (${docs.length})`)
    const byStatus = new Map<string, DocMeta[]>()
    for (const d of docs) {
      const key = d.statusSource === 'frontmatter' ? d.status : 'unspecified'
      if (!byStatus.has(key)) byStatus.set(key, [])
      byStatus.get(key)!.push(d)
    }
    const order = [...STATUSES, 'unspecified']
    for (const s of order) {
      const list = byStatus.get(s)
      if (!list?.length) continue
      lines.push(`    - ${s} (${list.length})`)
      for (const d of list.slice(0, MINDMAP_GROUP_CAP)) {
        lines.push(`      - [${d.title.replace(/[[\]]/g, '')}](${d.path})`)
      }
      if (list.length > MINDMAP_GROUP_CAP) lines.push(`      - …其余 ${list.length - MINDMAP_GROUP_CAP} 篇见 INDEX.md`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

interface CheckError {
  path: string
  message: string
}

function resolveLinkTarget(docRel: string, raw: string): boolean {
  // 支持 [文本](路径) 写法、锚点、相对文档目录与相对仓库根两种解析
  const mdLink = raw.match(/^\[[^\]]*\]\(([^)]+)\)$/)
  let target = (mdLink ? mdLink[1] : raw).split('#')[0].trim()
  if (!target || /^https?:/.test(target)) return true
  if (existsSync(join(DOCS_DIR, dirname(docRel), target))) return true
  if (existsSync(join(REPO_ROOT, target))) return true
  return false
}

function checkDocs(docs: DocMeta[]): CheckError[] {
  const errors: CheckError[] = []
  for (const d of docs) {
    if (!d.hasFrontmatter) continue // 存量无 frontmatter 属预期，只约束新格式
    const raw = parseFrontmatter(readFileSync(join(DOCS_DIR, d.path), 'utf8'))!
    // type 是规范 frontmatter 的唯一 schema 标记：无 type 视为外来 schema（Cursor plan 等），跳过
    if (raw.type === undefined || raw.type === '') continue
    if (!(TYPES as readonly string[]).includes(String(raw.type))) {
      errors.push({ path: d.path, message: `type 非法：${String(raw.type)}（受控枚举：${TYPES.join('|')}）` })
    }
    for (const field of ['title', 'status', 'date']) {
      if (raw[field] === undefined || raw[field] === '') errors.push({ path: d.path, message: `frontmatter 缺必填字段 ${field}` })
    }
    if (raw.status !== undefined && raw.status !== '' && !(STATUSES as readonly string[]).includes(String(raw.status))) {
      errors.push({ path: d.path, message: `status 非法：${String(raw.status)}（受控枚举：${STATUSES.join('|')}）` })
    }
    if (typeof raw.date === 'string' && raw.date && !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
      errors.push({ path: d.path, message: `date 格式应为 YYYY-MM-DD：${raw.date}` })
    }
    for (const target of [d.supersedes, ...d.related]) {
      if (target && !resolveLinkTarget(d.path, target)) {
        errors.push({ path: d.path, message: `related/supersedes 指向不存在的文件：${target}` })
      }
    }
  }
  return errors
}

function main(): void {
  const checkOnly = process.argv.includes('--check')
  if (!existsSync(DOCS_DIR) || !statSync(DOCS_DIR).isDirectory()) {
    console.error('未找到 docs/ 目录，请在仓库根目录运行')
    process.exit(1)
  }

  const files = walk(DOCS_DIR)
    .map((f) => relative(DOCS_DIR, f).split('\\').join('/'))
    .filter((rel) => !excluded(rel))
    .sort()

  const docs = files.map((rel) => extractMeta(rel, readFileSync(join(DOCS_DIR, rel), 'utf8')))
  const groups = new Map<string, DocMeta[]>()
  for (const d of docs) {
    if (!groups.has(d.type)) groups.set(d.type, [])
    groups.get(d.type)!.push(d)
  }
  for (const list of groups.values()) list.sort(cmpDoc)

  const hygiene = collectHygieneWarnings()
  const errors = checkDocs(docs)

  if (checkOnly) {
    const fmCount = docs.filter((d) => d.hasFrontmatter).length
    const specCount = docs.filter((d) => d.typeSource === 'frontmatter').length
    console.log(`扫描 ${docs.length} 篇：${fmCount} 篇带 frontmatter，其中 ${specCount} 篇遵循规范（含 type 字段）；其余为存量/外来 schema，不视为错误`)
    for (const w of hygiene) console.warn(`⚠ ${w}`)
    if (errors.length) {
      for (const e of errors) console.error(`✗ docs/${e.path}: ${e.message}`)
      console.error(`\n${errors.length} 个 frontmatter 校验错误`)
      process.exit(1)
    }
    console.log(`frontmatter 校验通过${hygiene.length ? `（${hygiene.length} 条卫生告警）` : ''}`)
    return
  }

  const fmCount = docs.filter((d) => d.hasFrontmatter).length
  writeFileSync(join(DOCS_DIR, 'INDEX.md'), buildIndex(groups, docs.length, fmCount))
  writeFileSync(
    join(DOCS_DIR, 'docs.json'),
    JSON.stringify(
      {
        generator: 'scripts/docs-index.ts',
        spec: 'docs/README.md',
        count: docs.length,
        docs: docs.map((d) => ({
          path: `docs/${d.path}`,
          title: d.title,
          type: d.type,
          typeSource: d.typeSource,
          status: d.status || null,
          statusSource: d.statusSource,
          date: d.date || null,
          related: d.related,
          supersedes: d.supersedes || null,
          tags: d.tags,
        })),
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(DOCS_DIR, 'MINDMAP.md'), buildMindmap(groups))

  console.log(`已生成 docs/INDEX.md、docs/docs.json、docs/MINDMAP.md（${docs.length} 篇，${fmCount} 篇带 frontmatter）`)
  for (const w of hygiene) console.warn(`⚠ ${w}`)
  if (errors.length) console.error(`⚠ ${errors.length} 个 frontmatter 校验错误（npm run docs:check 查看）`)
}

main()
