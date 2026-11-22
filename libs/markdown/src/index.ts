/**
 * Markdown rendering for chat replies and documents: GFM, KaTeX math, Prism highlighting and
 * Mermaid diagrams. Domain-free: citations, scrolling and theme are supplied by the caller.
 */
export { MarkdownTheme, type CitationSource } from './context.js'
export { useHighlightedHtml } from './highlight.js'
export { ensureKatex } from './katex.js'
export { Markdown, type MarkdownProps } from './Markdown.js'
export { MermaidDiagram } from './MermaidDiagram.js'
