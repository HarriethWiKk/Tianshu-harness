import { extname } from 'path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { getResolvedEnv } from './resolved-env.js'

// esbuild ships a native binary, so it can't be inlined into the tsup bundle.
// Load it lazily via require so a packaged sidecar without esbuild on disk
// degrades (skips the JS/TS parse check) instead of crashing at startup with
// ERR_MODULE_NOT_FOUND. Resolved once, then cached (null = unavailable).
//
// We use the async `transform()` API so esbuild runs on its own worker thread
// and never blocks the main event loop (plan: cpu-pool). The sync
// `transformSync` version is kept as an inline fallback if async isn't
// available (very old esbuild), but it is gated behind a 2 MB size limit.

type TransformFn = (input: string, options: Record<string, unknown>) => Promise<unknown>
type TransformSync = (input: string, options: Record<string, unknown>) => unknown

interface EsbuildModule {
  transform: TransformFn
  transformSync: TransformSync
}

let _esbuildPromise: Promise<EsbuildModule | null> | undefined

async function loadEsbuildModule(): Promise<EsbuildModule | null> {
  try {
    const req = createRequire(import.meta.url)
    return req('esbuild') as EsbuildModule
  } catch {
    return null
  }
}

async function getEsbuild(): Promise<EsbuildModule | null> {
  if (_esbuildPromise) return _esbuildPromise
  _esbuildPromise = withTimeout(
    loadEsbuildModule(),
    'esbuild load',
    getEsbuildLoadTimeoutMs(),
  ).catch(() => null)
  return _esbuildPromise
}

/** Test-only: clear the esbuild load cache so each test gets a fresh load attempt. */
export function _resetEsbuildCacheForTest(): void {
  _esbuildPromise = undefined
}

/** Files larger than this skip CSS/HTML/JSON branch checks (O(n) scans). */
const SYNC_SCAN_SIZE_LIMIT = 2 * 1024 * 1024 // 2 MB

/** Files larger than this skip external-parser checks (Python AST, esbuild). */
const EXTERNAL_PARSE_SIZE_LIMIT = 8 * 1024 * 1024 // 8 MB

/** Timeout for esbuild async transform — prevents a hung worker from blocking
 *  the tool call indefinitely (file is already written; losing syntax-check is
 *  a degradation, not a failure). */
const TRANSFORM_TIMEOUT_MS = 5000

/** Timeout for loading the esbuild module itself.
 *
 *  esbuild ships a native binary; on Windows with certain antivirus/EDR
 *  configurations the first require() of the native addon can block the event
 *  loop for minutes. Because the default 2-minute tool timeout uses setTimeout,
 *  a blocked event loop never fires it, so the edit_file call appears to hang
 *  for 5-10 minutes with the UI stuck on "thinking". Loading esbuild async with
 *  a short timeout keeps the event loop alive and lets us degrade gracefully
 *  (skip the parse check) when the binary is slow to arrive.
 *
 *  Override with RIVET_ESBUILD_LOAD_TIMEOUT (ms); set to 0/negative to fall
 *  back to the 3s default. */
function getEsbuildLoadTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_ESBUILD_LOAD_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 3000
}

/** Timeout for the python3 AST parse child process. A hung interpreter (blocked
 *  import, stuck stdin, slow environment) would otherwise leave the promise
 *  unresolved and stall the whole turn. Override with RIVET_PY_SYNTAX_TIMEOUT
 *  (ms); set to 0/negative to fall back to the 5s default. Read lazily so the
 *  env override is honoured (and testable) without a module reload. */
function getPySyntaxTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_PY_SYNTAX_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 5000
}

// ── TypeScript compiler (lazy, ground truth for esbuild false-positive filtering) ──
//
// esbuild's TypeScript parser is stricter than tsc: it rejects legal TS patterns
// like fullwidth parens（／）in JSDoc, certain Unicode positions, and complex
// generics nesting that tsc accepts. When esbuild reports a parse error we run a
// second opinion through the TypeScript compiler API. If TS accepts the file,
// esbuild's error is downgraded to a warning (no rollback). Only when both
// esbuild AND TS reject the file do we treat it as a fatal syntax error.
//
// We use `createSourceFile()` — a pure-syntax parse, ~10-50ms — not `tsc
// --noEmit` which requires tsconfig resolution, type-checking and project-wide
// analysis (~2s). The TS module is kept `external` in tsup (like esbuild) and
// loaded lazily via createRequire so the packaged sidecar without a local
// typescript install degrades to the tsc subprocess fallback.
//
// Timeout: RIVET_TS_LOAD_TIMEOUT (ms); set to 0/negative to fall back to 3s.

