import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LogCapture,
  normalizeConsoleLevel,
  formatConsoleLine,
  formatNetworkLine,
  formatNetworkDetail,
  shouldCaptureResponseBody,
  truncateResponseBody,
  classifyBrowserDebugLine,
  maskSensitiveHeaders,
  maskSecretValue,
  formatCookies,
  formatStorage,
  parseNetworkLine,
  classifyNetworkError,
  networkErrorHint,
  consoleSignature,
} from '../log-capture.js'

test('normalizeConsoleLevel maps warning to warn', () => {
  assert.equal(normalizeConsoleLevel('warning'), 'warn')
  assert.equal(normalizeConsoleLevel('error'), 'error')
  assert.equal(normalizeConsoleLevel('verbose'), 'debug')
  assert.equal(normalizeConsoleLevel('other'), 'log')
})

test('formatConsoleLine prefixes level for TUI colouring', () => {
  const line = formatConsoleLine({ level: 'error', text: 'boom', ts: 0 })
  assert.equal(line, '[error] boom')
})

test('classifyBrowserDebugLine buckets console levels', () => {
  assert.equal(classifyBrowserDebugLine('[error] boom'), 'error')
  assert.equal(classifyBrowserDebugLine('[warn] careful'), 'warn')
  assert.equal(classifyBrowserDebugLine('[info] fyi'), 'muted')
  assert.equal(classifyBrowserDebugLine('[log] noise'), 'muted')
  assert.equal(classifyBrowserDebugLine('[debug] trace'), 'muted')
})

test('classifyBrowserDebugLine buckets network lines by glyph and status', () => {
  assert.equal(classifyBrowserDebugLine('✗ GET /a (net::ERR)'), 'error')
  assert.equal(classifyBrowserDebugLine('→ GET /a'), 'pending')
  assert.equal(classifyBrowserDebugLine('← 200 GET /a (12ms)'), 'ok')
  assert.equal(classifyBrowserDebugLine('← 404 GET /a'), 'warn')
  assert.equal(classifyBrowserDebugLine('← 500 GET /a'), 'error')
  assert.equal(classifyBrowserDebugLine('← 301 GET /a'), 'muted')
  assert.equal(classifyBrowserDebugLine('plain text'), 'muted')
})

test('formatNetworkLine renders pending, success, and failure glyphs', () => {
  const pending = formatNetworkLine({ requestId: '1', method: 'GET', url: '/a', startedAt: 0 })
  assert.match(pending, /^→ GET/)
  const ok = formatNetworkLine({
    requestId: '1', method: 'GET', url: '/a', startedAt: 0, status: 200, durationMs: 12,
  })
  assert.match(ok, /^← 200 GET.*\(12ms\)/)
  const fail = formatNetworkLine({
    requestId: '2', method: 'POST', url: '/b', startedAt: 0, failed: true, errorText: 'net::ERR',
  })
  assert.match(fail, /^✗ POST/)
})

test('formatNetworkLine includeBody appends response snippet', () => {
  const line = formatNetworkLine({
    requestId: 'r1',
    method: 'POST',
    url: 'http://localhost/api/x',
    startedAt: 0,
    status: 500,
    responseBody: '{"error":"bad"}',
  }, true)
  assert.match(line, /body: \{"error":"bad"\}/)
})

test('formatNetworkDetail includes body and metadata', () => {
  const detail = formatNetworkDetail({
    requestId: 'r2',
    method: 'POST',
    url: 'http://localhost/api/login',
    startedAt: 0,
    status: 401,
    durationMs: 45,
    resourceType: 'fetch',
    contentType: 'application/json',
    responseBody: '{"message":"unauthorized"}',
  })
  assert.match(detail, /id: r2/)
  assert.match(detail, /status: 401/)
  assert.match(detail, /type: fetch/)
  assert.match(detail, /unauthorized/)
})

test('maskSensitiveHeaders redacts tokens/cookies, keeps others', () => {
  const masked = maskSensitiveHeaders({
    Authorization: 'Bearer secret-token-abcd',
    Cookie: 'session=xyz9',
    'Content-Type': 'application/json',
    'X-Api-Key': 'k',
  })
  assert.equal(masked['Authorization'], '***(…abcd)')
  assert.equal(masked['Cookie'], '***(…xyz9)')
  assert.equal(masked['X-Api-Key'], '***(…)')
  assert.equal(masked['Content-Type'], 'application/json')
})

