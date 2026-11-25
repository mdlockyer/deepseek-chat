import { Banner, IconCodeOutline14 } from '@deepseek-chat/lib-ui'
import type {
  ActivityStepDetailProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
  ToolStepVisualArtifact,
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

const summaryOf = (call: ToolCallRecord): string | null => {
  const input = call.input as { summary?: unknown } | null
  return typeof input?.summary === 'string' && input.summary.trim() ? input.summary.trim() : null
}

const visualsOf = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ToolStepVisualArtifact[] | undefined => {
  const images = result?.previewImages?.length ? result.previewImages : (result?.images ?? [])
  if (images.length === 0) {
    return undefined
  }
  const label = summaryOf(call) ?? pythonMessages.translate('pythonActivityTitle')
  return images.map((src) => ({ src, alt: label, caption: label }))
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

const PythonStepDetail = ({ entry, openVisual, renderMarkdown }: ActivityStepDetailProps) => {
  const t = pythonMessages.useTranslate()
  const { call, result } = entry
  const code = codeOf(call)
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
  const visuals = visualsOf(call, result) ?? []

  return (
    <div className={styles.detail}>
      {code.trim()
        ? renderMarkdown({
            content: fence('python', code),
            cacheKey: `py-code-${call.id}`,
          })
        : null}
      {result?.content?.trim() ? (
        failed ? (
          <Banner tone="error" compact role="note">
            <pre className={styles.errorOutput}>{result.content}</pre>
          </Banner>
        ) : (
          <div className={styles.outputBlock}>
            <div className={styles.sectionLabel}>{t('pythonOutputHeading')}</div>
            <pre className={styles.output}>{result.content}</pre>
          </div>
        )
      ) : null}
      {visuals.map((visual, idx) =>
        openVisual ? (
          <button
            key={idx}
            type="button"
            className={styles.figureButton}
            aria-label={visual.alt}
            onClick={() => openVisual(visual)}
          >
            <img src={visual.src} alt={visual.alt} className={styles.figure} />
          </button>
        ) : (
          <img key={idx} src={visual.src} alt={visual.alt} className={styles.figure} />
        )
      )}
    </div>
  )
}

export const pythonPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming }) => {
    const running = !result || result.status === 'running'
    const phase = result?.progress?.phase
    const verbKey =
      phase === 'installing'
        ? 'pythonInstalling'
        : phase === 'starting'
          ? 'pythonStarting'
          : 'pythonRunning'
    const duration =
      result?.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)}s` : undefined
    const visuals = visualsOf(call, result)

    return {
      lane: 'python',
      icon: <IconCodeOutline14 />,
      liveVerb: pythonMessages.translate(verbKey),
      detail: summaryOf(call) ?? pythonMessages.translate('pythonActivityTitle'),
      ...(duration ? { meta: duration } : {}),
      ...(visuals ? { visuals } : {}),
      hasDetail: Boolean(codeOf(call).trim() || result?.content?.trim() || visuals?.length),
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
  renderStepDetail: PythonStepDetail,
}
