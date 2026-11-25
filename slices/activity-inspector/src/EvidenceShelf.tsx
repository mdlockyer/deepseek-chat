import { Banner, Button, IconWarningOutline16 } from '@deepseek-chat/lib-ui'
import { activityInspectorMessages } from './messages.js'
import type { ActivityFailedStep, ActivityVisualItem } from './timeline.js'
import styles from './ActivityPanel.module.css'

/**
 * Evidence-first top shelf: promotes failed steps and captured visual thumbnails above the
 * chronological timeline without forcing mode-switching filter tabs.
 */
export const EvidenceShelf = ({
  failedSteps,
  visuals,
  onInspectStep,
  onOpenVisual,
}: {
  failedSteps: readonly ActivityFailedStep[]
  visuals: readonly ActivityVisualItem[]
  onInspectStep: (callId: string) => void
  onOpenVisual: (index: number) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  if (failedSteps.length === 0 && visuals.length === 0) {
    return null
  }

  return (
    <section className={styles.evidenceShelf} aria-label={t('panelTitle')}>
      {failedSteps.length === 1 ? (
        <Banner
          tone="error"
          compact
          role="status"
          icon={<IconWarningOutline16 />}
          action={
            <Button
              variant="ghost"
              size="s"
              className={styles.errorJumpButton}
              onClick={() => onInspectStep(failedSteps[0].callId)}
            >
              {t('inspectAction')}
            </Button>
          }
        >
          <div className={styles.errorSummaryTitle}>{failedSteps[0].label}</div>
          {failedSteps[0].preview ? (
            <div className={styles.errorSummaryPreview}>{failedSteps[0].preview}</div>
          ) : null}
        </Banner>
      ) : failedSteps.length > 1 ? (
        <Banner tone="error" compact role="status" icon={<IconWarningOutline16 />}>
          <div className={styles.errorSummaryTitle}>
            {t('evidenceErrorsMany', { count: failedSteps.length })}
          </div>
          <div className={styles.errorSummaryList}>
            {failedSteps.map((step) => (
              <button
                key={step.callId}
                type="button"
                className={styles.errorSummaryLink}
                onClick={() => onInspectStep(step.callId)}
              >
                {step.label}
              </button>
            ))}
          </div>
        </Banner>
      ) : null}

      {visuals.length > 0 ? (
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
      ) : null}
    </section>
  )
}
