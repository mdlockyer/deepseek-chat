import { IconCodeOutline14 } from '@deepseek-chat/lib-ui'
import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
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

const PythonActivityView = ({ entries, renderMarkdown }: ActivityStepRenderProps) => {
  const t = pythonMessages.useTranslate()
  return (
    <div className={styles.root}>
      {entries.map(({ call, result }) => {
        const code = codeOf(call)
        const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
        const duration =
          result?.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)}s` : null
        return (
          <div key={call.id} className={styles.root}>
            <div className={styles.header}>
              <span className={styles.title}>
                <IconCodeOutline14 />
                <span>{t('pythonActivityTitle')}</span>
              </span>
              {duration ? (
                <span className={failed ? styles.error : styles.meta}>{duration}</span>
              ) : null}
            </div>
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
        )
      })}
    </div>
  )
}

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
