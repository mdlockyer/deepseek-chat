import { IconChevronRightOutline14 } from '@deepseek-chat/lib-ui'
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
        <button
          type="button"
          className={styles.errorCalloutButton}
          title={
            failedSteps[0].preview
              ? `${failedSteps[0].label}: ${failedSteps[0].preview}`
              : failedSteps[0].label
          }
          aria-label={t('inspectErrorStep', { label: failedSteps[0].label })}
          onClick={() => onInspectStep(failedSteps[0].callId)}
        >
          <span className={styles.errorCalloutBody}>
            <span className={styles.errorCalloutKicker}>{t('evidenceErrorsOne')}</span>
            <span className={styles.errorSummaryTitle}>{failedSteps[0].label}</span>
            {failedSteps[0].preview ? (
              <span className={styles.errorSummaryPreview}>{failedSteps[0].preview}</span>
            ) : null}
          </span>
          <span className={styles.errorCalloutChevron} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
        </button>
      ) : failedSteps.length > 1 ? (
        <div
          className={styles.errorCalloutGroup}
          role="group"
          aria-label={t('evidenceErrorsMany', { count: failedSteps.length })}
        >
          <span className={styles.errorCalloutKicker}>
            {t('evidenceErrorsMany', { count: failedSteps.length })}
          </span>
          <div className={styles.errorSummaryList}>
            {failedSteps.map((step) => (
              <button
                key={step.callId}
                type="button"
                className={styles.errorSummaryLink}
                title={step.preview ? `${step.label}: ${step.preview}` : step.label}
                aria-label={t('inspectErrorStep', { label: step.label })}
                onClick={() => onInspectStep(step.callId)}
              >
                <span className={styles.errorSummaryLinkText}>{step.label}</span>
                <span className={styles.errorCalloutChevron} aria-hidden="true">
                  <IconChevronRightOutline14 />
                </span>
              </button>
            ))}
          </div>
        </div>
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
