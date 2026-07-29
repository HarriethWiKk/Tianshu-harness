import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadAstGrepNapi } from './ast-grep-napi.js'
import {
  inferLang,
  resolveLang,
  collectFiles,
  collectMetaVarNames,
  buildLangMap,
  isDynamicLang,
  ensureDynamicLangsRegistered,
} from './ast-shared.js'

export interface AstGrepInput {
  pattern: string
  paths?: string[]
  lang?: string
  limit?: number
  includeMeta?: boolean
}

export interface AstGrepMatch {
  file: string
  line: number
  column: number
  matchText: string
  metaVariables?: Record<string, string>
}

function formatMatch(m: AstGrepMatch, includeMeta: boolean): string {
  // Multi-line matches (e.g. a whole function) would dump the body into the
  // result line and bury the meta-vars at the end. Show only the first line of
  // the match + a line-count marker, so the meta-var shape summaries stay
  // visible on the same logical line the model scans.
  const raw = m.matchText
  const lines = raw.split('\n')
  const head = lines.length > 1 ? `${lines[0]!.slice(0, 70)} (+${lines.length - 1} 行)` : lines[0]!.slice(0, 80)
  const base = `${m.file}:${m.line}:${m.column}: ${head}`
  if (includeMeta && m.metaVariables && Object.keys(m.metaVariables).length > 0) {
    const mv = Object.entries(m.metaVariables).map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(', ')
    return `${base}  [${mv}]`
  }
  return base
}

/** 空结果首行前缀——search-pod-hook 靠 startsWith 识别；改文案必须与 hook 同步。 */
export const AST_GREP_EMPTY_PREFIX = '0 处匹配'

/** 文件循环让出间隔：readFileSync + tree-sitter 同步解析全仓文件是一个长同步
 *  段，同进程 worker 执行时会冻结 TUI 输入——每处理 20 个文件让出一次事件循环。 */
const YIELD_EVERY_FILES = 20

/** 格式化匹配计数摘要行（空结果时以 AST_GREP_EMPTY_PREFIX 开头）。 */
export function formatAstGrepSummary(matchCount: number, filesScanned: number, errorCount: number): string {
  const errPart = errorCount > 0 ? `，${errorCount} 个错误` : ''
  return `${matchCount} 处匹配，扫描了 ${filesScanned} 个文件${errPart}`
}