test('LogCapture stores request headers/payload and preserves through completeRequest', () => {
  const cap = new LogCapture()
  cap.startRequest(
    'r9', 'POST', 'http://localhost/api/login', Date.now(), 'fetch',
    { Authorization: 'Bearer tok-1234', 'Content-Type': 'application/json' },
    '{"user":"a","pass":"p"}',
  )
  cap.completeRequest('r9', 401, Date.now(), 'fetch', { 'x-request-id': 'req-42' })
  const entry = cap.getByRequestId('r9')!
  assert.equal(entry.requestHeaders?.['Authorization'], 'Bearer tok-1234')
  assert.equal(entry.requestBody, '{"user":"a","pass":"p"}')
  assert.equal(entry.responseHeaders?.['x-request-id'], 'req-42')
})

test('formatNetworkDetail shows masked request/response headers and payload', () => {
  const detail = formatNetworkDetail({
    requestId: 'r9',
    method: 'POST',
    url: 'http://localhost/api/login',
    startedAt: 0,
    status: 401,
    resourceType: 'fetch',
    requestHeaders: { Authorization: 'Bearer tok-1234', 'Content-Type': 'application/json' },
    requestBody: '{"user":"a"}',
    responseHeaders: { 'set-cookie': 'sess=abcd1234' },
    responseBody: '{"message":"unauthorized"}',
  })
  assert.match(detail, /request headers:/)
  assert.match(detail, /Authorization: \*\*\*\(…1234\)/)
  assert.match(detail, /request body:/)
  assert.match(detail, /"user":"a"/)
  assert.match(detail, /response headers:/)
  assert.match(detail, /set-cookie: \*\*\*\(…1234\)/)
  assert.doesNotMatch(detail, /Bearer tok-1234/)
})

test('shouldCaptureResponseBody for xhr/fetch and 4xx+', () => {
  assert.equal(shouldCaptureResponseBody('xhr', 200), true)
  assert.equal(shouldCaptureResponseBody('fetch', 200), true)
  assert.equal(shouldCaptureResponseBody('document', 404), true)
  assert.equal(shouldCaptureResponseBody('document', 200), false)
})

test('truncateResponseBody caps at 2048 chars', () => {
  const long = 'x'.repeat(3000)
  const { body, truncated } = truncateResponseBody(long)
  assert.equal(body.length, 2048)
  assert.equal(truncated, true)
})

test('LogCapture url_filter and api_only filters', () => {
  const cap = new LogCapture()
  cap.startRequest('a', 'GET', 'http://localhost/static/app.js', Date.now(), 'script')
  cap.completeRequest('a', 200)
  cap.startRequest('b', 'POST', 'http://localhost/api/data', Date.now(), 'fetch')
  cap.completeRequest('b', 500)
  cap.attachResponseBody('b', '{"err":true}', 'application/json')

  const api = cap.getNetwork({ apiOnly: true })
  assert.equal(api.length, 1)
  assert.equal(api[0]!.requestId, 'b')

  const filtered = cap.getNetwork({ urlFilter: '/api/' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]!.requestId, 'b')
})

test('LogCapture failed_only keeps 4xx/5xx and network failures', () => {
  const cap = new LogCapture()
  cap.startRequest('a', 'GET', 'http://localhost/ok')
  cap.completeRequest('a', 200)
  cap.startRequest('b', 'POST', 'http://localhost/bad')
  cap.completeRequest('b', 500)
  cap.failRequest('c', 'GET', 'http://localhost/down', 'aborted')

  const failed = cap.getNetwork({ failedOnly: true })
  assert.equal(failed.length, 2)
})

test('LogCapture getByRequestId returns entry with body', () => {
  const cap = new LogCapture()
  cap.startRequest('x', 'GET', '/')
  cap.completeRequest('x', 200)
  cap.attachResponseBody('x', 'ok', 'text/plain')
  const entry = cap.getByRequestId('x')
  assert.equal(entry?.responseBody, 'ok')
})

test('LogCapture clear wipes buffers', () => {
  const cap = new LogCapture()
  cap.addConsole('log', 'hi')
  cap.startRequest('x', 'GET', '/')
  cap.clear()
  assert.equal(cap.getConsole().length, 0)
  assert.equal(cap.getNetwork().length, 0)
})

test('maskSecretValue keeps only the last 4 chars', () => {
  assert.equal(maskSecretValue('abcdef123456'), '***(…3456)')
  assert.equal(maskSecretValue('abc'), '***(…)')
})

