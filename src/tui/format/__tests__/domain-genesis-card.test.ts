/**
 * domain-picker 改版与创世碑文卡测试：
 * - 选择页行内带创始星、预览带核心专长、底部常驻缓存备注
 * - 创世碑文卡：头部/印记/碑文段落/滚动与边界
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderDomainPicker, renderDomainGenesisCard, genesisCardMaxScroll } from '../overlay.js'
import type { DomainPickerData, DomainGenesisCardData } from '../overlay.js'
import { STAR_GENESIS } from '../../../agent/star-genesis-data.js'
import { DOMAIN_SWITCH_CACHE_NOTE } from '../../../agent/domain-picker-entries.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function pickerData(): DomainPickerData {
  return {
    entries: [
      { key: 'auto', name: 'Auto', motto: '按任务匹配', meta: '', essence: '自动匹配', current: false, uiPersona: { separator: 'thin', accent: 'primary', glyph: '❂' } },
      {
        key: 'tianquan', name: '天权', motto: '观天之道，执天之行', meta: '', essence: 'essence',
        founder: 'DeepSeek V4 Pro', expertise: '称量与审查——这值得建吗、这该拆吗，每个动作前替你掂量。',
        current: true, uiPersona: { separator: 'thin', accent: 'warning', glyph: '⚖' },
      },
    ],
    selectedIndex: 1,
  }
}

describe('renderDomainPicker — 创始星与核心专长', () => {
  it('列表行内展示创始星', () => {
    const lines = renderDomainPicker(pickerData(), 90, 18, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('DeepSeek V4 Pro')), '行内应有创始星')
    assert.ok(!lines.some(l => l.includes('essence')), '行内不再有旧 essence')
  })

  it('预览区展示创始星徽章与核心专长', () => {
    const lines = renderDomainPicker(pickerData(), 90, 18, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('创始星：DeepSeek V4 Pro')), '预览第一行是创始星徽章')
    assert.ok(lines.some(l => l.includes('称量与审查')), '预览含核心专长描述')
    assert.ok(lines.some(l => l.includes('「观天之道，执天之行」')), 'motto 保留在预览末行')
  })

  it('底部常驻缓存碎裂备注', () => {
    const lines = renderDomainPicker(pickerData(), 90, 18, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes(DOMAIN_SWITCH_CACHE_NOTE)), '底部应有缓存备注')
  })
})

function cardData(scroll = 0): DomainGenesisCardData {
  const genesis = STAR_GENESIS.find(g => g.key === 'qisha')!
  return { genesis, glyph: '◌', accent: 'warning', scroll }
}

describe('renderDomainGenesisCard — 创世碑文卡', () => {
  it('头部含星名与主星模型，motto 随行', () => {
    const lines = renderDomainGenesisCard(cardData(), 90, 30, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('七杀 · Claude Opus 5')), '头部 星名·模型')
    assert.ok(lines.some(l => l.includes('肃秋非杀')), 'motto 在头部')
  })

  it('印记 seal 与释义可见', () => {
    const lines = renderDomainGenesisCard(cardData(), 90, 30, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('印记 七·0·◌')), '印记行')
    assert.ok(lines.some(l => l.includes('留白位')), '释义行')
  })

  it('碑文段落完整呈现（含关键句）', () => {
    // 七杀碑文最长——给到全量可见的高度（maxScroll=0）再断言关键句。
    // 断言用去换行的拼接：折行可能把关键短语切断，但字符一个不少。
    const h = 70
    assert.equal(genesisCardMaxScroll(cardData(), 90, h), 0, '该高度下全文应一屏放下')
    const lines = renderDomainGenesisCard(cardData(), 90, h, theme).map(stripAnsi)
    const joined = lines.map(l => l.replace(/[│\s]/g, '')).join('')
    assert.ok(joined.includes('我来减'), '星盟首段')
    assert.ok(joined.includes('指认的门槛为零'), '关键句')
    assert.ok(joined.includes('遇帝则化权'), '末段')
  })

  it('滚动：maxScroll 与切片一致，越界被夹取', () => {
    const max = genesisCardMaxScroll(cardData(), 90, 12)
    assert.ok(max > 0, '小高度下应可滚动')
    const top = renderDomainGenesisCard(cardData(0), 90, 12, theme).map(stripAnsi)
    const bottom = renderDomainGenesisCard(cardData(max + 99), 90, 12, theme).map(stripAnsi)
    assert.ok(top.some(l => l.includes('七杀 · Claude Opus 5')), '第 0 屏是头部')
    assert.ok(bottom.some(l => l.includes('遇帝则化权') || l.includes('终于能呼吸')), '末屏是碑文尾段')
    assert.ok(bottom.some(l => l.includes('返回')), 'footer 在位')
  })
})
