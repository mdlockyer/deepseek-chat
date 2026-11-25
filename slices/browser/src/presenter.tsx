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
} from '@deepseek-chat/lib-ui'
import { useState } from 'react'
import styles from './BrowserActivity.module.css'
import { browserMessages } from './messages.js'
import { isHttpUrl } from './state.js'
import { BROWSER_NAVIGATE_TOOL_NAME, type BrowserActionMeta } from './tools.js'

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

const BrowserActivityView = ({ entries, streaming, openLink }: ActivityStepRenderProps) => {
  const t = browserMessages.useTranslate()
  const hasError = entries.some(
    ({ result }) => result && result.status !== 'ok' && result.status !== 'running'
  )
  const [open, setOpen] = useState(hasError)
  const isRunning =
    streaming && entries.some(({ result }) => !result || result.status === 'running')
  const totalMs = entries.reduce((acc, { result }) => acc + (result?.durationMs ?? 0), 0)
  const lastMeta =
    entries.length > 0
      ? readMeta(entries[entries.length - 1].call, entries[entries.length - 1].result)
      : null
  const label = isRunning
    ? lastMeta?.summary || t('browserStepRunning')
    : entries.length === 1
      ? lastMeta?.summary || t('browserStepOne')
      : t('browserStepMany', { count: entries.length })
  const seconds = !isRunning && totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ''

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.toggleHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.title}>
          <IconBrowserOutline14 />
          <span>{label}</span>
          {seconds ? <span className={styles.meta}>{seconds}</span> : null}
        </span>
        <span className={styles.chevron}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? (
        <div className={styles.actions}>
          {entries.map(({ call, result }, index) => {
            const meta = readMeta(call, result)
            const actionUrl = meta.url && isHttpUrl(meta.url) ? meta.url : null
            const screenshots = result?.previewImages?.length
              ? result.previewImages
              : (result?.images ?? [])
            const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
            return (
              <div key={call.id} className={styles.actionRow}>
                <div className={styles.actionLine}>
                  <span className={styles.stepIndex}>{index + 1}.</span>
                  <span>{meta.summary}</span>
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
                </div>
                {failed && result?.content ? (
                  <div className={styles.error}>{result.content}</div>
                ) : null}
                {screenshots.map((src, imgIndex) => (
                  <img key={imgIndex} src={src} alt="" className={styles.screenshot} />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export const browserPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming }) => {
    const meta = readMeta(call, result)
    const running = !result || result.status === 'running'
    return {
      lane: 'browser',
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