test('formatCookies masks values and shows flags', () => {
  const out = formatCookies([
    { name: 'session', value: 'abcdef123456', domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'theme', value: 'dark' },
  ])
  const lines = out.split('\n')
  assert.equal(lines[0], 'session=***(…3456)  [localhost/; httpOnly; secure; sameSite=Lax]')
  assert.equal(lines[1], 'theme=***(…)')
  assert.ok(!out.includes('abcdef123456'), 'raw cookie value must not leak')
})

test('formatCookies handles empty list', () => {
  assert.equal(formatCookies([]), '(no cookies)')
})

test('formatStorage masks secret-looking keys, shows the rest', () => {
  const out = formatStorage({ authToken: 'zzzzsecret9999', theme: 'dark' })
  const lines = out.split('\n')
  assert.ok(lines.some((l) => l === 'authToken: ***(…9999)'), 'sensitive key value masked')
  assert.ok(lines.some((l) => l === 'theme: dark'), 'non-sensitive value shown')
  assert.ok(!out.includes('zzzzsecret9999'), 'raw secret must not leak')
})

test('parseNetworkLine round-trips completed/pending/failed lines', () => {
  const ok = parseNetworkLine(formatNetworkLine({ requestId: 'r1', method: 'POST', url: 'http://localhost/api/x', status: 500, durationMs: 42, startedAt: 0, resourceType: 'fetch' }))
  assert.deepEqual(ok, { dir: 'ok', status: 500, method: 'POST', url: 'http://localhost/api/x', durationMs: 42, resourceType: 'fetch' })

  const pending = parseNetworkLine(formatNetworkLine({ requestId: 'r2', method: 'GET', url: 'http://localhost/', startedAt: 0, resourceType: 'document' }))
  assert.deepEqual(pending, { dir: 'pending', method: 'GET', url: 'http://localhost/', resourceType: 'document' })

  const failed = parseNetworkLine(formatNetworkLine({ requestId: 'r3', method: 'GET', url: 'http://localhost/down', failed: true, errorText: 'aborted', startedAt: 0 }))
  assert.deepEqual(failed, { dir: 'failed', method: 'GET', url: 'http://localhost/down', errorText: 'aborted', resourceType: undefined })
})

test('parseNetworkLine returns null for non-network lines', () => {
  assert.equal(parseNetworkLine('[error] boom'), null)
  assert.equal(parseNetworkLine('  body: {"x":1}'), null)
  assert.equal(parseNetworkLine('(no matching network activity)'), null)
  assert.equal(parseNetworkLine('session=***(…3456)'), null)
})

