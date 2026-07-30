/**
 * cli-format 测试 — 纯文本 / ANSI 双轨验证。
 *
 * 不 mock ansi.ts，而是直接验证 formatted 字符串的结构特征：
 * - ANSI 模式下存在转义序列
 * - 纯文本模式下不含转义序列
 * - 关键信息字面量出现在输出中
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSectionHeader,
  formatKeyValue,
  formatSuccess,
  formatError,
  formatProviderCard,
  formatMcpServerRow,
  formatMcpServerList,
  type FormatOpts,
} from '../cli-format.js'

const colorOpts: FormatOpts = { useColor: true, width: 80 }
const plainOpts: FormatOpts = { useColor: false, width: 80 }

function hasAnsi(s: string): boolean {
  return s.includes('\x1B[')
}

describe('formatSectionHeader', () => {
  it('renders title surrounded by box chars', () => {
    const out = formatSectionHeader('Providers', colorOpts)
    assert.match(out, /Providers/)
    assert.ok(out.includes('─'), 'should include horizontal rule chars')
  })

  it('no ANSI when useColor=false', () => {
    const out = formatSectionHeader('Test', plainOpts)
    assert.equal(hasAnsi(out), false)
  })
})

describe('formatKeyValue', () => {
  it('renders key: value format', () => {
    const out = formatKeyValue('baseUrl', 'https://example.com', colorOpts)
    assert.match(out, /baseUrl/)
    assert.match(out, /https:\/\/example\.com/)
    assert.match(out, /:/)
  })

  it('uses ANSI when useColor=true', () => {
    const out = formatKeyValue('k', 'v', colorOpts)
    assert.ok(hasAnsi(out))
  })

  it('no ANSI when useColor=false', () => {
    const out = formatKeyValue('k', 'v', plainOpts)
    assert.equal(hasAnsi(out), false)
  })
})

describe('formatSuccess', () => {
  it('prepends check mark', () => {
    const out = formatSuccess('done', colorOpts)
    assert.match(out, /done/)
    assert.ok(out.includes('✔'))
  })

  it('no ANSI when useColor=false', () => {
    const out = formatSuccess('ok', plainOpts)
    assert.equal(hasAnsi(out), false)
    assert.ok(out.includes('ok'))
  })
})

describe('formatError', () => {
  it('prepends cross mark', () => {
    const out = formatError('fail', colorOpts)
    assert.match(out, /fail/)
    assert.ok(out.includes('✘'))
  })

  it('no ANSI when useColor=false', () => {
    const out = formatError('err', plainOpts)
    assert.equal(hasAnsi(out), false)
    assert.ok(out.includes('err'))
  })
})

describe('formatProviderCard', () => {
  const provider = {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai' as const,
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 384_000 },
      { id: 'deepseek-v4-flash', contextWindow: 128_000, maxTokens: 64_000, alias: 'flash' },
    ],
    unsupported: [],
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' as const, prefixCompletion: false },
    thinking: 'enabled' as const,
    maxTokens: 384_000,
  }

  it('shows provider name and baseUrl', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, false, colorOpts)
    assert.match(out, /deepseek/)
    assert.match(out, /https:\/\/api\.deepseek\.com/)
  })

  it('marks default provider', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, true, colorOpts)
    assert.match(out, /default/)
  })

  it('shows inline key status', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'inline', ref: '***abcd' }, false, colorOpts)
    assert.match(out, /\*\*\*abcd/)
    assert.match(out, /inline/)
  })

  it('shows env key status', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'env', ref: 'DEEPSEEK_KEY' }, false, colorOpts)
    assert.match(out, /DEEPSEEK_KEY/)
    assert.match(out, /env/)
  })

  it('shows (not set) for missing key', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, false, colorOpts)
    assert.match(out, /not set/)
  })

  it('lists model aliases', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, false, colorOpts)
    assert.match(out, /flash/)
    assert.match(out, /deepseek-v4-pro/)
  })

  it('no ANSI when useColor=false', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, false, plainOpts)
    assert.equal(hasAnsi(out), false)
  })

  it('card has top and bottom padding blank lines', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, false, plainOpts)
    const lines = out.split('\n')
    // 第 0 行：顶部边框，第 1 行应为空白 padding 行（含 box 竖线 + 空格）
    assert.ok(lines[0]!.includes('╭') || lines[0]!.includes('+'), 'first line should be top border')
    assert.match(lines[1] ?? '', /^\s*[|│]\s*$/, 'second line should be blank padding')
    // 底部 footer 前一行也应是空白 padding
    const lastContentIdx = lines.length - 2  // last elem is '' from trailing \n split
    assert.match(lines[lastContentIdx - 1] ?? '', /^\s*[|│]\s*$/, 'line before footer should be blank padding')
  })

  it('trailing newline separates cards', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'none', ref: '' }, false, plainOpts)
    assert.ok(out.endsWith('\n'), 'card should end with newline')
  })

  it('uses distinct colors for different value types', () => {
    const out = formatProviderCard('deepseek', provider, { source: 'inline', ref: '***abcd' }, false, colorOpts)
    assert.ok(hasAnsi(out), 'should have ANSI codes')
    // 收集所有前景色转义序列
    const colorCodes = [...out.matchAll(/\x1B\[(\d+)m/g)].map(m => m[1])
    // 应该出现多种不同色码（不是清一色）
    const uniqueColors = new Set(colorCodes)
    assert.ok(uniqueColors.size >= 3, `expected >=3 distinct ANSI codes, got ${uniqueColors.size}`)
  })
})

describe('formatMcpServerRow', () => {
  it('renders stdio server', () => {
    const out = formatMcpServerRow('fs', { command: 'npx', args: ['-y', '@mcp/fs'] }, colorOpts)
    assert.match(out, /fs/)
    assert.match(out, /stdio/)
    assert.match(out, /npx/)
  })

  it('renders sse server', () => {
    const out = formatMcpServerRow('ctx7', { url: 'http://localhost:3001/sse' }, colorOpts)
    assert.match(out, /ctx7/)
    assert.match(out, /sse/)
    assert.match(out, /localhost/)
  })

  it('marks disabled server', () => {
    const out = formatMcpServerRow('old', { command: 'npx', disabled: true }, colorOpts)
    assert.match(out, /disabled/)
  })

  it('no ANSI when useColor=false', () => {
    const out = formatMcpServerRow('fs', { command: 'npx' }, plainOpts)
    assert.equal(hasAnsi(out), false)
  })
})

describe('formatMcpServerList', () => {
  it('renders empty message when no servers', () => {
    const out = formatMcpServerList({}, colorOpts)
    assert.match(out, /No MCP servers/)
  })

  it('renders server entries', () => {
    const out = formatMcpServerList({
      fs: { command: 'npx' },
      ctx7: { url: 'http://localhost/sse' },
    }, colorOpts)
    assert.match(out, /fs/)
    assert.match(out, /ctx7/)
    assert.match(out, /MCP Servers/)
  })

  it('no ANSI when useColor=false', () => {
    const out = formatMcpServerList({ fs: { command: 'npx' } }, plainOpts)
    assert.equal(hasAnsi(out), false)
  })
})