let _tsPromise: Promise<any | null> | undefined
let _tsModule: any | undefined

async function loadTsModule(): Promise<any | null> {
  try {
    const req = createRequire(import.meta.url)
    return req('typescript')
  } catch {
    return null
  }
}

async function getTypeScript(): Promise<any | null> {
  if (_tsModule !== undefined) return _tsModule
  if (_tsPromise) {
    _tsModule = await _tsPromise
    return _tsModule
  }
  _tsPromise = withTimeout(
    loadTsModule(),
    'TypeScript load',
    getTsLoadTimeoutMs(),
  ).catch(() => null)
  _tsModule = await _tsPromise
  return _tsModule
}

function getTsLoadTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_TS_LOAD_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 3000
}

/** Test-only: clear the TypeScript load cache. */
export function _resetTsCacheForTest(): void {
  _tsPromise = undefined
  _tsModule = undefined
}

interface TsSecondOpinionResult {
  /** true if TS accepted the file (esbuild false positive). */
  passed: boolean
  /** Parse error messages when TS also rejects the file. */
  errors?: string[]
  /** True when TS module AND tsc subprocess are both unavailable. */
  unavailable?: boolean
}

/** Run TypeScript compiler API as ground-truth second opinion.
 *  Returns {passed:true} when TS parser accepts the file → esbuild false positive.
 *  Returns {passed:false, errors} when TS also reports errors → real syntax error.
 *  Returns {unavailable:true} when TS module is absent → caller should try tsc fallback. */
async function tsSecondOpinion(
  filePath: string,
  content: string,
  ext: string,
): Promise<TsSecondOpinionResult> {
  const ts = await getTypeScript()
  if (!ts || !ts.createSourceFile) return { passed: false, unavailable: true }

  try {
    const scriptKindMap: Record<string, number> = {
      '.ts': ts.ScriptKind?.TS ?? 3,
      '.tsx': ts.ScriptKind?.TSX ?? 4,
      '.js': ts.ScriptKind?.JS ?? 1,
      '.jsx': ts.ScriptKind?.JSX ?? 2,
      '.mjs': ts.ScriptKind?.JS ?? 1,
      '.cjs': ts.ScriptKind?.JS ?? 1,
    }
    const scriptKind = scriptKindMap[ext] ?? scriptKindMap['.ts']!

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget?.Latest ?? 99, // ES2024+
      /* setParentNodes */ true,
      scriptKind,
    )

    // parseDiagnostics contains only syntax/parse errors, not type errors
    const diagnostics: any[] = sourceFile.parseDiagnostics ?? []
    const errorCategory = ts.DiagnosticCategory?.Error ?? 1
    const syntaxErrors = diagnostics.filter((d: any) => d.category === errorCategory)

    if (syntaxErrors.length === 0) {
      return { passed: true }
    }

    const errorMessages = syntaxErrors.slice(0, 5).map((d: any) => {
      const pos = d.file?.getLineAndCharacterOfPosition?.(d.start ?? 0) ??
        sourceFile.getLineAndCharacterOfPosition(d.start ?? 0)
      const msg = typeof ts.flattenDiagnosticMessageText === 'function'
        ? ts.flattenDiagnosticMessageText(d.messageText, '\n')
        : String(d.messageText)
      return `  ${filePath}:${pos.line + 1}:${pos.character + 1} - ${msg}`
    })

    return { passed: false, errors: errorMessages }
  } catch {
    // TS API threw unexpectedly — treat as unavailable, fall through to tsc
    return { passed: false, unavailable: true }
  }
}

/** Timeout for tsc subprocess (used only as fallback when TS module is unavailable). */
function getTscFallbackTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_TSC_FALLBACK_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 8000
}

/** Run `tsc --noEmit` on the written file as a last-resort syntax check.
 *  Only invoked when the TypeScript compiler API module is unavailable.
 *  Returns 'pass' (tsc accepts → esbuild false positive), 'fail' (tsc rejects →
 *  real error), or 'degraded' (tsc unavailable/timeout → defer to esbuild). */