test('formatStorage truncates long non-sensitive values and reports empty', () => {
  assert.equal(formatStorage({}), '(empty)')
  const long = 'x'.repeat(300)
  const out = formatStorage({ blob: long })
  assert.ok(out.includes('… (truncated)'))
  assert.ok(out.length < long.length + 30)
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — 错误驱动观测包：网络分类 + console 聚类
// ═══════════════════════════════════════════════════════════════════════════

// ── classifyNetworkError ──────────────────────────────────────────────────

test('classifyNetworkError: status >= 500 → HTTP_5XX', () => {
  assert.equal(classifyNetworkError(undefined, 500), 'HTTP_5XX')
  assert.equal(classifyNetworkError(undefined, 502), 'HTTP_5XX')
})

test('classifyNetworkError: status >= 400 → HTTP_4XX', () => {
  assert.equal(classifyNetworkError(undefined, 404), 'HTTP_4XX')
  assert.equal(classifyNetworkError(undefined, 403), 'HTTP_4XX')
  assert.equal(classifyNetworkError(undefined, 401), 'HTTP_4XX')
})

test('classifyNetworkError: status beats error text — 500 with CONNECTION_REFUSED text still HTTP_5XX', () => {
  assert.equal(classifyNetworkError('ECONNREFUSED', 500), 'HTTP_5XX')
})

test('classifyNetworkError: CONNECTION_REFUSED variants', () => {
  assert.equal(classifyNetworkError('connection refused'), 'CONNECTION_REFUSED')
  assert.equal(classifyNetworkError('ECONNREFUSED'), 'CONNECTION_REFUSED')
})

test('classifyNetworkError: TIMEOUT variants', () => {
  assert.equal(classifyNetworkError('timed out'), 'TIMEOUT')
  assert.equal(classifyNetworkError('request timeout'), 'TIMEOUT')
  assert.equal(classifyNetworkError('ETIMEDOUT'), 'TIMEOUT')
})

test('classifyNetworkError: DNS variants', () => {
  assert.equal(classifyNetworkError('name not resolved'), 'DNS')
  assert.equal(classifyNetworkError('ENOTFOUND'), 'DNS')
  assert.equal(classifyNetworkError('EAI_AGAIN'), 'DNS')
})

test('classifyNetworkError: CORS variants', () => {
  assert.equal(classifyNetworkError('cors error'), 'CORS')
  assert.equal(classifyNetworkError('cross-origin blocked'), 'CORS')
  assert.equal(classifyNetworkError('blocked by cors policy'), 'CORS')
})

test('classifyNetworkError: ABORTED variants', () => {
  assert.equal(classifyNetworkError('aborted'), 'ABORTED')
  assert.equal(classifyNetworkError('ECONNABORTED'), 'ABORTED')
  assert.equal(classifyNetworkError('request cancelled'), 'ABORTED')
})

test('classifyNetworkError: CERT variants', () => {
  assert.equal(classifyNetworkError('certificate expired'), 'CERT')
  assert.equal(classifyNetworkError('ssl error'), 'CERT')
  assert.equal(classifyNetworkError('tls handshake failed'), 'CERT')
  assert.equal(classifyNetworkError('self signed certificate'), 'CERT')
})

test('classifyNetworkError: fallback to NETWORK', () => {
  assert.equal(classifyNetworkError('net::ERR_FAILED'), 'NETWORK')
  assert.equal(classifyNetworkError(undefined), 'NETWORK')
  assert.equal(classifyNetworkError(''), 'NETWORK')
})

// ── networkErrorHint ──────────────────────────────────────────────────────

test('networkErrorHint: all categories except NETWORK return non-empty hint', () => {
  const categories = [
    'CONNECTION_REFUSED', 'TIMEOUT', 'DNS', 'CORS',
    'ABORTED', 'CERT', 'HTTP_5XX', 'HTTP_4XX',
  ] as const
  for (const cat of categories) {
    const hint = networkErrorHint(cat)
    assert.ok(hint.length > 0, `${cat} 应有提示文本`)
  }
})

test('networkErrorHint: NETWORK returns empty string', () => {
  assert.equal(networkErrorHint('NETWORK'), '')
})

// ── consoleSignature ──────────────────────────────────────────────────────

test('consoleSignature strips source location markers', () => {
  const sig = consoleSignature(
    'TypeError: Cannot read properties of undefined at /src/foo.ts:12:3',
  )
  assert.equal(sig, 'TypeError: Cannot read properties of undefined at')
})

test('consoleSignature: same error at different line:col → same signature', () => {
  const a = consoleSignature('Uncaught Error: boom at app.ts:10:5')
  const b = consoleSignature('Uncaught Error: boom at app.ts:47:1')
  assert.equal(a, b)
})

test('consoleSignature strips hex addresses', () => {
  const sig = consoleSignature('segfault at 0x7fff5c3a0000 memory')
  assert.equal(sig, 'segfault at 0x… memory')
})

test('consoleSignature: first line only — stack trace discarded', () => {
  const sig = consoleSignature('Error: fail\n    at foo (bar.ts:1:2)\n    at baz (qux.ts:3:4)')
  assert.equal(sig, 'Error: fail')
})

test('consoleSignature normalises repeated whitespace', () => {
  const sig = consoleSignature('  TypeError:   x.y   is   not   a function  ')
  assert.equal(sig, 'TypeError: x.y is not a function')
})

test('consoleSignature: empty / whitespace-only input', () => {
  assert.equal(consoleSignature(''), '')
  assert.equal(consoleSignature('   '), '')
})

// ── getConsoleClusters ─────────────────────────────────────────────────────

test('getConsoleClusters: single entry → one cluster with count 1', () => {
  const cap = new LogCapture()
  cap.addConsole('error', 'Uncaught TypeError: x is undefined at foo.ts:12:3')
  const clusters = cap.getConsoleClusters()
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]!.count, 1)
})

test('getConsoleClusters: same error at different lines → one cluster count 2', () => {
  const cap = new LogCapture()
  cap.addConsole('error', 'Uncaught TypeError: x is undefined at foo.ts:12:3')
  cap.addConsole('error', 'Uncaught TypeError: x is undefined at foo.ts:47:1')
  const clusters = cap.getConsoleClusters()
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]!.count, 2)
})

