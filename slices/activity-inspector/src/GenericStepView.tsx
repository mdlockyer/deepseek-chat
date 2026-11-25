import type { ActivityStepRenderProps } from '@deepseek-chat/lib-tools'
import clsx from 'clsx'
import { activityInspectorMessages } from './messages.js'
import styles from './ActivityPanel.module.css'

/**
 * Fallback Activity card used whenever a tool step has no registered `ToolStepPresenter`
 * (for example, historical turns loaded when an optional tool slice has been disabled).
 */
export const GenericStepView = ({ entries }: ActivityStepRenderProps) => {
  const t = activityInspectorMessages.useTranslate()
  return (
    <div className={styles.genericList}>
      {entries.map(({ call, result }) => {
        const summary =
          call.input && typeof (call.input as { summary?: unknown }).summary === 'string'
            ? (call.input as { summary: string }).summary
            : ''
        const status =
          !result || result.status === 'running'
            ? 'running'
            : result.status === 'ok'
              ? 'ok'
              : 'error'
        const statusLabel =
          status === 'running'
            ? t('genericStatusRunning')
            : status === 'ok'
              ? t('genericStatusDone')
              : t('genericStatusError')
        const inputText = call.inputJson ?? (call.input ? JSON.stringify(call.input, null, 2) : '')
        return (
          <div key={call.id} className={styles.genericCard}>
            <div className={styles.genericHeader}>
              <span className={styles.genericName}>{call.name}</span>
              <span
                className={clsx(styles.genericStatus, status === 'error' && styles.genericError)}
              >
                {statusLabel}
              </span>
            </div>
            {summary ? <div className={styles.genericSummary}>{summary}</div> : null}
            {inputText ? (
              <details className={styles.genericDetails}>
                <summary>{t('genericInput')}</summary>
                <pre className={styles.genericPre}>{inputText}</pre>
              </details>
            ) : null}
            {result?.content ? (
              <details className={styles.genericDetails}>
                <summary>{t('genericOutput')}</summary>
                <pre className={styles.genericPre}>{result.content}</pre>
              </details>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
