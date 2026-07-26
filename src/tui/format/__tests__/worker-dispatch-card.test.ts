import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { getTheme } from '../../theme.js'
import { formatWorkerDispatchCard, formatScopeSummary, wrapByDisplayWidth } from '../worker-dispatch-card.js'
import type { ContractProjection } from '../../../agent/contract-projection.js'

const theme = getTheme(0)

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

function contract(over: Partial<ContractProjection> = {}): ContractProjection {
  return {
    objective: '定位 /tasks 舰队行的渲染函数与列宽计算',
    profile: 'code_scout',
    scope: {},
    constraints: [],
    budget: { maxTurns: 12, timeoutMs: 300_000 },
    allowedToolsDigest: 'glob,grep,read_file +4',
    ...over,
  }
}

describe('formatWorkerDispatchCard', () => {
  it('首行给出 worker 短标签、星域与角色', () => {
    const text = stripAnsi(
      formatWorkerDispatchCard(contract({ authority: 'tianxuan' }), 'wo_team:T1', { columns: 80, theme }).join('\n'),
    )
    assert.ok(text.includes('派发 T1'), '短标签可与 /tasks 行对应')
    assert.ok(text.includes('天璇'), '星域按星名渲染')
  })

  it('目标整段渲染，不截成一行', () => {
    const long = '在 src/tui/format/ 下定位 /tasks 舰队行的渲染函数与列宽计算，并确认窄屏降级策略的实际实现位置'
    const lines = formatWorkerDispatchCard(contract({ objective: long }), 'wo_1', { columns: 60, theme })
    const text = stripAnsi(lines.join(''))
    assert.ok(text.includes('窄屏降级策略'), '尾部内容未被丢弃')
    assert.ok(lines.length > 2, '长目标应折行而不是截断')
  })

  it('有 scope 时给出范围行（files 取 basename）', () => {
    const text = stripAnsi(formatWorkerDispatchCard(
      contract({ scope: { files: ['src/tui/format/overlay.ts', 'src/tui/fleet-registry.ts'] } }),
      'wo_1',
      { columns: 80, theme },
    ).join('\n'))
    assert.ok(text.includes('范围'))
    assert.ok(text.includes('overlay.ts'))
    assert.ok(!text.includes('src/tui/format/overlay.ts'), '全路径不进卡片')
  })

  it('无 scope 时整行省略，不留空标签', () => {
    const text = stripAnsi(formatWorkerDispatchCard(contract(), 'wo_1', { columns: 80, theme }).join('\n'))
    assert.ok(!text.includes('范围'))
  })

  // 这条是本卡片的设计约束，不是实现细节：机械参数回答不了「他要去干什么」，
  // 加回来等于让卡片重新变成噪音。改动前先读 worker-dispatch-card.ts 顶部注释。
  it('不泄露轮次预算、超时与工具白名单', () => {
    const text = stripAnsi(formatWorkerDispatchCard(
      contract({ authority: 'tianxuan', authorityReason: '显式指定' }),
      'wo_1',
      { columns: 80, theme },
    ).join('\n'))
    assert.ok(!text.includes('12'), 'maxTurns 不出现')
    assert.ok(!/turn|timeout|300/i.test(text), '预算/超时不出现')
    assert.ok(!text.includes('read_file'), 'allowedToolsDigest 不出现')
    assert.ok(!text.includes('显式指定'), 'authorityReason 是噪音，不进卡片')
  })

  it('每行不超过终端宽度（窄屏 CJK）', () => {
    const long = '在 src/tui/format/ 下定位舰队行的渲染函数与列宽计算，确认窄屏降级策略的实际实现位置'
    const width = 40
    const lines = formatWorkerDispatchCard(
      contract({ objective: long, scope: { files: ['a/very/long/path/to/overlay.ts'], symbols: ['renderTasks'] } }),
      'wo_1',
      { columns: width, theme },
    )
    for (const line of lines) {
      assert.ok(stringWidth(line) <= width, `line overflows ${width}: ${JSON.stringify(stripAnsi(line))}`)
    }
  })

  it('清洗控制字符——objective 是模型自由文本，不能带 ESC 进 scrollback', () => {
    const text = formatWorkerDispatchCard(
      contract({ objective: 'before\u001B[31mred\u001B[0m\tafter' }),
      'wo_1',
      { columns: 80, theme },
    ).join('\n')
    assert.ok(!text.includes('[31m'), '模型注入的 SGR 整段剥掉，不留 "[31m" 残渣')
    assert.ok(stripAnsi(text).includes('beforered after'), 'ESC 序列消失、制表符归一为空格，正文保留')
  })
})

describe('formatScopeSummary', () => {
  it('超过 4 项折成 +N', () => {
    const out = formatScopeSummary({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] })
    assert.ok(out?.endsWith('+2'), `got ${out}`)
  })

  it('files 与 symbols 合并去重', () => {
    const out = formatScopeSummary({ files: ['src/a.ts'], symbols: ['a.ts', 'renderTasks'] })
    assert.equal(out, 'a.ts · renderTasks')
  })

  it('空 scope 与 undefined 都返回 undefined', () => {
    assert.equal(formatScopeSummary({}), undefined)
    assert.equal(formatScopeSummary(undefined), undefined)
    assert.equal(formatScopeSummary({ files: [], symbols: [] }), undefined)
  })
})

describe('wrapByDisplayWidth', () => {
  it('按显示宽度折行，CJK 不撑破', () => {
    const lines = wrapByDisplayWidth('天枢天璇天玑天权玉衡开阳瑶光', 8)
    for (const l of lines) assert.ok(stringWidth(l) <= 8)
    assert.equal(lines.join(''), '天枢天璇天玑天权玉衡开阳瑶光')
  })

  it('西文优先在空格处断行', () => {
    const lines = wrapByDisplayWidth('alpha beta gamma delta', 12)
    assert.ok(lines.every(l => !l.startsWith(' ') && !l.endsWith(' ')))
    assert.ok(lines[0]!.includes('alpha'))
  })

  it('超过 maxLines 时末行省略号收尾', () => {
    const lines = wrapByDisplayWidth('天枢天璇天玑天权玉衡开阳瑶光天枢天璇', 6, 2)
    assert.equal(lines.length, 2)
    assert.ok(lines[1]!.endsWith('…'))
  })
})
