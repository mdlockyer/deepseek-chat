# `@deepseek-chat/lib-markdown`

Domain-free Markdown rendering for chat replies and documents. The parser (micromark / mdast),
highlighter (Prism), math (KaTeX) and diagrams (Mermaid) are third-party; this library turns the
parsed tree into React and supplies the copy buttons and diagram toggle. It knows nothing about
chats: citations, scrolling and theme come from the caller.

## API

| Export                                      | Meaning                                                          |
| :------------------------------------------ | :--------------------------------------------------------------- |
| `Markdown(props)`                           | Render a document (props below).                                 |
| `MermaidDiagram({ code, loading })`         | A diagram on its own (file preview).                             |
| `useHighlightedHtml(text, lang, maxChars?)` | Highlighted HTML; `null` past `maxChars` (show plain text then). |
| `MarkdownTheme({ dark })`                   | Provider at the app root; diagrams follow it.                    |
| `ensureKatex()`                             | Start loading KaTeX early (it loads on first use otherwise).     |

`Markdown` props: `content`, `loading` (still streaming), `cacheKey`, `className?`, `disableLink`,
`sources?` (objects with a numeric `index`), `renderCitation?(source)`, `onRendered?()`.

Strings (copy button, diagram toggle and status) are the library's own catalogue and follow the
spine locale.

## Guarantees

1. **Citations.** With `sources`, `[citation:N]` becomes `renderCitation(source N)`; a marker with no
   matching source is removed. Without `sources` the marker stays as text.
2. **Links.** Links open in a new tab with `rel="noreferrer"`; `mailto:` links open in place. A URL
   without a scheme gets `https://`. Only `http:`, `https:` and `mailto:` URLs become `href`s; any
   other link keeps its text and gets no `href`. `#anchors` render as plain text. With
   `disableLink`, links render as their text only.
3. **Images** render as a link to the image URL, never as `<img>`.
4. **Raw HTML** is shown as text, except a lone `<br>`, which breaks the line.
5. **Kept as written:** strikethrough keeps its `~` delimiters; footnotes, reference links and
   definitions show their source text.
6. **Line breaks.** Every newline in a paragraph is a visual line break.
7. **Task lists** show `☑` / `□` before the item.
8. **Tables** pad short rows with empty cells up to the header's column count.
9. **Code blocks** show the language and a copy button; known languages are highlighted, others are
   escaped plain text. A `mermaid` block shows the diagram with a Diagram/Code toggle.
10. **Math** renders with KaTeX once loaded; until then, and for a formula that fails while
    streaming, the source (or the last good rendering) is shown.
11. **Diagrams.** While streaming, a failing diagram keeps the last good drawing; after streaming it
    shows the failure message. An empty diagram says so.
