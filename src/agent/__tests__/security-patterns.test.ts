import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SECURITY_PATTERNS,
  RuleId,
  ruleNameToId,
  scanContent,
  type SecurityHit,
} from '../security-patterns.js'

/** 断言某文件内容命中指定规则。 */
function assertHit(filePath: string, content: string, ruleName: string): void {
  const hits = scanContent(filePath, content)
  assert.ok(
    hits.some((h: SecurityHit) => h.ruleName === ruleName),
    `expected ${ruleName} to fire on ${filePath}: ${JSON.stringify(content)}`,
  )
}

/** 断言某文件内容不命中指定规则（防误报）。 */
function assertNoHit(filePath: string, content: string, ruleName: string): void {
  const hits = scanContent(filePath, content)
  assert.ok(
    !hits.some((h: SecurityHit) => h.ruleName === ruleName),
    `expected ${ruleName} NOT to fire on ${filePath}: ${JSON.stringify(content)}`,
  )
}

// ── 表结构完整性 ────────────────────────────────────────────────────

test('SECURITY_PATTERNS 有 25 条规则', () => {
  assert.equal(SECURITY_PATTERNS.length, 25)
})

test('每条规则名唯一', () => {
  const names = SECURITY_PATTERNS.map(p => p.ruleName)
  assert.equal(new Set(names).size, names.length)
})

test('每条规则都有 reminder + 至少一个匹配条件', () => {
  for (const p of SECURITY_PATTERNS) {
    assert.ok(p.reminder.length > 0, `${p.ruleName} 缺 reminder`)
    assert.ok(
      p.pathCheck || p.substrings || p.regex,
      `${p.ruleName} 没有任何匹配条件`,
    )
  }
})

test('每条规则名都能映射到 RuleId', () => {
  for (const p of SECURITY_PATTERNS) {
    assert.equal(typeof ruleNameToId(p.ruleName), 'number', `${p.ruleName} 无 RuleId`)
  }
})

test('未知规则名返回 undefined', () => {
  assert.equal(ruleNameToId('user:custom'), undefined)
})

test('RuleId 值冻结（前 5 个锚定）', () => {
  assert.equal(RuleId.GITHUB_ACTIONS_WORKFLOW, 1)
  assert.equal(RuleId.CHILD_PROCESS_EXEC, 2)
  assert.equal(RuleId.PICKLE_WRAPPER_LOAD, 25)
})

// ── 命令注入类 ──────────────────────────────────────────────────────

test('child_process_exec: JS 里 exec( 命中', () => {
  assertHit('a.js', 'exec(`ls ${dir}`)', 'child_process_exec')
  assertHit('a.ts', "child_process.exec('ls')", 'child_process_exec')
})

test('child_process_exec: 方法调用 foo.exec( 不命中（lookbehind 排除 .）', () => {
  assertNoHit('a.js', 'db.exec("SELECT 1")', 'child_process_exec')
})

test('child_process_exec: 非 JS 文件不命中（pathFilter）', () => {
  assertNoHit('a.py', 'exec(code)', 'child_process_exec')
})

test('os_system_injection: Python os.system 命中', () => {
  assertHit('a.py', 'os.system("rm " + f)', 'os_system_injection')
})

test('os_system_injection: 非 Python 文件不命中', () => {
  assertNoHit('a.ts', 'os.system("ls")', 'os_system_injection')
})

test('python_subprocess_shell: shell=True 命中', () => {
  assertHit('a.py', 'subprocess.run(cmd, shell=True)', 'python_subprocess_shell')
})

test('python_subprocess_shell: 无 shell=True 不命中', () => {
  assertNoHit('a.py', 'subprocess.run(["ls", d])', 'python_subprocess_shell')
})

test('go_exec_shell_injection: exec.Command("sh"...) 命中', () => {
  assertHit('a.go', 'exec.Command("sh", "-c", x)', 'go_exec_shell_injection')
})

test('go_exec_shell_injection: 直接命令不命中', () => {
  assertNoHit('a.go', 'exec.Command("ping", "-c", "1", host)', 'go_exec_shell_injection')
})

// ── 注入执行类 ──────────────────────────────────────────────────────

test('eval_injection: eval( 命中', () => {
  assertHit('a.js', 'eval(userInput)', 'eval_injection')
})

test('eval_injection: 方法调用 spec.eval( 不命中', () => {
  assertNoHit('a.js', 'model.eval()', 'eval_injection')
})

test('eval_injection: 文档文件不命中（pathFilter）', () => {
  assertNoHit('README.md', 'eval(x)', 'eval_injection')
})

test('new_function_injection: new Function 命中', () => {
  assertHit('a.js', 'const f = new Function("return " + s)', 'new_function_injection')
})

// ── XSS 类 ──────────────────────────────────────────────────────────

test('innerHTML_xss: .innerHTML = 命中', () => {
  assertHit('a.js', 'el.innerHTML = data', 'innerHTML_xss')
  assertHit('a.js', 'el.innerHTML=data', 'innerHTML_xss')
})

