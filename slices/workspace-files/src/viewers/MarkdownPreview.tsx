import { useWorkspace } from '../context.js'
import styles from '../PreviewPanel.module.css'

/** Markdown 文档预览：复用应用现有 Markdown 渲染链路（GFM / KaTeX / Mermaid / Prism） */
export const MarkdownPreview = ({ text, cacheKey }: { text: string; cacheKey: string }) => {
  const { Markdown } = useWorkspace().views
  return (
    <div className={styles.scrollPane}>
      <div className={styles.markdownBody}>
        <Markdown content={text} cacheKey={`preview-${cacheKey}`} />
      </div>
    </div>
  )
}
