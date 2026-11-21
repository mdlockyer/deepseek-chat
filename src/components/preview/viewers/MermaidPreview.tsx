import { MermaidDiagram } from '../../markdown/MermaidDiagram.js'
import styles from '../PreviewPanel.module.css'

/** Mermaid 图表预览 */
export const MermaidPreview = ({ text }: { text: string }) => (
  <div className={styles.scrollPane}>
    <div className={styles.mermaidBody}>
      <MermaidDiagram code={text} loading={false} />
    </div>
  </div>
)