function tscSubprocessCheck(filePath: string): Promise<'pass' | 'fail' | 'degraded'> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npx', ['tsc', '--noEmit', '--pretty', 'false', '--skipLibCheck', filePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getResolvedEnv(),
        windowsHide: true,
        timeout: getTscFallbackTimeoutMs(),
      })
    } catch {
      resolve('degraded')
      return
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      resolve('degraded')
    }, getTscFallbackTimeoutMs())

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve('pass')
      } else {
        resolve('fail')
      }
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve('degraded')
    })
  })
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface SyntaxCheckResult {
  /** Non-fatal lint/style warning to display to the model. */
  warning: string | null
  /** Fatal parse/integrity error. If set, the caller should roll back the write. */
  fatal: string | null
}

const OK: SyntaxCheckResult = { warning: null, fatal: null }

/**
 * Language-agnostic syntax and structural integrity check for written files.
 *
 * Runs after write in edit_file / write_file / hash_edit.
 * Catches syntax errors (missing bracket, broken JSX, unbalanced braces,
 * truncated JSON, unclosed HTML tags) in ~2ms per file and embeds the
 * warning directly into the ToolResult — so the model sees the error
 * immediately instead of discovering it 2–3 turns later.
 *
 * Supported: .ts .tsx .js .jsx (esbuild parser, async), .py (Python AST),
 * .css (brace balance), .html (tag balance), .json (JSON.parse).
 *
 * Returns null if clean or unsupported extension.
 * Returns a warning string if an integrity issue is detected.
 */
export async function syntaxCheck(filePath: string, content: string): Promise<string | null> {
  const result = await checkSyntax(filePath, content)
  return result.warning
}

/**
 * Strict syntax check that distinguishes fatal parse errors from warnings.
 * Fatal errors indicate the file is corrupted or unparseable and should be
 * rolled back by the caller.
 */
