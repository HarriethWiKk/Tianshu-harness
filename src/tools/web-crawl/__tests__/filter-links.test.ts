import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterLink, getUrlDepth } from '../filter-links.js'

const BASE = {
  seedHost: 'ex.com',
  seedPath: '/docs/guide',
  seedDepth: 2,
  maxDepth: 2,
}

function filter(rawUrl: string, opts: Partial<typeof BASE> & { includePaths?: RegExp[]; excludePaths?: RegExp[]; allowBackward?: boolean } = {}) {
  return filterLink(new URL(rawUrl), { ...BASE, ...opts })
}

describe('getUrlDepth', () => {
  it('按 pathname 段数计深', () => {
    assert.equal(getUrlDepth('/'), 0)
    assert.equal(getUrlDepth('/docs'), 1)
    assert.equal(getUrlDepth('/docs/guide/intro'), 3)
    assert.equal(getUrlDepth('/a//b/'), 2)
  })
})

describe('filterLink 过滤链', () => {
  it('非 http(s) → non_http', () => {
    assert.equal(filter('ftp://ex.com/x'), 'non_http')
  })

  it('跨域名 → cross_domain（含子域）', () => {
    assert.equal(filter('https://other.com/docs/guide/x'), 'cross_domain')
    assert.equal(filter('https://sub.ex.com/docs/guide/x'), 'cross_domain')
  })

  it('二进制/媒体扩展名 → file_extension', () => {
    assert.equal(filter('https://ex.com/docs/guide/logo.png'), 'file_extension')
    assert.equal(filter('https://ex.com/docs/guide/spec.PDF'), 'file_extension')
    assert.equal(filter('https://ex.com/docs/guide/pkg.zip'), 'file_extension')
    assert.equal(filter('https://ex.com/docs/guide/page'), null)
  })

  it('路径深度超限 → max_depth（上限 = 种子深度 + maxDepth）', () => {
    // 上限 = 2 + 2 = 4 段
    assert.equal(filter('https://ex.com/docs/guide/a/b'), null) // 4 段
    assert.equal(filter('https://ex.com/docs/guide/a/b/c'), 'max_depth') // 5 段
  })

  it('excludePaths 优先于 includePaths', () => {
    const opts = { includePaths: [/^\/docs/], excludePaths: [/\/internal/] }
    assert.equal(filter('https://ex.com/docs/guide/internal/x', opts), 'excluded_path')
    assert.equal(filter('https://ex.com/docs/guide/public/x', opts), null)
  })

  it('有 includePaths 未命中 → not_included_path', () => {
    const opts = { seedPath: '/', seedDepth: 0, maxDepth: 5, includePaths: [/^\/docs\/api/] }
    assert.equal(filter('https://ex.com/docs/guide/x', opts), 'not_included_path')
    assert.equal(filter('https://ex.com/docs/api/x', opts), null)
  })

  it('backward：须在种子路径之下；allowBackward 豁免', () => {
    assert.equal(filter('https://ex.com/docs/guide/sub'), null)
    assert.equal(filter('https://ex.com/docs/other'), 'backward_path')
    assert.equal(filter('https://ex.com/other'), 'backward_path')
    assert.equal(filter('https://ex.com/docs/other', { allowBackward: true }), null)
  })

  it('种子为根路径时 backward 不拦截', () => {
    assert.equal(filter('https://ex.com/anything/here', { seedPath: '/', seedDepth: 0 }), null)
  })

  it('过滤顺序：扩展名先于深度/路径规则', () => {
    // 即使命中 includePaths，png 仍被拒
    const opts = { includePaths: [/^\/docs/] }
    assert.equal(filter('https://ex.com/docs/guide/x.png', opts), 'file_extension')
  })
})
