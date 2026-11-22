import { useWorkspace } from '../context.js'
import { getCodeLanguage } from '../fileKinds.js'
import styles from '../PreviewPanel.module.css'

/** 代码/文本源码预览：高亮由应用按需加载语言包，默认自动换行 */
export const CodePreview = ({
  text,
  name,
  mimeType,
}: {
  text: string
  name: string
  mimeType: string
}) => {
  const highlightedHtml = useWorkspace().views.useHighlight(text, getCodeLanguage(name, mimeType))
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
