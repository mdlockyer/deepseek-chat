import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCodeOutline14,
} from '@deepseek-chat/lib-ui'
import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import { useEffect, useState } from 'react'
import { pythonMessages } from './messages.js'
import styles from './PythonActivity.module.css'

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

const codeOf = (call: ToolCallRecord): string => {
  const input = call.input as { code?: unknown } | null
  return typeof input?.code === 'string' ? input.code : (call.inputJson ?? '')
}

const summaryOf = (call: ToolCallRecord): string | null => {
  const input = call.input as { summary?: unknown } | null
  return typeof input?.summary === 'string' && input.summary.trim() ? input.summary.trim() : null
}

export const serializePythonForArchive = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ArchiveFragment[] => {
  const fragments: ArchiveFragment[] = []
  const code = codeOf(call)
  if (code.trim()) {
    fragments.push({ type: 'MARKDOWN', content: fence('python', code), separate: true })
  }
  if (result && result.status !== 'running' && result.content.trim()) {
    fragments.push({ type: 'MARKDOWN', content: fence('text', result.content), separate: true })
  }
  return fragments
}

const PythonRunRow = ({
  entry,
  renderMarkdown,
  focusedCallId,
  focusNonce,
}: {
  entry: ActivityStepRenderProps['entries'][number]
  renderMarkdown: ActivityStepRenderProps['renderMarkdown']
  focusedCallId?: string | null
  focusNonce?: number
}) => {
  const t = pythonMessages.useTranslate()
  const { call, result } = entry
  const isFocused = Boolean(focusedCallId && focusedCallId === call.id)
  const [open, setOpen] = useState(isFocused)

  useEffect(() => {
    if (focusedCallId === call.id) {
      setOpen(true)
    }
  }, [focusedCallId, focusNonce, call.id])

  const code = codeOf(call)
  const summary = summaryOf(call)
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
  const duration =
    result?.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)}s` : null

  return (
    <div className={styles.run} data-activity-call-id={call.id}>
      <button
        type="button"
        className={styles.toggleHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.title}>
          <span className={styles.icon} aria-hidden="true">
            <IconCodeOutline14 />
          </span>
          <span className={styles.titleText}>{summary ?? t('pythonActivityTitle')}</span>
        </span>
        <span className={styles.right}>
          {duration ? (
            <span className={failed ? styles.error : styles.meta}>{duration}</span>
          ) : null}
          <span className={styles.chevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
      </button>
      {open ? (
        <div className={styles.body}>
          {code.trim()
            ? renderMarkdown({
                content: fence('python', code),
                cacheKey: `py-code-${call.id}`,
              })
            : null}
          {result?.content?.trim() ? (
            <pre className={failed ? `${styles.output} ${styles.error}` : styles.output}>
              {result.content}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const PythonActivityView = ({
  entries,
  renderMarkdown,
  focusedCallId,
  focusNonce,
}: ActivityStepRenderProps) => (
  <div className={styles.root}>
    {entries.map((entry) => (
      <PythonRunRow
        key={entry.call.id}
        entry={entry}
        renderMarkdown={renderMarkdown}
        focusedCallId={focusedCallId}
        focusNonce={focusNonce}
      />
    ))}
  </div>
)

export const pythonPresenter: ToolStepPresenter = {
  summarize: (_call, result, { streaming }) => {
    const running = !result || result.status === 'running'
    const phase = result?.progress?.phase
    const verbKey =
      phase === 'installing'
        ? 'pythonInstalling'
        : phase === 'starting'
          ? 'pythonStarting'
          : 'pythonRunning'
    return {
      lane: 'python',
      icon: <IconCodeOutline14 />,
      liveVerb: pythonMessages.translate(verbKey),
      stillRunning: running && streaming,
      failed: !running && result.status !== 'ok',
      tally: {
        key: 'python',
        count: 1,
        label: (count) =>
          pythonMessages.translate(count === 1 ? 'pythonCountOne' : 'pythonCountMany', { count }),
      },
    }
  },
  renderActivity: PythonActivityView,
}
