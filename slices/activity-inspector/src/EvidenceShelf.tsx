import { activityInspectorMessages } from './messages.js'
import type { ActivityVisualItem } from './timeline.js'
import styles from './ActivityPanel.module.css'

/**
 * Top visuals strip: promotes captured screenshots and generated figures above the
 * chronological timeline so users can inspect them directly without mode-switching tabs.
 */
export const EvidenceShelf = ({
  visuals,
  onOpenVisual,
}: {
  visuals: readonly ActivityVisualItem[]
  onOpenVisual: (index: number) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  if (visuals.length === 0) {
    return null
  }

  return (
    <section className={styles.evidenceShelf} aria-label={t('panelTitle')}>
      <div className={styles.filmstripSection}>
        <div className={styles.filmstripHeading}>
          {t('evidenceVisualsHeading', { count: visuals.length })}
        </div>
        <div className={styles.filmstrip} role="list">
          {visuals.map((visual, index) => {
            const label = visual.caption ?? visual.stepLabel
            return (
              <div key={visual.key} role="listitem" className={styles.filmstripItem}>
                <button
                  type="button"
                  className={styles.thumbButton}
                  title={label}
                  aria-label={t('inspectVisualLabel', { label })}
                  onClick={() => onOpenVisual(index)}
                >
                  <img src={visual.src} alt="" className={styles.thumbImage} />
                  <span className={styles.thumbCaption}>{label}</span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