test('innerHTML_xss: 读取 innerHTML 不命中', () => {
  assertNoHit('a.js', 'const x = el.innerHTML', 'innerHTML_xss')
})

test('outerHTML_xss / insertAdjacentHTML / document.write / dangerouslySetInnerHTML', () => {
  assertHit('a.js', 'el.outerHTML = s', 'outerHTML_xss')
  assertHit('a.js', 'el.insertAdjacentHTML("beforeend", s)', 'insertAdjacentHTML_xss')
  assertHit('a.js', 'document.write(s)', 'document_write_xss')
  assertHit('a.jsx', '<div dangerouslySetInnerHTML={{__html: s}} />', 'react_dangerously_set_html')
})

test('script_src_without_sri: 无 integrity 的外链脚本命中', () => {
  assertHit('a.html', '<script src="https://cdn.example.com/x.js"></script>', 'script_src_without_sri')
})

test('script_src_without_sri: 带 integrity 不命中', () => {
  assertNoHit(
    'a.html',
    '<script src="https://cdn.example.com/x.js" integrity="sha384-abc" crossorigin="anonymous"></script>',
    'script_src_without_sri',
  )
})

// ── 反序列化 RCE 类 ─────────────────────────────────────────────────

test('pickle_deserialization: pickle.loads 命中', () => {
  assertHit('a.py', 'pickle.loads(data)', 'pickle_deserialization')
})

test('pickle_deserialization: pickle.dump 不命中（非 RCE 面）', () => {
  assertNoHit('a.py', 'pickle.dump(obj, f)', 'pickle_deserialization')
})

test('torch_unsafe_load: torch.load 无 weights_only 命中', () => {
  assertHit('a.py', 'torch.load("model.pt")', 'torch_unsafe_load')
})

test('torch_unsafe_load: weights_only=True 抑制', () => {
  assertNoHit('a.py', 'torch.load("model.pt", weights_only=True)', 'torch_unsafe_load')
})

test('unsafe_yaml_load: yaml.load 命中,safe_load 不命中', () => {
  assertHit('a.py', 'yaml.load(f)', 'unsafe_yaml_load')
  assertNoHit('a.py', 'yaml.safe_load(f)', 'unsafe_yaml_load')
})

test('yaml_unsafe_load_variants: yaml.unsafe_load 命中', () => {
  assertHit('a.py', 'yaml.unsafe_load(f)', 'yaml_unsafe_load_variants')
})

test('marshal / shelve / pickle_variants / pickle_wrapper', () => {
  assertHit('a.py', 'marshal.loads(b)', 'marshal_loads')
  assertHit('a.py', 'shelve.open("db")', 'shelve_open')
  assertHit('a.py', 'cloudpickle.load(f)', 'pickle_variants_load')
  assertHit('a.py', 'joblib.load("m.pkl")', 'pickle_wrapper_load')
  assertHit('a.py', 'np.load("x.npy", allow_pickle=True)', 'pickle_wrapper_load')
})

test('pickle_wrapper: numpy.load 无 allow_pickle 不命中', () => {
  assertNoHit('a.py', 'np.load("x.npy")', 'pickle_wrapper_load')
})

test('xml_unsafe_parse: ElementTree.parse 命中', () => {
  assertHit('a.py', 'ET.parse("x.xml")', 'xml_unsafe_parse')
})

// ── 加密 / TLS 类 ───────────────────────────────────────────────────

test('node_createcipher_no_iv: createCipher 命中', () => {
  assertHit('a.js', 'crypto.createCipher("aes", k)', 'node_createcipher_no_iv')
})

test('aes_ecb_mode: ECB 模式命中', () => {
  assertHit('a.py', 'AES.MODE_ECB', 'aes_ecb_mode')
  assertHit('a.js', 'const alg = "aes-256-ecb"', 'aes_ecb_mode')
})

test('tls_verification_disabled: verify=False / rejectUnauthorized:false 命中', () => {
  assertHit('a.py', 'requests.get(u, verify=False)', 'tls_verification_disabled')
  assertHit('a.js', 'new Agent({ rejectUnauthorized: false })', 'tls_verification_disabled')
  assertHit('a.go', 'tls.Config{InsecureSkipVerify: true}', 'tls_verification_disabled')
})

// ── 路径类 ──────────────────────────────────────────────────────────

test('github_actions_workflow: .github/workflows/*.yml 命中', () => {
  assertHit('.github/workflows/ci.yml', 'run: echo hi', 'github_actions_workflow')
  assertHit('.github/workflows/ci.yaml', 'run: echo hi', 'github_actions_workflow')
})

test('github_actions_workflow: 普通 yaml 不命中', () => {
  assertNoHit('config/app.yml', 'foo: bar', 'github_actions_workflow')
})

// ── 干净代码零命中 ──────────────────────────────────────────────────

test('干净代码不产生任何命中', () => {
  const clean = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
  assert.deepEqual(scanContent('math.ts', clean), [])
})
