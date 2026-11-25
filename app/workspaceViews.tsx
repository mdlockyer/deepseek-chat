import { Markdown, MermaidDiagram, useHighlightedHtml } from '@deepseek-chat/lib-markdown'
import { FileGlyph, fileGlyphKindFromExt } from '@deepseek-chat/lib-ui'
import type { WorkspaceViews } from '@deepseek-chat/slice-workspace-files'

/** 超长文本不高亮 */
const MAX_HIGHLIGHT_CHARS = 300_000

/** workspace-files 的渲染插槽：复用 Markdown 库与应用的文件图标 */
export const workspaceViews: WorkspaceViews = {
  Markdown: function PreviewMarkdown({ content, cacheKey }) {
    return <Markdown content={content} loading={false} cacheKey={cacheKey} disableLink={false} />
  },
  Mermaid: function PreviewMermaid({ code }) {
    return <MermaidDiagram code={code} loading={false} />
  },
  useHighlight: (text, language) => useHighlightedHtml(text, language, MAX_HIGHLIGHT_CHARS),
  FileIcon: function WorkspaceFileIcon({ ext }) {
    return <FileGlyph kind={fileGlyphKindFromExt(ext)} />
  },
}
