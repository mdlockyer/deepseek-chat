import type { ActivityStepDetailProps } from '@deepseek-chat/lib-tools'
import { Banner } from '@deepseek-chat/lib-ui'
import { activityInspectorMessages } from './messages.js'
import styles from './ActivityPanel.module.css'

/**
 * Fallback expanded detail body used whenever a tool step has no registered `ToolStepPresenter`
 * (for example, historical turns loaded when an optional tool slice is unmounted).
 */
export const GenericStepDetail = ({ entry, openVisual }: ActivityStepDetailProps) => {
  const t = activityInspectorMessages.useTranslate()
  const { call, result } = entry
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
  const inputText = call.inputJson ?? (call.input ? JSON.stringify(call.input, null, 2) : '')
  const images = result?.previewImages?.length ? result.previewImages : (result?.images ?? [])

  return (
    <div className={styles.genericBody}>
      <div className={styles.genericName}>{call.name}</div>
      {inputText ? (
        <div className={styles.genericSection}>
          <div className={styles.genericSectionLabel}>{t('genericInput')}</div>
          <pre className={styles.genericPre}>{inputText}</pre>
        </div>
      ) : null}
      {result?.content ? (
        failed ? (
          <Banner tone="error" compact role="note">
            <pre className={styles.errorBoxPre}>{result.content}</pre>
          </Banner>
        ) : (
          <div className={styles.genericSection}>
            <div className={styles.genericSectionLabel}>{t('genericOutput')}</div>
            <pre className={styles.genericPre}>{result.content}</pre>
          </div>
        )
      ) : null}
      {images.map((src, idx) =>
        openVisual ? (
          <button
            key={idx}
            type="button"
            className={styles.detailImageButton}
            aria-label={t('inspectVisualLabel', { label: call.name })}
            onClick={() => openVisual({ src, alt: call.name, caption: call.name })}
          >
            <img src={src} alt={call.name} className={styles.genericImage} />
          </button>
        ) : (
          <img key={idx} src={src} alt={call.name} className={styles.genericImage} />
        )
      )}
    </div>
  )
}
