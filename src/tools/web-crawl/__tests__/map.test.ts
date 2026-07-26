import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterByPathPrefix, isSameOrSubDomain, MapCollector, rerankByCosine } from '../map.js'

describe('isSameOrSubDomain', () => {
  it('同域恒真；子域按开关', () => {
    assert.equal(isSameOrSubDomain('ex.com', 'ex.com', false), true)
    assert.equal(isSameOrSubDomain('sub.ex.com', 'ex.com', false), false)
    assert.equal(isSameOrSubDomain('sub.ex.com', 'ex.com', true), true)
    assert.equal(isSameOrSubDomain('notex.com', 'ex.com', true), false)
  })
})

describe('filterByPathPrefix', () => {
  it('种子非根 path 时只保留前缀之下', () => {
    assert.equal(filterByPathPrefix('https://ex.com/docs/a', '/docs'), true)
    assert.equal(filterByPathPrefix('https://ex.com/other', '/docs'), false)
    assert.equal(filterByPathPrefix('https://ex.com/anything', '/'), true)
  })
})

describe('MapCollector', () => {
  it('多源合并去重，title 保留首个非空', () => {
    const c = new MapCollector()
    c.add('https://ex.com/a', 'sitemap')
    c.add('https://ex.com/a', 'search', '标题')
    c.add('https://ex.com/a', 'page', '后到的标题')
    c.add('https://ex.com/b', 'page')
    const list = c.list()
    assert.equal(list.length, 2)
    const a = list.find((x) => x.url === 'https://ex.com/a')!
    assert.deepEqual([...a.sources].sort(), ['page', 'search', 'sitemap'])
    assert.equal(a.title, '标题')
  })
})

describe('rerankByCosine', () => {
  it('含搜索词的 URL 排前，零分保持原顺序', () => {
    const items = [
      { url: 'https://ex.com/blog/hello' },
      { url: 'https://ex.com/api/reference' },
      { url: 'https://ex.com/about' },
    ]
    const ranked = rerankByCosine(items, 'api reference')
    assert.equal(ranked[0]!.url, 'https://ex.com/api/reference')
    // 零分项保持原相对顺序
    assert.equal(ranked[1]!.url, 'https://ex.com/blog/hello')
    assert.equal(ranked[2]!.url, 'https://ex.com/about')
  })
})
