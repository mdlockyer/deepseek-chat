import { useEffect, useMemo, useReducer } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../../services/markdown/highlight.js'
import { getCodeLanguage } from '../../../services/preview/fileKinds.js'
import styles from '../PreviewPanel.module.css'
import '../../markdown/highlight.css'

const MAX_HIGHLIGHT_CHARS = 300_000

/** 代码/文本源码预览：复用 Prism 按需语言包，默认自动换行 */
export const CodePreview = ({
  text,
  name,
  mimeType,
}: {
  text: string
  name: string
  mimeType: string
}) => {
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const langName = getCodeLanguage(name, mimeType)
  const lang = getHighlightLang(langName)
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

  const highlightedHtml = useMemo(() => {
    if (text.length > MAX_HIGHLIGHT_CHARS) {
      return null
    }
    const target = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(text, Prism.languages[target], target)
  }, [text, lang, loaded])

  return (
    <div className={styles.scrollPane}>
      <div className={styles.codeWrap}>
        {highlightedHtml !== null ? (
          <pre className={styles.codePre} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        ) : (
          <pre className={styles.codePre}>{text}</pre>
        )}
      </div>
    </div>
  )
}
