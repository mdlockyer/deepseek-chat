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

  it('renders a known citation through renderCitation and removes unknown ones', () => {
    const html = render('See [citation:1] and [citation:9].', { sources, renderCitation })
    assert.match(html, /<sup data-cite="https:\/\/one\.example\/">1<\/sup>/)
    assert.doesNotMatch(html, /citation:9/)
    assert.equal(textOf(html), 'See 1 and .')
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
