import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import {
  IconBrowseOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconGlobeLanguageOutline14,
  IconRightUpOutline14,
  IconSearchOutline16,
} from '@deepseek-chat/lib-ui'
import { useEffect, useState } from 'react'
import { webResearchMessages } from './messages.js'
import styles from './WebResearchActivity.module.css'

export type WebResearchPayload =
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'scrape'; readonly url: string; readonly title: string | null }

const getSiteName = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

const queryOf = (call: ToolCallRecord, result: ToolResultRecord | undefined): string => {
  const payload = result?.payload as WebResearchPayload | undefined
  if (payload?.kind === 'search' && payload.query) {
    return payload.query
  }
  const input = call.input as { query?: unknown } | null
  return typeof input?.query === 'string' ? input.query.trim() : ''
}

const pageOf = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): { url: string; title: string | null } => {
  const payload = result?.payload as WebResearchPayload | undefined
  if (payload?.kind === 'scrape') {
    return { url: payload.url, title: payload.title }
  }
  const input = call.input as { url?: unknown } | null
  return {
    url: typeof input?.url === 'string' ? input.url.trim() : '',
    title: null,
  }
}

const archiveStatus = (result: ToolResultRecord | undefined): 'WIP' | 'FINISHED' | 'FAILED' => {
  if (!result || result.status === 'running') {
    return 'WIP'
  }
  return result.status === 'ok' ? 'FINISHED' : 'FAILED'
}

export const serializeWebResearchForArchive = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ArchiveFragment[] => {
  if (call.name === 'web_search') {
    const query = queryOf(call, result)
    const sources = result?.sources ?? []
    return [
      {
        type: 'TOOL_SEARCH',
        queries: query ? [query] : [],
        status: archiveStatus(result),
        results: sources.map((source) => ({
          url: source.url,
          title: source.title,
          snippet: source.snippet,
          published_at: source.publishedAt,
          site_name: source.siteName,
          site_icon: null,
        })),
      },
    ]
  }
  if (call.name === 'web_scrape') {
    const page = pageOf(call, result)
    const status = archiveStatus(result)
    return [
      {
        type: 'TOOL_OPEN',
        status,
        url: page.url || null,
        title: page.title,
        snippet: status === 'FINISHED' ? '' : null,
        site_name: page.url ? getSiteName(page.url) : null,
        published_at: null,
      },
    ]
  }
  return []
}

const WebResearchActivityView = ({
  entries,
  openLink,
  focusedCallId,
  focusNonce,
}: ActivityStepRenderProps) => {
  const t = webResearchMessages.useTranslate()
  const queries: { id: string; query: string }[] = []
  const seenQueries = new Set<string>()
  const searchCallIds = new Set<string>()
  const pages: { id: string; url: string; title: string | null; failed: boolean }[] = []
  const pageCallIds = new Set<string>()

  for (const { call, result } of entries) {
    if (call.name === 'web_search') {
      searchCallIds.add(call.id)
      const q = queryOf(call, result)
      if (q && !seenQueries.has(q)) {
        seenQueries.add(q)
        queries.push({ id: call.id, query: q })
      }
    } else if (call.name === 'web_scrape') {
      pageCallIds.add(call.id)
      const page = pageOf(call, result)
      const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
      pages.push({ id: call.id, url: page.url, title: page.title, failed })
    }
  }

  const matchesSearch = Boolean(focusedCallId && searchCallIds.has(focusedCallId))
  const matchesPage = Boolean(focusedCallId && pageCallIds.has(focusedCallId))
  const [queriesOpen, setQueriesOpen] = useState(matchesSearch)
  const [pagesOpen, setPagesOpen] = useState(matchesPage)

  useEffect(() => {
    if (matchesSearch) {
      setQueriesOpen(true)
    }
    if (matchesPage) {
      setPagesOpen(true)
    }
  }, [focusedCallId, focusNonce, matchesSearch, matchesPage])

  return (
    <div className={styles.root}>
      {queries.length > 0 ? (
        <div className={styles.section}>
          <button
            type="button"
            className={styles.toggleHeader}
            aria-expanded={queriesOpen}
            onClick={() => setQueriesOpen((value) => !value)}
          >
            <span className={styles.header}>
              <IconSearchOutline16 />
              <span>{t('activityWebSearchTitle')}</span>
              <span className={styles.meta}>
                {t(
                  queries.length === 1 ? 'activityWebSearchCountOne' : 'activityWebSearchCountMany',
                  {
                    count: queries.length,
                  }
                )}
              </span>
            </span>
            <span className={styles.chevron} aria-hidden="true">
              {queriesOpen ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
            </span>
          </button>
          {queriesOpen ? (
            <div className={styles.queryList}>
              {queries.map(({ id, query }) => (
                <div key={id} className={styles.queryItem} data-activity-call-id={id}>
                  “{query}”
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {pages.length > 0 ? (
        <div className={styles.section}>
          <button
            type="button"
            className={styles.toggleHeader}
            aria-expanded={pagesOpen}
            onClick={() => setPagesOpen((value) => !value)}
          >
            <span className={styles.header}>
              <IconBrowseOutline16 />
              <span>{t('activityWebScrapeTitle')}</span>
              <span className={styles.meta}>{pages.length}</span>
            </span>
            <span className={styles.chevron} aria-hidden="true">
              {pagesOpen ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
            </span>
          </button>
          {pagesOpen ? (
            <div className={styles.pageList}>
              {pages.map((page) => {
                const domain = page.url ? getSiteName(page.url) : null
                return (
                  <div key={page.id} className={styles.pageItem} data-activity-call-id={page.id}>
                    {page.failed || !page.url ? (
                      <>
                        <span className={styles.pageFailed}>{page.title || page.url}</span>
                        <span className={styles.pageFailedMeta}>
                          {t('activityWebScrapeFailed')}
                        </span>
                      </>
                    ) : (
                      <a
                        className={styles.pageLink}
                        href={page.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => openLink(event, page.url)}
                      >
                        <span className={styles.pageLinkText}>{page.title || page.url}</span>
                        <IconRightUpOutline14 />
                      </a>
                    )}
                    {domain ? <div className={styles.pageSub}>{domain}</div> : null}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const webResearchPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming }) => {
    const running = !result || result.status === 'running'
    const failed = !running && result.status !== 'ok'
    if (call.name === 'web_scrape') {
      const page = pageOf(call, result)
      return {
        lane: 'research',
        icon: <IconGlobeLanguageOutline14 />,
        liveVerb: webResearchMessages.translate('activityWebScrapeWorking'),
        detail: page.title || page.url || undefined,
        stillRunning: running && streaming,
        failed,
        tally: {
          key: 'web-pages',
          count: 1,
          label: (count) =>
            webResearchMessages.translate(
              count === 1 ? 'activityWebPageCountOne' : 'activityWebPageCountMany',
              { count }
            ),
        },
      }
    }
    const query = queryOf(call, result)
    return {
      lane: 'research',
      icon: <IconSearchOutline16 />,
      liveVerb: webResearchMessages.translate('activityWebSearchWorking'),
      detail: query || undefined,
      stillRunning: running && streaming,
      failed,
      tally: {
        key: 'web-searches',
        count: 1,
        label: (count) =>
          webResearchMessages.translate(
            count === 1 ? 'activityWebSearchCountOne' : 'activityWebSearchCountMany',
            { count }
          ),
      },
    }
  },
  renderActivity: WebResearchActivityView,
}