export async function checkSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = extname(filePath)

  // ── TypeScript/JavaScript via esbuild async transform ──
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    if (content.length > EXTERNAL_PARSE_SIZE_LIMIT) return OK
    const loaderMap: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
      '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    }
    const loader = loaderMap[ext] ?? 'js'
    const esbuild = await getEsbuild()
    if (!esbuild) return OK
    try {
      if (esbuild.transform) {
        await withTimeout(
          esbuild.transform(content, { loader, target: 'esnext', jsx: 'automatic' }),
          'esbuild transform',
          TRANSFORM_TIMEOUT_MS,
        )
      } else {
        esbuild.transformSync(content, { loader, target: 'esnext', jsx: 'automatic' })
      }
      return OK
    } catch (err) {
      if (!(err instanceof Error)) return OK
      const lines = err.message.split('\n')
      const errorLines = lines.filter(l => /ERROR:|error:/i.test(l))
      const detail = errorLines.length > 0
        ? errorLines.join('\n')
        : lines.slice(1).join('\n')
      const cleaned = detail.replace(/<stdin>:/g, '')

      // Second opinion: TypeScript compiler (ground truth for TS/JS syntax).
      // esbuild's parser is stricter than tsc — it rejects legal TS patterns
      // (fullwidth parens in JSDoc, certain Unicode positions, complex generics).
      // When esbuild and TS disagree, trust TS and downgrade to warning.
      const second = await tsSecondOpinion(filePath, content, ext)

      if (second.passed) {
        // TS accepted the file → esbuild false positive. Warn but don't roll back.
        const msg = `⚠️ 语法检查提示（低风险）：\n${cleaned}\n\n经二次确认，此文件语法正确，文件已保留未回滚。`
        return { warning: msg, fatal: null }
      }

      if (second.unavailable) {
        // TS module not available → try tsc subprocess as last resort
        const tscResult = await tscSubprocessCheck(filePath)
        if (tscResult === 'pass') {
          const msg = `⚠️ 语法检查提示（低风险）：\n${cleaned}\n\n经 tsc 二次确认，此文件语法正确，文件已保留未回滚。`
          return { warning: msg, fatal: null }
        }
        if (tscResult === 'degraded') {
          // Neither TS API nor tsc available — infrastructure failure must NOT
          // masquerade as fatal syntax error. Warn but don't roll back.
          const msg = `⚠️ 语法检查提示：\n${cleaned}\n\n语法验证工具暂时不可用，文件已保留未回滚。建议运行 typecheck 命令手动验证。`
          return { warning: msg, fatal: null }
        }
        // tsc also failed → real error, roll back
      }

      // Both esbuild AND TS/tsc agree — real syntax error. Roll back.
      const tsErrors = second.errors?.length
        ? `\n\n具体错误：\n${second.errors.join('\n')}`
        : ''
      const message = `⚠️ 语法检查发现错误：\n${cleaned}${tsErrors}\n\n文件已写入但存在语法问题，运行时将失败。`
      return { warning: message, fatal: message }
    }
  }

  // ── Python: AST parse via system python3 ──
  if (ext === '.py') {
    if (content.length > EXTERNAL_PARSE_SIZE_LIMIT) return OK
    // 净化孤立 surrogate 后再送子进程:让含 surrogate 的文件仍能拿到真实 AST
    // 反馈,而非因跨进程编码失败直接 degrade。净化只作用于校验副本,不改写盘。
    const result = await checkPythonSyntax(replaceLoneSurrogates(content))
    if (result.error) {
      const message = `⚠️ Python syntax error:\n${result.error}\n\nThe file was written but will fail to import/execute.`
      return { warning: message, fatal: message }
    }
    return OK
  }

  // ── CSS: brace balance check (skip if >2MB) ──
  if (ext === '.css') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    let depth = 0
    let inString = false
    let stringChar = ''
    let inComment = false
    for (let i = 0; i < content.length; i++) {
      const c = content[i]
      const prev = content[i - 1] ?? ''
      if (inComment) {
        if (c === '/' && prev === '*') inComment = false
        continue
      }
      if (c === '/' && content[i + 1] === '*') { inComment = true; i++; continue }
      if (inString) {
        if (c === stringChar && prev !== '\\') inString = false
        continue
      }
      if (c === '"' || c === "'") { inString = true; stringChar = c; continue }
      if (c === '{') depth++
      if (c === '}') depth--
      if (depth < 0) {
        const msg = `⚠️ CSS brace mismatch: unmatched '}' at position ${i}. Remove the extra closing brace.`
        return { warning: msg, fatal: msg }
      }
    }
    if (depth > 0) {
      const msg = `⚠️ CSS brace mismatch: ${depth} unmatched '{' (missing closing '}'). Check for unclosed blocks like @media or rule sets.`
      return { warning: msg, fatal: msg }
    }
    return OK
  }

  // ── HTML: basic tag balance (skip if >2MB) ──
  if (ext === '.html' || ext === '.htm') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    const voids = new Set([
      'area','base','br','col','embed','hr','img','input','link','meta',
      'param','source','track','wbr',
    ])
    const openTagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g
    const stack: { tag: string; pos: number }[] = []
    let match
    while ((match = openTagRe.exec(content)) !== null) {
      const full = match[0]
      const tag = match[1]!.toLowerCase()
      const isClose = full.startsWith('</')
      const isSelfClose = full.endsWith('/>')
      if (isSelfClose || voids.has(tag)) continue
      if (isClose) {
        if (stack.length === 0 || stack[stack.length - 1]!.tag !== tag) {
          const expected = stack.length > 0 ? stack[stack.length - 1]!.tag : 'nothing'
          const msg = `⚠️ HTML tag mismatch: unexpected </${tag}> at position ${match.index} (expected </${expected}>)`
          return { warning: msg, fatal: msg }
        }
        stack.pop()
      } else {
        stack.push({ tag, pos: match.index })
      }
    }
    if (stack.length > 0) {
      const unclosed = stack.map(s => `<${s.tag}>`).join(', ')
      const msg = `⚠️ HTML tag mismatch: ${stack.length} unclosed tag(s): ${unclosed}. Add the missing closing tags.`
      return { warning: msg, fatal: msg }
    }
    return OK
  }

  // ── JSON: parse check (skip if >2MB) ──
  if (ext === '.json') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    try {
      JSON.parse(content)
      return OK
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const message = `⚠️ Invalid JSON: ${msg}`
      return { warning: message, fatal: message }
    }
  }

  return OK
}

interface PythonSyntaxResult {
  ok: boolean
  error?: string
}

