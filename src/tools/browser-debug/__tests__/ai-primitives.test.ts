import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, extract, observe, type ActDriver } from '../ai-primitives.js'

interface Calls {
  click: string[]
  type: Array<[string, string]>
  press: Array<[string | undefined, string]>
  select: Array<[string, string]>
  hover: string[]
}

/** 假驱动：evaluate 直接吐候选 JSON，其余方法只记账，便于断言"有没有动手"。 */
function fakeDriver(candidates: unknown[], snapshotText = 'page text'): { driver: ActDriver; calls: Calls } {
  const calls: Calls = { click: [], type: [], press: [], select: [], hover: [] }
  const driver: ActDriver = {
    evaluate: async () => JSON.stringify(candidates),
    click: async (s) => { calls.click.push(s) },
    type: async (s, t) => { calls.type.push([s, t]) },
    press: async (s, k) => { calls.press.push([s, k]) },
    selectOption: async (s, v) => { calls.select.push([s, v]); return [v] },
    hover: async (s) => { calls.hover.push(s) },
    snapshot: async () => snapshotText,
  }
  return { driver, calls }
}

function cand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selector: '#x', tag: 'button', role: null, text: '', ariaLabel: null, placeholder: null,
    value: null, title: null, name: null, id: null, type: null, disabled: false, visible: true,
    ...over,
  }
}

// ── act ─────────────────────────────────────────────────────

test('act 命中唯一目标时点击它', async () => {
  const { driver, calls } = fakeDriver([
    cand({ selector: '#login', text: '登录' }),
    cand({ selector: '#about', text: '关于我们' }),
  ])
  const r = await act(driver, { instruction: '点击登录按钮' })
  assert.equal(r.isError, undefined)
  assert.deepEqual(calls.click, ['#login'])
  assert.match(r.content, /登录/)
})

