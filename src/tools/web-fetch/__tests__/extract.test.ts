import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToMarkdown, htmlToMarkdownSmart, decodeBody, extractMainContent } from '../extract.js'

describe('htmlToMarkdown (turndown)', () => {
  it('strips HTML tags and preserves text', async () => {
    const result = await htmlToMarkdown('<p>Hello <strong>world</strong></p>')
    assert.ok(result.includes('Hello'))
    assert.ok(!result.includes('<p>'))
    assert.ok(result.includes('**world**'))
  })

  it('converts links to markdown format', async () => {
    const result = await htmlToMarkdown('<a href="https://example.com">link</a>')
    assert.ok(result.includes('[link](https://example.com)'))
  })

  it('handles empty input', async () => {
    assert.equal(await htmlToMarkdown(''), '')
  })

  it('converts headings', async () => {
    const result = await htmlToMarkdown('<h1>Title</h1>')
    assert.ok(result.includes('# Title'))
  })

  it('converts unordered lists', async () => {
    const result = await htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    assert.ok(result.includes('one'))
    assert.ok(result.includes('two'))
  })

  it('converts code blocks', async () => {
    const result = await htmlToMarkdown('<pre><code>const x = 1</code></pre>')
    assert.ok(result.includes('const x = 1'))
  })

  it('strips script and style tags', async () => {
    const result = await htmlToMarkdown('<script>alert("xss")</script><p>visible</p><style>.x{color:red}</style>')
    assert.ok(!result.includes('alert'))
    assert.ok(!result.includes('color'))
    assert.ok(result.includes('visible'))
  })

  it('converts tables to readable text', async () => {
    const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>bar</td></tr></table>'
    const result = await htmlToMarkdown(html)
    assert.ok(result.includes('Name'))
    assert.ok(result.includes('foo'))
  })

  it('decodes HTML entities', async () => {
    const result = await htmlToMarkdown('<p>a &amp; b</p>')
    assert.ok(result.includes('a & b'))
  })
})

describe('decodeBody', () => {
  it('decodes UTF-8 by default', () => {
    const bytes = new TextEncoder().encode('hello 世界')
    assert.equal(decodeBody(bytes, 'text/plain'), 'hello 世界')
  })

  it('uses charset from content-type header', () => {
    // shift_jis encoded hiragana 'あ' (0x82 0xA0)
    const bytes = new Uint8Array([0x82, 0xa0])
    assert.equal(decodeBody(bytes, 'text/html; charset=shift_jis'), 'あ')
  })

  it('sniffs meta charset for HTML without header', () => {
    const enc = new TextEncoder()
    const prefix = enc.encode('<html><head><meta charset="shift_jis"></head><body>')
    const suffix = enc.encode('</body></html>')
    const bodyChar = new Uint8Array([0x82, 0xa0])
    const bytes = new Uint8Array(prefix.length + bodyChar.length + suffix.length)
    bytes.set(prefix, 0)
    bytes.set(bodyChar, prefix.length)
    bytes.set(suffix, prefix.length + bodyChar.length)
    assert.equal(decodeBody(bytes, 'text/html').includes('あ'), true)
  })
})

describe('extractMainContent', () => {
  it('prefers <main> region', () => {
    const html = '<nav>noise</nav><main><p>important</p></main><footer>more noise</footer>'
    const result = extractMainContent(html)
    assert.ok(result.includes('important'))
    assert.ok(!result.includes('noise'))
  })

  it('falls back to <article>', () => {
    const html = '<article><p>article body</p></article><aside>ignored</aside>'
    const result = extractMainContent(html)
    assert.ok(result.includes('article body'))
    assert.ok(!result.includes('ignored'))
  })

  it('strips chrome elements from full page', () => {
    const html = '<header>logo</header><p>body</p><footer>copyright</footer>'
    const result = extractMainContent(html)
    assert.ok(result.includes('body'))
    assert.ok(!result.includes('logo'))
    assert.ok(!result.includes('copyright'))
  })
})

describe('onlyMainContent 黑名单（A1）', () => {
  it('黑名单选择器内容被剔除：.navbar/.ad/.cookie 等', async () => {
    const html = '<div class="navbar">导航噪音</div><p>正文内容</p><div class="ad">广告位</div><div id="cookie">cookie条</div><aside>侧栏</aside>'
    const md = await htmlToMarkdown(html)
    assert.ok(md.includes('正文内容'))
    assert.ok(!md.includes('导航噪音'))
    assert.ok(!md.includes('广告位'))
    assert.ok(!md.includes('cookie条'))
    assert.ok(!md.includes('侧栏'))
  })

  it('forceInclude 豁免：#main 内的 .navbar 子树保留', async () => {
    const html = '<div id="main"><div class="navbar">主导航应保留</div><p>正文</p></div><div class="navbar">顶部噪音</div>'
    const md = await htmlToMarkdown(html)
    assert.ok(md.includes('主导航应保留'))
    assert.ok(!md.includes('顶部噪音'))
  })
})

