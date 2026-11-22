import { useWorkspace } from '../context.js'
import styles from '../PreviewPanel.module.css'

/** Mermaid 图表预览 */
export const MermaidPreview = ({ text }: { text: string }) => {
  const { Mermaid } = useWorkspace().views
  return (
    <div className={styles.scrollPane}>
      <div className={styles.mermaidBody}>
        <Mermaid code={text} />
      </div>
    </div>
  )
}
