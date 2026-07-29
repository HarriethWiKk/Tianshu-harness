import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLocatorQuery,
  resolveCandidates,
  scoreCandidate,
  parseCandidates,
  formatCandidates,
  type ElementCandidate,
} from '../locator.js'

function el(over: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    selector: over.selector ?? '#x',
    tag: 'button',
    role: null,
    text: '',
    ariaLabel: null,
    placeholder: null,
    value: null,
    title: null,
    name: null,
    id: null,
    type: null,
    disabled: false,
    visible: true,
    ...over,
  }
}

// ── 查询解析 ────────────────────────────────────────────────

test('parseLocatorQuery 剥开头动词与结尾角色名词', () => {
  const q = parseLocatorQuery('点击登录按钮')
  assert.equal(q.action, 'click')
  assert.equal(q.expectRole, 'button')
  assert.deepEqual(q.terms, ['登录'])
})

test('parseLocatorQuery 同样处理英文措辞', () => {
  const q = parseLocatorQuery('click the Login button')
  assert.equal(q.action, 'click')
  assert.equal(q.expectRole, 'button')
  assert.deepEqual(q.terms, ['login'])
})

test('parseLocatorQuery 识别输入类动词与输入框名词', () => {
  const q = parseLocatorQuery('在用户名输入框输入')
  assert.equal(q.expectRole, null, '动词在尾部时不剥——只在开头剥')
  const q2 = parseLocatorQuery('输入用户名输入框')
  assert.equal(q2.action, 'type')
  assert.equal(q2.expectRole, 'textbox')
  assert.deepEqual(q2.terms, ['用户名'])
})

test('动词只在开头剥——中间的同形词是标签的一部分', () => {
  // 靶心：词表式全局替换会把"地点选择"里的"选择"当动词剥掉，标签就残了。
  const q = parseLocatorQuery('地点选择')
  assert.equal(q.action, null)
  assert.deepEqual(q.terms, ['地点选择'])
})

test('角色名词只在结尾剥，且不吃掉整条描述', () => {
  const q = parseLocatorQuery('按钮')
  assert.equal(q.expectRole, null, '整条就是名词时不剥——剥完啥都不剩')
  assert.deepEqual(q.terms, ['按钮'])
})

test('引号里的字面标签按精确词对待', () => {
  const q = parseLocatorQuery('点击 "忘记密码？" 链接')
  // NFKC 归一把全角 ？ 折成半角——归一是有意的（页面文案与用户措辞的全角/半角
  // 往往不一致），所以 quoted 拿到的是归一后的形态。
  assert.equal(q.quoted, '忘记密码?')
  assert.equal(q.action, 'click')
  assert.equal(q.expectRole, 'link')
  assert.deepEqual(q.terms, ['忘记密码?'], '有引号时标签词只认引号内容')
})

// ── 打分 ────────────────────────────────────────────────────

test('不可见元素恒为 0 分', () => {
  const q = parseLocatorQuery('点击登录按钮')
  assert.equal(scoreCandidate(el({ text: '登录', visible: false }), q), 0)
})

test('精确文本命中高于部分包含', () => {
  const q = parseLocatorQuery('点击登录按钮')
  const exact = scoreCandidate(el({ text: '登录' }), q)
  const partial = scoreCandidate(el({ text: '登录后可查看历史记录' }), q)
  assert.ok(exact > partial, `精确 ${exact} 应高于部分 ${partial}`)
})

test('角色一致加分、角色冲突减分', () => {
  const q = parseLocatorQuery('点击登录按钮')
  const asButton = scoreCandidate(el({ text: '登录', tag: 'button' }), q)
  const asLink = scoreCandidate(el({ text: '登录', tag: 'a' }), q)
  assert.ok(asButton > asLink, '要按钮时同名链接不该胜出')
})

test('全角/大小写/标点差异不影响匹配', () => {
  const q = parseLocatorQuery('点击 "Ｌｏｇｉｎ" 按钮')
  assert.ok(scoreCandidate(el({ text: 'login' }), q) > 0.5)
})

