import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-chat/lib-ui'
import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import { useEffect, useState } from 'react'
import type { AskActionMeta } from './askUser.js'
import { askUserMessages } from './messages.js'
import styles from './AskActivity.module.css'

const readAskMeta = (result: ToolResultRecord | undefined): AskActionMeta | null => {
  const payload = result?.payload
  if (
    payload &&
    typeof payload === 'object' &&
    'status' in payload &&
    'items' in payload &&
    Array.isArray((payload as { items?: unknown }).items)
  ) {
    return payload as AskActionMeta
  }
  return null
}

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

export const serializeAskForArchive = (
  _call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ArchiveFragment[] => {
  const ask = readAskMeta(result)
  if (ask?.status === 'answered') {
    const lines = ask.items.map((item) => {
      const val = Array.isArray(item.answer)
        ? item.answer.join(', ')
        : (item.answer ?? '(unanswered)')
      return `${item.header}: ${val}`
    })
    return [{ type: 'MARKDOWN', content: fence('text', lines.join('\n')), separate: true }]
  }
  if (ask?.status === 'skipped') {
    return [
      {
        type: 'MARKDOWN',
        content: fence('text', '[Skipped clarifying questions]'),
        separate: true,
      },
    ]
  }
  return []
}

const AskBlockRow = ({
  entry,
  focusedCallId,
  focusNonce,
}: {
  entry: ActivityStepRenderProps['entries'][number]
  focusedCallId?: string | null
  focusNonce?: number
}) => {
  const t = askUserMessages.useTranslate()
  const { call, result } = entry
  const ask = readAskMeta(result)
  const waiting = !result || result.status === 'running'
  const summary =
    call.input && typeof (call.input as { summary?: unknown }).summary === 'string'
      ? (call.input as { summary: string }).summary
      : ''
  const expandable = Boolean(ask?.status === 'answered' && ask.items.length > 0)
  const isFocused = Boolean(focusedCallId && focusedCallId === call.id)
  const [open, setOpen] = useState(isFocused)

  useEffect(() => {
    if (focusedCallId === call.id) {
      setOpen(true)
    }
  }, [focusedCallId, focusNonce, call.id])

  const titleText = waiting
    ? t('askWaiting')
    : ask?.status === 'skipped'
      ? t('askSkipped')
      : t('askAnswered')

  return (
    <div className={styles.block} data-activity-call-id={call.id}>
      {expandable ? (
        <button
          type="button"
          className={styles.toggleHeader}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.heading}>
            <span className={styles.title}>{titleText}</span>
            {summary ? <span className={styles.summary}>{summary}</span> : null}
          </span>
          <span className={styles.chevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </button>
      ) : (
        <div className={styles.heading}>
          <span className={styles.title}>{titleText}</span>
          {summary ? <span className={styles.summary}>{summary}</span> : null}
        </div>
      )}
      {expandable && open && ask?.status === 'answered' ? (
        <div className={styles.items}>
          {ask.items.map((item) => (
            <div key={item.id} className={styles.item}>
              <span className={styles.icon}>
                <IconCheckedOutline14 />
              </span>
              <span className={styles.label}>{item.header}:</span>
              <span className={styles.value}>
                {Array.isArray(item.answer) ? item.answer.join(', ') : (item.answer ?? '—')}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const AskActivityView = ({ entries, focusedCallId, focusNonce }: ActivityStepRenderProps) => (
  <div className={styles.root}>
    {entries.map((entry) => (
      <AskBlockRow
        key={entry.call.id}
        entry={entry}
        focusedCallId={focusedCallId}
        focusNonce={focusNonce}
      />
    ))}
  </div>
)

export const askUserPresenter: ToolStepPresenter = {
  summarize: (_call, result, { streaming }) => {
    const running = !result || result.status === 'running'
    const failed = !running && result.status !== 'ok'
    return {
      lane: 'ask',
      icon: <IconCheckedOutline14 />,
      liveVerb: askUserMessages.translate('askWaiting'),
      waitingForUser: running && streaming,
      stillRunning: running && streaming,
      failed,
    }
  },
  renderActivity: AskActivityView,
}
