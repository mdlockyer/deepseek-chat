import type { ActivityStepDetailProps } from '@deepseek-chat/lib-tools'
import { IconWarningOutline16 } from '@deepseek-chat/lib-ui'
import { activityInspectorMessages } from './messages.js'
import styles from './ActivityPanel.module.css'

/**
 * Fallback expanded detail body used whenever a tool step has no registered `ToolStepPresenter`
 * (for example, historical turns loaded when an optional tool slice is unmounted).
 */
export const GenericStepDetail = ({ entry }: ActivityStepDetailProps) => {
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
          <div className={styles.errorBox} role="note">
            <span className={styles.errorBoxIcon} aria-hidden="true">
              <IconWarningOutline16 />
            </span>
            <pre className={styles.errorBoxPre}>{result.content}</pre>
          </div>
        ) : (
          <div className={styles.genericSection}>
            <div className={styles.genericSectionLabel}>{t('genericOutput')}</div>
            <pre className={styles.genericPre}>{result.content}</pre>
          </div>
        )
      ) : null}
      {images.map((src, idx) => (
        <img key={idx} src={src} alt={call.name} className={styles.genericImage} />
      ))}
    </div>
  )
}
