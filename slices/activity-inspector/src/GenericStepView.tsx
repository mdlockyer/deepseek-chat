import type { ActivityStepRenderProps } from '@deepseek-chat/lib-tools'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { activityInspectorMessages } from './messages.js'
import styles from './ActivityPanel.module.css'

const GenericStepRow = ({
  entry,
  focusedCallId,
  focusNonce,
}: {
  entry: ActivityStepRenderProps['entries'][number]
  focusedCallId?: string | null
  focusNonce?: number
}) => {
  const t = activityInspectorMessages.useTranslate()
  const { call, result } = entry
  const isFocused = Boolean(focusedCallId && focusedCallId === call.id)
  const [open, setOpen] = useState(isFocused)

  useEffect(() => {
    if (focusedCallId === call.id) {
      setOpen(true)
    }
  }, [focusedCallId, focusNonce, call.id])

  const summary =
    call.input && typeof (call.input as { summary?: unknown }).summary === 'string'
      ? (call.input as { summary: string }).summary.trim()
      : ''
  const status =
    !result || result.status === 'running' ? 'running' : result.status === 'ok' ? 'ok' : 'error'
  const statusLabel =
    status === 'running'
      ? t('genericStatusRunning')
      : status === 'ok'
        ? t('genericStatusDone')
        : t('genericStatusError')
  const inputText = call.inputJson ?? (call.input ? JSON.stringify(call.input, null, 2) : '')

  return (
    <div className={styles.genericCard} data-activity-call-id={call.id}>
      <button
        type="button"
        className={styles.genericToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.genericHeaderMain}>
          {summary ? (
            <span className={styles.genericSummary}>{summary}</span>
          ) : (
            <span className={styles.genericName}>{call.name}</span>
          )}
        </span>
        <span className={styles.genericHeaderRight}>
          <span className={clsx(styles.genericStatus, status === 'error' && styles.genericError)}>
            {statusLabel}
          </span>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? (
        <div className={styles.genericBody}>
          {summary ? <div className={styles.genericName}>{call.name}</div> : null}
          {inputText ? (
            <div>
              <div className={styles.genericSectionLabel}>{t('genericInput')}</div>
              <pre className={styles.genericPre}>{inputText}</pre>
            </div>
          ) : null}
          {result?.content ? (
            <div>
              <div className={styles.genericSectionLabel}>{t('genericOutput')}</div>
              <pre className={styles.genericPre}>{result.content}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Fallback Activity card used whenever a tool step has no registered `ToolStepPresenter`
 * (for example, historical turns loaded when an optional tool slice has been disabled).
 */
export const GenericStepView = ({
  entries,
  focusedCallId,
  focusNonce,
}: ActivityStepRenderProps) => (
  <div className={styles.genericList}>
    {entries.map((entry) => (
      <GenericStepRow
        key={entry.call.id}
        entry={entry}
        focusedCallId={focusedCallId}
        focusNonce={focusNonce}
      />
    ))}
  </div>
)
