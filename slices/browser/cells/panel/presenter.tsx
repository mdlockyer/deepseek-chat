import { useLocale, type Locale } from '@deepseek-chat/spine/i18n'
import type {
  ActivityStepDetailProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
  ToolStepVisualArtifact,
} from '@deepseek-chat/lib-tools'
import {
  Banner,
  IconBrowserOutline14,
  IconCodeOutline14,
  IconEyeOutline16,
  IconGlobeLanguageOutline14,
  IconViewportOutline14,
} from '@deepseek-chat/lib-ui'
import styles from './BrowserActivity.module.css'
import {
  BROWSER_EVAL_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_OBSERVE_TOOL_NAME,
  BROWSER_SET_VIEWPORT_TOOL_NAME,
  browserMessages,
  describeAction,
  isHttpUrl,
  type BrowserActionMeta,
} from '../../kernel/index.js'

const MAX_OUTPUT_PREVIEW_CHARS = 1800

const browserToolIcon = (toolName: string) => {
  switch (toolName) {
    case BROWSER_OBSERVE_TOOL_NAME:
      return <IconEyeOutline16 />
    case BROWSER_NAVIGATE_TOOL_NAME:
      return <IconGlobeLanguageOutline14 />
    case BROWSER_EVAL_TOOL_NAME:
      return <IconCodeOutline14 />
    case BROWSER_SET_VIEWPORT_TOOL_NAME:
      return <IconViewportOutline14 />
    default:
      return <IconBrowserOutline14 />
  }
}

const getSiteName = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

const callSummaryOf = (call: ToolCallRecord): string | null => {
  const input =
    call.input && typeof call.input === 'object' ? (call.input as { summary?: unknown }) : null
  if (typeof input?.summary === 'string' && input.summary.trim()) {
    return input.summary.trim()
  }
  return null
}

const evalScriptOf = (call: ToolCallRecord): string | null => {
  if (call.name !== BROWSER_EVAL_TOOL_NAME) {
    return null
  }
  const input =
    call.input && typeof call.input === 'object' ? (call.input as { script?: unknown }) : null
  return typeof input?.script === 'string' && input.script.trim() ? input.script.trim() : null
}

const readMeta = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): BrowserActionMeta => {
  const payload = result?.payload as BrowserActionMeta | undefined
  if (payload && typeof payload.summary === 'string') {
    return payload
  }
  const input =
    call.input && typeof call.input === 'object' && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown> & { summary?: unknown; url?: unknown })
      : null
  return {
    tool: call.name,
    // Until the model's own summary has streamed in, describe the action in words, never by the
    // tool's internal name.
    summary:
      typeof input?.summary === 'string' && input.summary.trim()
        ? input.summary.trim()
        : describeAction(call.name, input ?? {}),
    ...(typeof input?.url === 'string' ? { url: input.url } : {}),
  }
}

const screenshotsOf = (result: ToolResultRecord | undefined): readonly string[] =>
  result?.previewImages?.length ? result.previewImages : (result?.images ?? [])

const formatOutputPreview = (raw: string): string => {
  const cleaned = raw
    .replace(/<untrusted_webpage_content(?:\s[^>]*)?>|<\/untrusted_webpage_content>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length <= MAX_OUTPUT_PREVIEW_CHARS) {
    return cleaned
  }
  return `${cleaned.slice(0, MAX_OUTPUT_PREVIEW_CHARS).trimEnd()}…`
}

const buildVisuals = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined,
  meta: BrowserActionMeta,
  locale?: Locale
): readonly ToolStepVisualArtifact[] | undefined => {
  const shots = screenshotsOf(result)
  if (shots.length === 0) {
    return undefined
  }
  const actionUrl = meta.url && isHttpUrl(meta.url) ? meta.url : undefined
  const humanSummary = callSummaryOf(call)
  const target =
    meta.title || (actionUrl ? getSiteName(actionUrl) : null) || humanSummary || meta.summary
  const alt = browserMessages.translate(locale, 'browserScreenshotAlt', { target })
  const caption = humanSummary ?? meta.summary
  return shots.map((src) => ({
    src,
    alt,
    caption,
    ...(actionUrl ? { href: actionUrl } : {}),
  }))
}

