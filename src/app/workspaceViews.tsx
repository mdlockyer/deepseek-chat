import type { WorkspaceViews } from '@deepseek-chat/slice-workspace-files'
import Prism from 'prismjs'
import { useEffect, useMemo, useReducer } from 'react'
import { FileIcon } from '../components/files/FileIcon.js'
import { Markdown } from '../components/markdown/Markdown.js'
import { MermaidDiagram } from '../components/markdown/MermaidDiagram.js'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../services/markdown/highlight.js'
import '../components/markdown/highlight.css'

const MAX_HIGHLIGHT_CHARS = 300_000

/** Prism 按需加载语言包；超长文本不高亮 */
const useHighlight = (text: string, language: string): string | null => {
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(language)
  const loaded = lang !== null && isHighlightLoaded(lang)

  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    void loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])

  return useMemo(() => {
    if (text.length > MAX_HIGHLIGHT_CHARS) {
      return null
    }
    const target = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(text, Prism.languages[target], target)
  }, [text, lang, loaded])
}

/** workspace-files 的渲染插槽：复用应用的 Markdown / Mermaid / 文件图标 */
export const workspaceViews: WorkspaceViews = {
  Markdown: function PreviewMarkdown({ content, cacheKey }) {
    return <Markdown content={content} loading={false} cacheKey={cacheKey} disableLink={false} />
  },
  Mermaid: function PreviewMermaid({ code }) {
    return <MermaidDiagram code={code} loading={false} />
  },
  useHighlight,
  FileIcon,
}