export const AST_GREP_TOOL: Tool = {
  definition: {
    name: 'ast_grep',
    description:
      '按 AST 结构（而非文本）搜索代码。用 ast-grep 模式（如 `function $NAME($$$) { $$$ }`）匹配语法节点。返回 file:line:column 及匹配文本。支持 TypeScript/JavaScript/Tsx/Html/Css。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep 模式（如 "function $NAME($$$) { $$$ }"）或 rule 对象' },
        paths: { type: 'array', items: { type: 'string' }, description: '要搜索的文件或目录' },
        lang: { type: 'string', description: '语言：TypeScript、Tsx、JavaScript、Html、Css' },
        limit: { type: 'integer', description: '最大匹配数（默认 50）' },
        includeMeta: { type: 'boolean', description: '是否附带元变量绑定' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const input = params.input as Record<string, unknown>
    const pattern = String(input.pattern ?? '').trim()
    if (!pattern) return { content: '错误：需要提供 pattern', isError: true }

    // Parse the pattern once: a bare pattern string and a `{ rule: ... }` JSON
    // object are both valid ast-grep inputs. Detect rule objects early so we
    // can skip the regex-misuse guard on their internal fields.
    let ruleOrPattern: string | Record<string, unknown> = pattern
    let isRuleObject = false
    try {
      const parsed = JSON.parse(pattern)
      if (parsed && typeof parsed === 'object' && 'rule' in parsed) {
        ruleOrPattern = parsed
        isRuleObject = true
      }
    } catch { /* not JSON — use as bare pattern string */ }

    // Regex-misuse guard: ast_grep uses ast-grep pattern syntax ($NAME, $$NAME),
    // not regular expressions. \d \w \1 etc. will not work as intended.
    if (!isRuleObject && /\\[dDwWsSbB1-9]/.test(pattern)) {
      return {
        content: `错误：pattern 含有正则 token（\\d、\\w、\\s、\\1 等）。\n\nast_grep 使用 ast-grep 语法，不是正则表达式。用 $NAME 捕获单节点，用 $$NAME 做省略（多节点）捕获。\n\n有问题的 pattern：${pattern.slice(0, 80)}`,
        isError: true,
      }
    }

    const paths = Array.isArray(input.paths) ? (input.paths as string[]).filter(p => typeof p === 'string') : ['.']
    const explicitLang = typeof input.lang === 'string' && input.lang.trim() ? input.lang.trim() : undefined
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : 50
    const includeMeta = input.includeMeta === true

    // Dynamic import — @ast-grep/napi is a precompiled native addon
    const loaded = await loadAstGrepNapi()
    if (!loaded.ok) {
      return { content: loaded.message, isError: true }
    }
    const napi = loaded.napi

    const allFiles: string[] = []
    for (const p of paths) {
      const resolved = resolve(params.cwd ?? process.cwd(), p)
      try {
        allFiles.push(...await collectFiles(resolved))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: `错误：${message}`, isError: true }
      }
    }

    const matches: AstGrepMatch[] = []
    const errors: string[] = []
    let filesScanned = 0

    // Lang uses non-enumerable getters — build the map from the resolved napi.
    const LANG_MAP = buildLangMap(napi)
    // Register dynamic languages (python/json) once before any parse — lazy,
    // single-shot, degrades gracefully if the lang-* package is missing.
    await ensureDynamicLangsRegistered(napi)

    let filesProcessed = 0
    for (const filePath of allFiles) {
      // Slice the scan into event-loop-yieldable chunks (see YIELD_EVERY_FILES).
      if (filesProcessed > 0 && filesProcessed % YIELD_EVERY_FILES === 0) {
        await new Promise<void>(r => setImmediate(r))
      }
      filesProcessed++

      const langStr = resolveLang(explicitLang, filePath)
      if (!langStr) {
        errors.push(`${filePath}: 不支持的语言（该扩展名无语法）`)
        continue
      }

      // Dynamic languages (python/json) are parsed by their registered name;
      // built-in languages go through napi.Lang.X via LANG_MAP.
      const langValue = isDynamicLang(langStr) ? langStr : LANG_MAP[langStr]
      // runtime assertion: napi.Lang uses non-enumerable getters — verify we got a real string
      if (typeof langValue !== 'string') {
        errors.push(`${filePath}: LANG_MAP 对 "${langStr}" 返回了非字符串——可能是 @ast-grep/napi API 变更`)
        continue
      }

      let source: string
      try {
        source = readFileSync(filePath, 'utf-8')
      } catch {
        errors.push(`${filePath}: 无法读取文件`)
        continue
      }

      filesScanned++

      let root: ReturnType<ReturnType<typeof napi.parse>['root']>
      try {
        root = napi.parse(langValue, source).root()
      } catch {
        errors.push(`${filePath}: 解析错误`)
        continue
      }

      // tree-sitter error recovery produces ERROR nodes — detect broken syntax
      const errorNodes = root.findAll({ rule: { kind: 'ERROR' } } as unknown as string)
      if (errorNodes.length > 0) {
        errors.push(`${filePath}: 解析错误（${errorNodes.length} 处语法错误）`)
        continue
      }

      let found
      try {
        found = root.findAll(ruleOrPattern as string)
      } catch {
        errors.push(`${filePath}: pattern 编译错误`)
        continue
      }

      for (const node of found) {
        if (matches.length >= limit) break
        const range = node.range()
        const line = range.start.line + 1
        const col = range.start.column + 1
        const match: AstGrepMatch = { file: filePath, line, column: col, matchText: node.text() }
        if (includeMeta) {
          match.metaVariables = {}
          // extract meta-variables from named pattern captures ($NAME, $$ARGS etc.)
          const metaVarDefs = collectMetaVarNames(pattern)
          for (const { name, multi } of metaVarDefs) {
            if (multi) {
              const mvs = node.getMultipleMatches(name)
              if (mvs && mvs.length > 0) {
                // Shape summary, not raw text: a $$$BODY capture can span an
                // entire function (KB of source). The model needs the SHAPE
                // (how big, what it starts with) to judge whether the match is
                // sane — the full text is read_file's job. Precise counts avoid
                // ambiguity: "8 lines" is unambiguous, a truncated code blob is not.
                const texts = mvs.map(n => n.text())
                const nodeCount = texts.length
                const lineCount = texts.reduce((sum, t) => sum + t.split('\n').length, 0)
                const firstLine = texts[0]!.split('\n')[0]!.trim().slice(0, 50)
                match.metaVariables[name] = `${nodeCount}n/${lineCount}L: ${firstLine}`
              }
            } else {
              const mv = node.getMatch(name)
              if (mv) match.metaVariables[name] = mv.text().slice(0, 120)
            }
          }
        }
        matches.push(match)
      }
      if (matches.length >= limit) break
    }

    const summary = formatAstGrepSummary(matches.length, filesScanned, errors.length)
    const body = matches.map(m => formatMatch(m, includeMeta)).join('\n')
    const errorSection = errors.length > 0 ? `\n\n错误：\n${errors.map(e => `  - ${e}`).join('\n')}` : ''

    return { content: `${summary}\n\n${body}${errorSection}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