export const serializeBrowserForArchive = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ArchiveFragment[] => {
  const meta = readMeta(call, result)
  const status: 'WIP' | 'FINISHED' | 'FAILED' =
    !result || result.status === 'running' ? 'WIP' : result.status === 'ok' ? 'FINISHED' : 'FAILED'
  if (call.name === BROWSER_NAVIGATE_TOOL_NAME && meta.url && isHttpUrl(meta.url)) {
    return [
      {
        type: 'TOOL_OPEN',
        status,
        url: meta.url,
        title: meta.title ?? null,
        snippet: status === 'FINISHED' ? '' : null,
        site_name: getSiteName(meta.url),
        published_at: null,
      },
    ]
  }
  const summaryLine = meta.url
    ? `[Browser: ${meta.summary} (${meta.url})]`
    : `[Browser: ${meta.summary}]`
  const body =
    result && result.status !== 'running' && result.status !== 'ok' && result.content.trim()
      ? `${summaryLine}\n${result.content.trim()}`
      : summaryLine
  return [{ type: 'MARKDOWN', content: fence('text', body), separate: true }]
}

const BrowserStepDetail = ({
  entry,
  openLink,
  openVisual,
  renderMarkdown,
}: ActivityStepDetailProps) => {
  const locale = useLocale()
  const t = browserMessages.useTranslate()
  const { call, result } = entry
  const meta = readMeta(call, result)
  const humanSummary = callSummaryOf(call)
  const actionUrl = meta.url && isHttpUrl(meta.url) ? meta.url : null
  const visuals = buildVisuals(call, result, meta, locale) ?? []
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
  const script = evalScriptOf(call)
  const rawOutput = result?.content?.trim() ?? ''
  const showOutput =
    !failed &&
    Boolean(rawOutput) &&
    (visuals.length === 0 ||
      call.name === BROWSER_EVAL_TOOL_NAME ||
      call.name === BROWSER_OBSERVE_TOOL_NAME)
  const showTechNote = Boolean(
    !showOutput &&
    humanSummary &&
    meta.summary &&
    meta.summary.toLowerCase() !== humanSummary.toLowerCase()
  )

  return (
    <div className={styles.detail}>
      {actionUrl ? (
        <a
          className={styles.link}
          href={actionUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => openLink(event, actionUrl)}
        >
          <span className={styles.linkText}>{meta.title || actionUrl}</span>
        </a>
      ) : null}

      {showTechNote ? <div className={styles.techNote}>{meta.summary}</div> : null}

      {script ? (
        <div className={styles.block}>
          <div className={styles.sectionLabel}>{t('browserScriptHeading')}</div>
          {renderMarkdown({
            content: fence('js', script),
            cacheKey: `browser-eval-${call.id}`,
          })}
        </div>
      ) : null}

      {failed && rawOutput ? (
        <Banner tone="error" compact role="note">
          <div className={styles.errorText}>{rawOutput}</div>
        </Banner>
      ) : null}

      {visuals.map((visual, imgIndex) =>
        openVisual ? (
          <button
            key={imgIndex}
            type="button"
            className={styles.screenshotButton}
            aria-label={visual.alt}
            onClick={() => openVisual(visual)}
          >
            <img src={visual.src} alt={visual.alt} className={styles.screenshot} />
          </button>
        ) : (
          <img key={imgIndex} src={visual.src} alt={visual.alt} className={styles.screenshot} />
        )
      )}

      {showOutput ? (
        <div className={styles.block}>
          <div className={styles.sectionLabel}>{t('browserOutputHeading')}</div>
          <pre className={styles.output}>{formatOutputPreview(rawOutput)}</pre>
        </div>
      ) : null}
    </div>
  )
}

export const browserPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming, locale }) => {
    const meta = readMeta(call, result)
    const humanSummary = callSummaryOf(call)
    const running = !result || result.status === 'running'
    const actionUrl = meta.url && isHttpUrl(meta.url) ? meta.url : null
    const visuals = buildVisuals(call, result, meta, locale)
    const script = evalScriptOf(call)
    const hasOutput = Boolean(result?.content?.trim())

    return {
      lane: 'browser',
      icon: browserToolIcon(call.name),
      liveVerb: browserMessages.translate(locale, 'browserStepRunning'),
      detail: humanSummary ?? meta.summary,
      ...(visuals ? { visuals } : {}),
      hasDetail: Boolean(actionUrl || visuals?.length || hasOutput || script),
      stillRunning: running && streaming,
      failed: !running && result.status !== 'ok',
      tally: {
        key: 'browser',
        count: 1,
        label: (count) =>
          browserMessages.translate(locale, count === 1 ? 'browserCountOne' : 'browserCountMany', {
            count,
          }),
      },
    }
  },
  renderStepDetail: BrowserStepDetail,
}
