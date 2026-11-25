import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import {
  IconBrowserOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCodeOutline14,
  IconEyeOutline16,
  IconGlobeLanguageOutline14,
  IconViewportOutline14,
} from '@deepseek-chat/lib-ui'
import { useEffect, useState, type MouseEvent } from 'react'
import styles from './BrowserActivity.module.css'
import { browserMessages } from './messages.js'
import { isHttpUrl } from './state.js'
import {
  BROWSER_EVAL_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_OBSERVE_TOOL_NAME,
  BROWSER_SET_VIEWPORT_TOOL_NAME,
  type BrowserActionMeta,
} from './tools.js'

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

const readMeta = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): BrowserActionMeta => {
  const payload = result?.payload as BrowserActionMeta | undefined
  if (payload && typeof payload.summary === 'string') {
    return payload
  }
  const input =
    call.input && typeof call.input === 'object'
      ? (call.input as { summary?: unknown; url?: unknown })
      : null
  return {
    tool: call.name,
    summary:
      typeof input?.summary === 'string' && input.summary.trim() ? input.summary.trim() : call.name,
    ...(typeof input?.url === 'string' ? { url: input.url } : {}),
  }
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

const BrowserActionRow = ({
  entry,
  openLink,
  focusedCallId,
  focusNonce,
}: {
  entry: ActivityStepRenderProps['entries'][number]
  openLink: (event: MouseEvent, url: string) => void
  focusedCallId?: string | null
  focusNonce?: number
}) => {
  const { call, result } = entry
  const meta = readMeta(call, result)
  const actionUrl = meta.url && isHttpUrl(meta.url) ? meta.url : null
  const screenshots = result?.previewImages?.length ? result.previewImages : (result?.images ?? [])
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
  const hasDetails = Boolean(actionUrl || (failed && result?.content) || screenshots.length > 0)
  const isFocused = Boolean(focusedCallId && focusedCallId === call.id)
  const [open, setOpen] = useState(isFocused)

  useEffect(() => {
    if (focusedCallId === call.id) {
      setOpen(true)
    }
  }, [focusedCallId, focusNonce, call.id])

  const icon = browserToolIcon(call.name)

  return (
    <div className={styles.actionRow} data-activity-call-id={call.id}>
      {hasDetails ? (
        <button
          type="button"
          className={styles.actionToggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.actionIcon} aria-hidden="true">
            {icon}
          </span>
          <span className={styles.actionSummary}>{meta.summary}</span>
          <span className={styles.chevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </button>
      ) : (
        <div className={styles.actionStatic}>
          <span className={styles.actionIcon} aria-hidden="true">
            {icon}
          </span>
          <span className={styles.actionSummary}>{meta.summary}</span>
        </div>
      )}
      {hasDetails && open ? (
        <div className={styles.actionDetails}>
          {actionUrl ? (
            <a
              className={styles.link}
              href={actionUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => openLink(event, actionUrl)}
            >
              {meta.title || actionUrl}
            </a>
          ) : null}
          {failed && result?.content ? <div className={styles.error}>{result.content}</div> : null}
          {screenshots.map((src, imgIndex) => (
            <img key={imgIndex} src={src} alt="" className={styles.screenshot} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const BrowserActivityView = ({
  entries,
  openLink,
  focusedCallId,
  focusNonce,
}: ActivityStepRenderProps) => {
  const t = browserMessages.useTranslate()
  return (
    <div className={styles.root}>
      <div className={styles.laneHeader}>
        <span className={styles.title}>
          <IconBrowserOutline14 />
          <span>{t('browserToggleLabel')}</span>
        </span>
        <span className={styles.meta}>{entries.length}</span>
      </div>
      <div className={styles.actions}>
        {entries.map((entry) => (
          <BrowserActionRow
            key={entry.call.id}
            entry={entry}
            openLink={openLink}
            focusedCallId={focusedCallId}
            focusNonce={focusNonce}
          />
        ))}
      </div>
    </div>
  )
}

export const browserPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming }) => {
    const meta = readMeta(call, result)
    const running = !result || result.status === 'running'
    return {
      lane: 'browser',
      icon: browserToolIcon(call.name),
      liveVerb: browserMessages.translate('browserStepRunning'),
      detail: meta.summary,
      stillRunning: running && streaming,
      failed: !running && result.status !== 'ok',
      tally: {
        key: 'browser',
        count: 1,
        label: (count) =>
          browserMessages.translate(count === 1 ? 'browserCountOne' : 'browserCountMany', {
            count,
          }),
      },
    }
  },
  renderActivity: BrowserActivityView,
}