test('getConsoleClusters: different errors → separate clusters', () => {
  const cap = new LogCapture()
  cap.addConsole('error', 'TypeError: a.b is not a function at app.ts:1:2')
  cap.addConsole('error', 'ReferenceError: c is not defined at app.ts:5:6')
  const clusters = cap.getConsoleClusters()
  assert.equal(clusters.length, 2)
})

test('getConsoleClusters: level filter', () => {
  const cap = new LogCapture()
  cap.addConsole('error', 'boom')
  cap.addConsole('warn', 'careful')
  cap.addConsole('error', 'boom again')
  // 'boom' and 'boom again' are different text → separate clusters
  const errs = cap.getConsoleClusters('error')
  assert.equal(errs.length, 2)
  // Only warns
  const warns = cap.getConsoleClusters('warn')
  assert.equal(warns.length, 1)
  assert.equal(warns[0]!.sample, 'careful')
})

// ── formatNetworkLine with classification hints ───────────────────────────

test('formatNetworkLine: failed connection refused appends hint', () => {
  const line = formatNetworkLine({
    requestId: 'r', method: 'GET', url: 'http://localhost:3000/api', startedAt: 0,
    failed: true, errorText: 'ECONNREFUSED',
  })
  assert.match(line, /✗/)
  assert.match(line, /服务器未启动或端口错误/)
})

test('formatNetworkLine: 500 status appends server error hint', () => {
  const line = formatNetworkLine({
    requestId: 'r', method: 'POST', url: 'http://localhost/api', startedAt: 0,
    status: 500, durationMs: 10,
  })
  assert.match(line, /← 500/)
  assert.match(line, /服务端错误/)
})

test('formatNetworkLine: 404 appends client error hint', () => {
  const line = formatNetworkLine({
    requestId: 'r', method: 'GET', url: 'http://localhost/missing', startedAt: 0,
    status: 404,
  })
  assert.match(line, /客户端错误/)
})

test('formatNetworkLine: 200 has no hint suffix', () => {
  const line = formatNetworkLine({
    requestId: 'r', method: 'GET', url: 'http://localhost/', startedAt: 0,
    status: 200, durationMs: 5,
  })
  assert.doesNotMatch(line, /（/)
})

// ── parseNetworkLine strips classification hints ─────────────────────────

test('parseNetworkLine: strips hint from failed line with CONNECTION_REFUSED', () => {
  const parsed = parseNetworkLine(
    '✗ GET http://localhost:3000/api (ECONNREFUSED) （服务器未启动或端口错误）',
  )
  assert.deepEqual(parsed, {
    dir: 'failed',
    method: 'GET',
    url: 'http://localhost:3000/api',
    errorText: 'ECONNREFUSED',
    resourceType: undefined,
  })
})

test('parseNetworkLine: strips hint from 500 line', () => {
  const parsed = parseNetworkLine(
    '← 500 POST http://localhost/api (42ms) （服务端错误——检查服务端日志）',
  )
  assert.deepEqual(parsed, {
    dir: 'ok',
    status: 500,
    method: 'POST',
    url: 'http://localhost/api',
    durationMs: 42,
    resourceType: undefined,
  })
})

test('parseNetworkLine round-trip: classified failed line survives format→parse', () => {
  const entry = {
    requestId: 'r', method: 'POST', url: 'http://localhost/api/x', startedAt: 0,
    failed: true, errorText: 'ECONNREFUSED',
  } as const
  const formatted = formatNetworkLine(entry)
  const parsed = parseNetworkLine(formatted)
  assert.deepEqual(parsed, {
    dir: 'failed',
    method: 'POST',
    url: 'http://localhost/api/x',
    errorText: 'ECONNREFUSED',
    resourceType: undefined,
  })
})

test('parseNetworkLine round-trip: 500 + resourceType survives format→parse', () => {
  const entry = {
    requestId: 'r', method: 'POST', url: 'http://localhost/api/x', startedAt: 0,
    status: 500, durationMs: 42, resourceType: 'fetch' as const,
  }
  const formatted = formatNetworkLine(entry)
  const parsed = parseNetworkLine(formatted)
  assert.deepEqual(parsed, {
    dir: 'ok',
    status: 500,
    method: 'POST',
    url: 'http://localhost/api/x',
    durationMs: 42,
    resourceType: 'fetch',
  })
})