test('act 歧义时绝不动手，只回候选清单', async () => {
  // 靶心：整条路径 A 的安全性都压在这一条上。启发式定位分不清时如果"取最高分"
  // 点下去，就等于在有副作用的操作上赌博。
  const { driver, calls } = fakeDriver([
    cand({ selector: '#submit-a', text: '提交' }),
    cand({ selector: '#submit-b', text: '提交' }),
  ])
  const r = await act(driver, { instruction: '点击提交按钮' })
  assert.equal(r.isError, true)
  assert.deepEqual(calls.click, [], '歧义时一次点击都不该发生')
  assert.match(r.content, /#submit-a/)
  assert.match(r.content, /#submit-b/)
})

test('act 完全不沾时不动手，并给出可交互元素清单', async () => {
  const { driver, calls } = fakeDriver([cand({ selector: '#about', text: '关于我们' })])
  const r = await act(driver, { instruction: '点击结算按钮' })
  assert.equal(r.isError, true)
  assert.deepEqual(calls.click, [])
  assert.match(r.content, /#about/, '未命中也要把页面上有什么告诉模型')
})

test('act 从措辞推断输入动作并写值', async () => {
  const { driver, calls } = fakeDriver([
    cand({ selector: '#user', tag: 'input', placeholder: '用户名' }),
    cand({ selector: '#go', text: '搜索' }),
  ])
  const r = await act(driver, { instruction: '输入用户名输入框', value: 'admin' })
  assert.equal(r.isError, undefined)
  assert.deepEqual(calls.type, [['#user', 'admin']])
  assert.deepEqual(calls.press, [], '未要求 submit 就不该按 Enter')
})

test('act 的 submit 会在输入后回车', async () => {
  const { driver, calls } = fakeDriver([cand({ selector: '#q', tag: 'input', placeholder: '搜索' })])
  await act(driver, { instruction: '输入搜索输入框', value: 'tianshu', submit: true })
  assert.deepEqual(calls.type, [['#q', 'tianshu']])
  assert.deepEqual(calls.press, [['#q', 'Enter']])
})

test('act 的 type/select 缺 value 时报错且不枚举页面', async () => {
  let evaluated = false
  const { driver } = fakeDriver([])
  const spy: ActDriver = { ...driver, evaluate: async () => { evaluated = true; return '[]' } }
  const r = await act(spy, { instruction: '输入用户名输入框' })
  assert.equal(r.isError, true)
  assert.match(r.content, /value/)
  assert.equal(evaluated, false, '参数不全应在碰页面之前就返回')
})

test('act 缺 instruction 时报错', async () => {
  const { driver } = fakeDriver([])
  const r = await act(driver, { instruction: '  ' })
  assert.equal(r.isError, true)
  assert.match(r.content, /instruction/)
})

test('act 显式 action 覆盖措辞推断', async () => {
  const { driver, calls } = fakeDriver([cand({ selector: '#row', text: '订单详情' })])
  await act(driver, { instruction: '订单详情', action: 'hover' })
  assert.deepEqual(calls.hover, ['#row'])
  assert.deepEqual(calls.click, [])
})

test('act 在 select 上选中选项', async () => {
  const { driver, calls } = fakeDriver([cand({ selector: '#city', tag: 'select', ariaLabel: '城市' })])
  const r = await act(driver, { instruction: '选择城市下拉框', value: '杭州' })
  assert.equal(r.isError, undefined)
  assert.deepEqual(calls.select, [['#city', '杭州']])
})

test('act 面对空页面返回未命中而不是抛异常', async () => {
  const { driver } = fakeDriver([])
  const r = await act(driver, { instruction: '点击登录按钮' })
  assert.equal(r.isError, true)
  assert.match(r.content, /没有找到/)
})

// ── extract ─────────────────────────────────────────────────

test('extract 把 schema 与页面文本一并交回，并声明不做解析', async () => {
  const { driver } = fakeDriver([], '商品A 12元\n商品B 30元')
  const r = await extract(driver, { schema: '所有商品名和价格' })
  assert.equal(r.isError, undefined)
  assert.match(r.content, /所有商品名和价格/)
  assert.match(r.content, /商品A 12元/)
  assert.match(r.content, /不做解析/, '必须如实说明解析由模型完成')
})

test('extract 空文本给可诊断的提示而不是空结果', async () => {
  const { driver } = fakeDriver([], '   ')
  const r = await extract(driver, { schema: '价格' })
  assert.equal(r.isError, true)
  assert.match(r.content, /iframe|渲染/)
})

test('extract 超长文本截断并标记 lossiness', async () => {
  const { driver } = fakeDriver([], 'x'.repeat(20_000))
  const r = await extract(driver, { schema: '正文' })
  assert.equal(r.lossiness, 'truncated')
  assert.match(r.content, /已截断/)
})

test('extract 缺 schema 时报错', async () => {
  const { driver } = fakeDriver([])
  const r = await extract(driver, { schema: '' })
  assert.equal(r.isError, true)
  assert.match(r.content, /schema/)
})

// ── observe ─────────────────────────────────────────────────

test('observe 回问题 + 带 selector 的元素清单 + 页面文本', async () => {
  const { driver } = fakeDriver([cand({ selector: '#err', text: '密码错误' })], '登录失败')
  const r = await observe(driver, { question: '有没有错误提示' })
  assert.match(r.content, /有没有错误提示/)
  assert.match(r.content, /#err/)
  assert.match(r.content, /登录失败/)
})

test('observe 的元素清单不带匹配分数（纯列举时分数是噪声）', async () => {
  const { driver } = fakeDriver([cand({ selector: '#a', text: '确定' })])
  const r = await observe(driver, { question: '页面上有什么按钮' })
  assert.doesNotMatch(r.content, /~0\.00/)
})

test('observe 过滤不可见元素', async () => {
  const { driver } = fakeDriver([
    cand({ selector: '#shown', text: '可见按钮' }),
    cand({ selector: '#hidden', text: '隐藏按钮', visible: false }),
  ])
  const r = await observe(driver, { question: '有哪些按钮' })
  assert.match(r.content, /#shown/)
  assert.doesNotMatch(r.content, /#hidden/)
})

test('observe 缺 question 时报错', async () => {
  const { driver } = fakeDriver([])
  const r = await observe(driver, { question: '' })
  assert.equal(r.isError, true)
  assert.match(r.content, /question/)
})