/**
 * 判定 Python 子进程的 stderr 是否为「校验器基础设施失败」而非用户代码语法错误。
 *
 * 背景（其他用户 07-30 反馈）:Windows 中文环境写 .py 文件时,内容含孤立
 * surrogate（如 \udc80,GBK→UTF-8 转换残留）会让 python 在读 stdin / compile
 * 阶段抛 UnicodeEncodeError/UnicodeDecodeError——这是跨进程编码问题,不是用户
 * 代码的 SyntaxError。此前 close handler 对所有非零退出一律判 fatal,导致这类
 * IO 失败伪装成语法错误 → 触发回滚 + "请修复内容后重试"（用户根本无从修）。
 *
 * 与模块既有契约一致:missing-interpreter / spawn-error / timeout 都豁免为
 * degrade,编码失败同属基础设施失败,理应一并豁免。真正的 SyntaxError /
 * IndentationError / TabError 不含这些编码标记,仍正常判 fatal（不削弱检测）。
 *
 * 导出供单测:真实子进程难以稳定复现 surrogate 崩溃（Node 写 stdin 会把孤立
 * surrogate 转 U+FFFD），把分类决策抽成纯函数才能可靠测试。
 */
export function isPythonInfraFailure(stderr: string): boolean {
  return /UnicodeEncodeError|UnicodeDecodeError|codec can't (?:en|de)code|surrogates not allowed/i.test(stderr)
}

/**
 * 把孤立 surrogate（未配对的 high/low）替换为 U+FFFD,合法 surrogate pair（如
 * emoji、CJK 扩展区）原样保留。用于 Python 校验前净化传给子进程的内容副本,
 * 使含孤立 surrogate 的文件仍能拿到真实 AST 反馈,而不是直接 degrade。
 *
 * 只作用于校验器副本——不改写盘内容（盘上是模型/用户的真实产物,层1 已保证
 * 不因编码问题被误判 fatal）。逻辑与 utils/sanitize.ts 的 surrogate 处理一致,
 * 但刻意不复用 sanitizeForJsonTransport（它还替换 C0/C1 控制符 + NFC 归一,
 * 会改变实际内容,不适合「等价净化后送校验」——净化越窄,AST 反馈越忠于原文）。
 */
export function replaceLoneSurrogates(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const cp = input.charCodeAt(i)
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += input[i]! + input[i + 1]! // 合法 pair,两个都留
        i++
      } else {
        out += '�' // 孤立 high surrogate
      }
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      out += '�' // 孤立 low surrogate
    } else {
      out += input[i]!
    }
  }
  return out
}

/** Parse Python source via system python3 -c "import ast; ast.parse(...)".
 *  Returns {ok:true} on clean parse OR on any infrastructure failure (missing
 *  interpreter, spawn error, timeout kill) — those must NEVER masquerade as a
 *  fatal syntax error, since the caller rolls back the write on `error`.
 *  Only a genuine non-zero exit with parser output is reported as {ok:false}.
 *  Uses a child process because there is no robust pure-JS Python parser in
 *  the dependency tree, and SWE-bench is overwhelmingly Python. */
function checkPythonSyntax(content: string): Promise<PythonSyntaxResult> {
  const isWin = process.platform === 'win32'
  const candidates: Array<{ command: string; args: string[] }> = isWin
    ? [
        { command: 'py', args: ['-3', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
        { command: 'python', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
        { command: 'python3', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
      ]
    : [
        { command: 'python3', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
        { command: 'python', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
      ]

  async function tryCandidate(candidate: typeof candidates[number]): Promise<PythonSyntaxResult | null> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(candidate.command, candidate.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: getResolvedEnv(),
          windowsHide: true,
        })
      } catch {
        resolve(null) // ENOENT — try next candidate
        return
      }

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        resolve({ ok: true })
      }, getPySyntaxTimeoutMs())

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 || code === null) {
          resolve({ ok: true })
        } else if (isPythonInfraFailure(stderr)) {
          // 编码类失败（UnicodeEncode/DecodeError）是校验器跨进程 IO 问题,
          // 不是用户代码语法错误——degrade 为 OK,绝不触发回滚（与 timeout/
          // missing-interpreter 豁免同语义）。真语法错误不含这些标记,走 else。
          resolve({ ok: true })
        } else {
          resolve({ ok: false, error: stderr.trim() || stdout.trim() || `${candidate.command} exited with code ${code}` })
        }
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null) // ENOENT — try next candidate
      })
      try {
        child.stdin?.write(content)
        child.stdin?.end()
      } catch { /* stdin closed early */ }
    })
  }

  return (async () => {
    for (const candidate of candidates) {
      const result = await tryCandidate(candidate)
      if (result !== null) return result
    }
    // All candidates failed — degrade to OK
    return { ok: true }
  })()
}