describe('图片修复与链接绝对化（A3）', () => {
  it('srcset 取最大档并绝对化', async () => {
    const md = await htmlToMarkdown('<img srcset="a-100.jpg 100w, a-800.jpg 800w" alt="示意">', {
      pageUrl: 'https://ex.com/docs/',
    })
    assert.ok(md.includes('https://ex.com/docs/a-800.jpg'))
    assert.ok(md.includes('示意'))
  })

  it('无 srcset 时 data-src 懒加载回退优先于 src 占位图', async () => {
    const md = await htmlToMarkdown('<img src="placeholder.gif" data-src="real.jpg">', {
      pageUrl: 'https://ex.com/',
    })
    assert.ok(md.includes('https://ex.com/real.jpg'))
    assert.ok(!md.includes('placeholder'))
  })

  it('base64 图片替换为占位符', async () => {
    const md = await htmlToMarkdown('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg">')
    assert.ok(md.includes('<Base64-Image-Removed>'))
    assert.ok(!md.includes('iVBOR'))
  })

  it('相对链接按页面 URL 绝对化', async () => {
    const md = await htmlToMarkdown('<a href="/docs/x">文档</a><a href="y.html">下一页</a>', {
      pageUrl: 'https://ex.com/a/b',
    })
    assert.ok(md.includes('[文档](https://ex.com/docs/x)'))
    assert.ok(md.includes('[下一页](https://ex.com/a/y.html)'))
  })

  it('<base href> 优先于页面 URL', async () => {
    const md = await htmlToMarkdown(
      '<html><head><base href="https://cdn.ex.com/static/"></head><body><a href="y.html">链接</a></body></html>',
      { pageUrl: 'https://ex.com/page' },
    )
    assert.ok(md.includes('[链接](https://cdn.ex.com/static/y.html)'))
  })

  it('锚点/mailto 链接还原文本，不产生链接语法', async () => {
    const md = await htmlToMarkdown('<a href="#sec">节内</a> <a href="mailto:a@b.c">邮件</a>')
    assert.ok(md.includes('节内'))
    assert.ok(!md.includes(']('))
  })
})

describe('markdown 后处理（A4）', () => {
  it('链接文本内换行被转义（防多行链接断裂）', async () => {
    const md = await htmlToMarkdown('<a href="https://ex.com">多行<br>文本</a>')
    assert.ok(md.includes('[多行  \\\n文本](https://ex.com)'), `实际输出: ${JSON.stringify(md)}`)
  })

  it('代码围栏内的 [ ] 换行不误转义', async () => {
    const md = await htmlToMarkdown('<pre><code>const a = [1,\n2]</code></pre>')
    assert.ok(md.includes('[1,\n2]'))
  })

  it('skip-to-content 无障碍链接被清除', async () => {
    const md = await htmlToMarkdown('<a href="#main">Skip to content</a><p>正文</p>')
    assert.ok(!/skip to content/i.test(md))
  })

  it('3+ 连续换行折叠', async () => {
    const md = await htmlToMarkdown('<p>甲</p><p></p><p></p><p></p><p>乙</p>')
    assert.ok(!md.includes('\n\n\n'))
  })
})

describe('htmlToMarkdownSmart（提空回退）', () => {
  it('正向提取充足时直接用主内容', async () => {
    const html = `<nav>噪音</nav><main><p>${'重要内容'.repeat(100)}</p></main>`
    const md = await htmlToMarkdownSmart(html)
    assert.ok(md.includes('重要内容'))
  })

  it('正向提取过薄（< 200 字符）自动回退全量转换', async () => {
    const filler = '补充说明内容。'.repeat(40)
    const html = `<html><body><main><p>短</p></main><section>${filler}</section></body></html>`
    const md = await htmlToMarkdownSmart(html)
    // main 里只有「短」一个字会提空回退；全量转换必须带出 section 内容
    assert.ok(md.includes('补充说明内容'))
  })

  it('onlyMainContent: false 时直接全量转换', async () => {
    const html = `<main><p>主内容</p></main><section>${'其余内容'.repeat(60)}</section>`
    const md = await htmlToMarkdownSmart(html, { onlyMainContent: false })
    assert.ok(md.includes('其余内容'))
  })
})
