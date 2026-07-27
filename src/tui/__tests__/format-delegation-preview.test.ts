import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCard } from '../format/tool-card.js'
import { getTheme } from '../theme.js'

function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') }

const theme = getTheme()

// ── Streaming delegation preview: tasks[] visible during arg streaming ──
//
// 入参形状必须与 `delegate-batch.ts` 的 schema 一致：任务对象只有 `objective`
// （required），没有 `id`、没有 `description`；工具级也没有 `agent` / `context`。
// 这份测试原本整份照搬 pi 的 `renderTaskItemLines` 形状（`{agent, tasks:[{id,
// description}]}`），与渲染实现的错误假设一致，于是双方互相背书：预览在生产里
// 从来只画得出 `• #1 • #2`，逐次一模一样、与真实任务毫无关系，而测试全绿。
// 断言写成对着 schema 的字段，才挡得住这类字段名漂移。

test('formatToolCard: delegate_batch streaming shows task items from toolInput', () => {
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      tasks: [
        { objective: 'Load auth module' },
        { objective: 'Run DB migration' },
      ],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.toLowerCase().includes('delegat') || plain.toLowerCase().includes('batch'), 'header shows delegation verb')
  assert.ok(plain.includes('Load auth module'), 'task 1 objective visible during streaming')
  assert.ok(plain.includes('Run DB migration'), 'task 2 objective visible during streaming')
})

test('formatToolCard: delegate_batch streaming numbers each task', () => {
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: { tasks: [{ objective: 'Scan for vulnerabilities' }] },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('Scan for vulnerabilities'), 'task objective visible')
  // 编号是本地派生的（schema 无 id），用户靠它知道派了几个。
  assert.ok(plain.includes('#1'), 'task numbered')
})

test('formatToolCard: delegate_batch streaming handles partial tasks array (mid-stream)', () => {
  // During streaming, tasks[] may be partially parsed or have undefined fields
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      tasks: [
        { objective: 'First task' },
        { objective: '' }, // partial/garbage entry mid-stream
      ],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('First task'), 'first task objective visible')
  assert.ok(!plain.includes('undefined'), 'partial entry must not leak undefined')
  assert.ok(lines.length > 0, 'does not crash on partial entries')
})

test('formatToolCard: delegate_batch non-streaming (result) does NOT show task preview', () => {
  // When not streaming (result has arrived), the preview is redundant —
  // the worker fleet panel shows live status instead.
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: 'Dispatched 2 workers',
    streaming: false,
    toolInput: {
      tasks: [{ objective: 'Should not appear in preview' }],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(!plain.includes('Should not appear in preview'), 'no task preview when not streaming')
})

test('formatToolCard: delegate_task (single) streaming shows objective preview', () => {
  const lines = formatToolCard({
    toolName: 'delegate_task',
    content: '',
    streaming: true,
    toolInput: {
      objective: 'Explore the auth module and report back',
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('Explore the auth module'), 'objective visible during streaming')
})

test('formatToolCard: delegate_batch with empty tasks shows waiting indicator', () => {
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: {
      tasks: [],
    },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  // Should show a "waiting for tasks..." hint, not crash
  assert.ok(lines.length > 0, 'renders without crash')
  assert.ok(plain.includes('…') || plain.includes('等待') || plain.includes('waiting'), 'shows waiting indicator')
})

test('formatToolCard: delegate_batch large batch truncated with count', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ objective: `Task ${i + 1}` }))
  const lines = formatToolCard({
    toolName: 'delegate_batch',
    content: '',
    streaming: true,
    toolInput: { tasks },
  }, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('Task 1'), 'first task visible')
  assert.ok(plain.includes('+') || plain.includes('more') || plain.includes('…'), 'truncation indicator present')
  assert.ok(!plain.includes('Task 20'), '20th task truncated')
})
