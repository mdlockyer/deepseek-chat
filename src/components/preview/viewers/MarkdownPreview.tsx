import { Markdown } from '../../markdown/Markdown.js'
import styles from '../PreviewPanel.module.css'

/** Markdown 文档预览：复用应用现有 Markdown 渲染链路（GFM / KaTeX / Mermaid / Prism） */
export const MarkdownPreview = ({ text, cacheKey }: { text: string; cacheKey: string }) => (
  <div className={styles.scrollPane}>
    <div className={styles.markdownBody}>
      <Markdown
        content={text}
        loading={false}
        cacheKey={`preview-${cacheKey}`}
        disableLink={false}
      />
    </div>
  </div>
)
