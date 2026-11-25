import { IconCheckedOutline14 } from '@deepseek-chat/lib-ui'
import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
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

const AskActivityView = ({ entries }: ActivityStepRenderProps) => {
  const t = askUserMessages.useTranslate()
  return (
    <div className={styles.root}>
      {entries.map(({ call, result }) => {
        const ask = readAskMeta(result)
        const waiting = !result || result.status === 'running'
        const summary =
          call.input && typeof (call.input as { summary?: unknown }).summary === 'string'
            ? (call.input as { summary: string }).summary
            : ''
        return (
          <div key={call.id} className={styles.block}>
            <div className={styles.heading}>
              <span className={styles.title}>
                {waiting
                  ? t('askWaiting')
                  : ask?.status === 'skipped'
                    ? t('askSkipped')
                    : t('askAnswered')}
              </span>
              {summary ? <span className={styles.summary}>{summary}</span> : null}
            </div>
            {ask?.status === 'answered' ? (
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
      })}
    </div>
  )
}

export const askUserPresenter: ToolStepPresenter = {
  summarize: (_call, result, { streaming }) => {
    const running = !result || result.status === 'running'
    const failed = !running && result.status !== 'ok'
    return {
      lane: 'ask',
      liveVerb: askUserMessages.translate('askWaiting'),
      waitingForUser: running && streaming,
      stillRunning: running && streaming,
      failed,
    }
  },
  renderActivity: AskActivityView,
}
