import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocale } from '@deepseek-chat/spine/i18n'
import {
  ensureKatex,
  Markdown,
  MermaidDiagram,
  useHighlightedHtml,
  type CitationSource,
} from '@deepseek-chat/lib-markdown'

type Source = CitationSource & { url: string }

const render = (
  content: string,
  options: {
    disableLink?: boolean
    sources?: Source[]
    renderCitation?: (source: Source) => ReactNode
  } = {}
) =>
  renderToStaticMarkup(
    createElement(Markdown<Source>, {
      content,
      loading: false,
      cacheKey: 'k',
      disableLink: options.disableLink ?? false,
      sources: options.sources,
      renderCitation: options.renderCitation,
    })
  )

/** Strips tags, to compare visible text. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '')

describe('markdown: citations', () => {
  const sources: Source[] = [{ index: 1, url: 'https://one.example/' }]
  const renderCitation = (source: Source) =>
    createElement('sup', { 'data-cite': source.url }, source.index)

  it('renders a known citation through renderCitation and removes unknown ones without dangling spaces', () => {
    const html = render('See [citation:1] and [citation:9].', { sources, renderCitation })
    assert.match(html, /<sup data-cite="https:\/\/one\.example\/">1<\/sup>/)
    assert.doesNotMatch(html, /citation:9/)
    assert.equal(textOf(html), 'See 1 and.')

    // Unmatched citations before punctuation, back-to-back, or between words never leave extra spaces.
    assert.equal(
      textOf(render('Total is 1.127 billion shares [citation:9].', { sources, renderCitation })),
      'Total is 1.127 billion shares.'
    )
    assert.equal(
      textOf(render('Claim [citation:8] [citation:9], next clause.', { sources, renderCitation })),
      'Claim, next clause.'
    )
    assert.equal(
      textOf(render('Alpha [citation:9] beta.', { sources, renderCitation })),
      'Alpha beta.'
    )
  })

  it('leaves markers as text when no sources are given', () => {
    assert.equal(textOf(render('See [citation:1].')), 'See [citation:1].')
  })
})

describe('markdown: links and images', () => {
  it('opens web links in a new tab and mailto links in place', () => {
    assert.match(
      render('[docs](https://a.example/x)'),
      /<a href="https:\/\/a\.example\/x" target="_blank" rel="noreferrer"><span>docs<\/span><\/a>/
    )
    assert.match(
      render('[mail](mailto:me@a.example)'),
      /<a href="mailto:me@a\.example"><span>mail<\/span><\/a>/
    )
  })

  it('adds https:// to scheme-less URLs and drops the href of other schemes', () => {
    assert.match(render('[site](a.example)'), /href="https:\/\/a\.example\/"/)
    const unsafe = render('[x](javascript:alert(1))')
    assert.match(unsafe, /<a[^>]*><span>x<\/span><\/a>/)
    assert.doesNotMatch(unsafe, /href=/)
    const ftp = render('[f](ftp://a.example/file)')
    assert.doesNotMatch(ftp, /href=/)
  })

  it('renders anchors and disabled links as their text only', () => {
    assert.equal(
      render('[top](#top)'),
      '<div class="ds-markdown"><p class="ds-markdown-paragraph"><span>top</span></p></div>'
    )
    const disabled = render('[docs](https://a.example/)', { disableLink: true })
    assert.doesNotMatch(disabled, /<a /)
    assert.equal(textOf(disabled), 'docs')
  })

  it('shows images as a link to the image, never as <img>', () => {
    const html = render('![chart](https://a.example/c.png)')
    assert.doesNotMatch(html, /<img/)
    assert.match(
      html,
      /<a href="https:\/\/a\.example\/c\.png"[^>]*>https:\/\/a\.example\/c\.png<\/a>/
    )
  })
})

describe('markdown: text that is kept as written', () => {
  it('shows raw HTML as text, except a lone <br>', () => {
    const html = render('a <b>bold</b> b')
    assert.doesNotMatch(html, /<b>/)
    assert.match(html, /&lt;b&gt;/)
    assert.match(render('a<br>b'), /<span>a<\/span><br\/><span>b<\/span>/)
  })

  it('keeps strikethrough delimiters and footnote sources', () => {
    assert.equal(textOf(render('~~gone~~ and ~kept~')), '~~gone~~ and ~kept~')
    assert.match(
      textOf(render('Text[^1]\n\n[^1]: The note.')),
      /Text\[\^1\][\s\S]*\[\^1\]: The note\./
    )
  })

  it('renders each newline in a paragraph as a line break', () => {
    assert.match(render('one\ntwo'), /<span>one<\/span><br\/><span>two<\/span>/)
  })
})

describe('markdown: lists and tables', () => {
  it('marks task items with ☑ and □', () => {
    const html = render('- [x] done\n- [ ] todo\n- plain')
    assert.match(html, /☑[\s\S]*done/)
    assert.match(html, /□[\s\S]*todo/)
    assert.equal((html.match(/ds-markdown-task-checkbox/g) ?? []).length, 2)
  })

  it('pads short table rows to the header column count', () => {
    const html = render('| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 |')
    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []
    // Header + two body rows; every body row has three cells.
    assert.equal(rows.length, 3)
    for (const row of rows.slice(1)) {
      assert.equal((row.match(/<td/g) ?? []).length, 3)
    }
  })
})

describe('markdown: code, math and diagrams', () => {
  it('highlights known languages, escapes others, and labels the copy button per locale', () => {
    setLocale('en-US')
    const js = render('```js\nconst x = "<b>"\n```')
    assert.match(js, /class="token keyword">const</)
    assert.match(js, />js</)
    assert.match(js, /<span>Copy<\/span>/)

    const plain = render('```weird\n<b>hi</b>\n```')
    // Prism escapes "<" (and "&"); a lone ">" cannot open a tag.
    assert.match(plain, /<pre>&lt;b>hi&lt;\/b>\n?<\/pre>/)
    assert.doesNotMatch(plain, /class="token/)

    setLocale('zh-CN')
    assert.match(render('```js\n1\n```'), /<span>复制<\/span>/)
    setLocale('en-US')
  })

  it('shows mermaid blocks as a diagram with a Diagram/Code toggle', () => {
    setLocale('en-US')
    const html = render('```mermaid\ngraph TD; A-->B\n```')
    assert.match(html, /aria-pressed="true"[^>]*>Diagram</)
    assert.match(html, /aria-pressed="false"[^>]*>Code</)
    assert.match(html, /role="status">Rendering diagram\.\.\.</)
  })

  it('says when a diagram is empty', () => {
    setLocale('en-US')
    const html = renderToStaticMarkup(createElement(MermaidDiagram, { code: '  ', loading: false }))
    assert.match(html, />This diagram is empty\.</)
  })

  it('shows math source until KaTeX loads, then renders it', async () => {
    // Nothing in this file loads KaTeX earlier, so the first render starts the load.
    const before = render('$x^2$')
    assert.doesNotMatch(before, /class="katex"/)
    assert.match(before, /x\^2/)
    await ensureKatex()
    const after = render('$x^2$')
    assert.match(after, /class="katex"/)
    assert.doesNotMatch(textOf(after), /\$/)
  })

  it('keeps currency dollar amounts as prose while still rendering valid inline and display math', async () => {
    await ensureKatex()

    // Exact regression from multi-currency financial prose with bold spans.
    const ipo =
      'Anthropic priced its IPO at **$83 a share** on Nov 18, above its $70–78 roadshow range, ' +
      'selling 980 million shares and raising roughly **$81 billion**—the largest listing on record. ' +
      'Shares closed their first day at $97.17, up 17%, putting the company around a ' +
      '**$1.3 trillion valuation**. A concurrent private placement added about $26 billion.'
    const ipoHtml = render(ipo)
    assert.doesNotMatch(ipoHtml, /class="katex"/)
    assert.match(ipoHtml, /<strong><span>\$83 a share<\/span><\/strong>/)
    assert.match(ipoHtml, /<strong><span>\$81 billion<\/span><\/strong>/)
    assert.match(ipoHtml, /<strong><span>\$1\.3 trillion valuation<\/span><\/strong>/)
    assert.ok(textOf(ipoHtml).includes('$70–78'))
    assert.ok(textOf(ipoHtml).includes('$97.17'))
    assert.ok(textOf(ipoHtml).includes('$26 billion'))

    // Compact currency ranges without spaces stay literal prose.
    const ranges = render('Ranges ($10-$20) and $500–$1,000 stay literal.')
    assert.doesNotMatch(ranges, /class="katex"/)
    assert.equal(textOf(ranges), 'Ranges ($10-$20) and $500–$1,000 stay literal.')

    // Currency followed by valid inline math or display math in the same sentence.
    const mixed = render('The GPU costs $500 and achieves $O(n^2)$ throughput.')
    assert.match(mixed, /\$500/)
    assert.match(mixed, /class="katex"/)

    const mixedBlock = render('Costs $50, see $$x^2 + 1$$.')
    assert.match(mixedBlock, /\$50/)
    assert.match(mixedBlock, /class="katex"/)

    // Bilingual CJK prose adjacent to single-dollar math and escaped \$ inside math.
    const cjk = render('设$x=1$，其中$x$为整数。')
    assert.equal((cjk.match(/class="katex"/g) ?? []).length, 2)

    const escaped = render('$\\$5 + \\$10 = \\$15$')
    assert.match(escaped, /class="katex"/)
  })
})

describe('markdown: highlight hook', () => {
  const Probe = ({ text, max }: { text: string; max?: number }) => {
    const html = useHighlightedHtml(text, 'js', max)
    return createElement('out', null, html === null ? 'NULL' : html)
  }

  it('returns null past maxChars and HTML up to it', () => {
    // 'abcde' is 5 characters.
    assert.equal(
      renderToStaticMarkup(createElement(Probe, { text: 'abcde', max: 4 })),
      '<out>NULL</out>'
    )
    assert.notEqual(
      renderToStaticMarkup(createElement(Probe, { text: 'abcde', max: 5 })),
      '<out>NULL</out>'
    )
  })
})