test('disabled 元素被压分', () => {
  const q = parseLocatorQuery('点击提交按钮')
  const on = scoreCandidate(el({ text: '提交' }), q)
  const off = scoreCandidate(el({ text: '提交', disabled: true }), q)
  assert.ok(off < on)
})

test('aria-label 与 placeholder 也参与匹配', () => {
  const q = parseLocatorQuery('输入邮箱输入框')
  const byPlaceholder = scoreCandidate(el({ tag: 'input', placeholder: '邮箱' }), q)
  const byAria = scoreCandidate(el({ tag: 'input', ariaLabel: '邮箱' }), q)
  assert.ok(byPlaceholder > 0.35)
  assert.ok(byAria > 0.35)
})

// ── 判定：歧义必须回清单 ────────────────────────────────────

test('唯一强命中返回 match', () => {
  const q = parseLocatorQuery('点击登录按钮')
  const r = resolveCandidates([
    el({ selector: '#login', text: '登录' }),
    el({ selector: '#help', text: '帮助' }),
  ], q)
  assert.equal(r.kind, 'match')
  assert.equal(r.kind === 'match' && r.candidate.selector, '#login')
})

test('两个同分候选必须判歧义并回清单，绝不任选一个', () => {
  // 靶心：这是"启发式定位"与"猜"的分界线。页面上两个「提交」按钮时，
  // 点错的代价是真实副作用，必须把选择权交回模型。
  const q = parseLocatorQuery('点击提交按钮')
  const r = resolveCandidates([
    el({ selector: 'form:nth-of-type(1) > button', text: '提交' }),
    el({ selector: 'form:nth-of-type(2) > button', text: '提交' }),
  ], q)
  assert.equal(r.kind, 'ambiguous')
  assert.equal(r.kind === 'ambiguous' && r.candidates.length, 2)
})

test('全都不沾时返回 none 而不是最高分', () => {
  const q = parseLocatorQuery('点击结算按钮')
  const r = resolveCandidates([
    el({ selector: '#a', text: '关于我们' }),
    el({ selector: '#b', text: '隐私政策' }),
  ], q)
  assert.equal(r.kind, 'none')
})

test('空候选集返回 none 且清单为空', () => {
  const r = resolveCandidates([], parseLocatorQuery('点击登录按钮'))
  assert.equal(r.kind, 'none')
  assert.equal(r.kind === 'none' && r.candidates.length, 0)
})

test('排序在同分时按 selector 稳定——同一页面同一查询结果可复现', () => {
  const q = parseLocatorQuery('点击提交按钮')
  const a = resolveCandidates([el({ selector: '#b', text: '提交' }), el({ selector: '#a', text: '提交' })], q)
  const b = resolveCandidates([el({ selector: '#a', text: '提交' }), el({ selector: '#b', text: '提交' })], q)
  assert.deepEqual(
    a.kind === 'ambiguous' && a.candidates.map((c) => c.candidate.selector),
    b.kind === 'ambiguous' && b.candidates.map((c) => c.candidate.selector),
  )
})

// ── 页面输出解析 ────────────────────────────────────────────

test('parseCandidates 容忍坏输出，给空数组而不是抛', () => {
  assert.deepEqual(parseCandidates('not json'), [])
  assert.deepEqual(parseCandidates('{"not":"array"}'), [])
  assert.deepEqual(parseCandidates('[{"noSelector":1}]'), [])
})

test('parseCandidates 读出合法候选', () => {
  const list = parseCandidates(JSON.stringify([{ selector: '#a', tag: 'button', text: '登录', visible: true }]))
  assert.equal(list.length, 1)
  assert.equal(list[0]!.selector, '#a')
})

test('formatCandidates 带上 selector、标签与分数', () => {
  const out = formatCandidates([{ candidate: el({ selector: '#login', text: '登录' }), score: 0.9 }])
  assert.match(out, /#login/)
  assert.match(out, /登录/)
  assert.match(out, /0\.90/)
})

test('formatCandidates 空清单给可读说明', () => {
  assert.match(formatCandidates([]), /没有找到/)
})
