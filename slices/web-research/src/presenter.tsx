import type {
  ActivityStepDetailProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import {
  Banner,
  IconGlobeLanguageOutline14,
  IconOpenExternalOutline14,
  IconSearchOutline16,
} from '@deepseek-chat/lib-ui'
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

const WebResearchStepDetail = ({ entry, openLink }: ActivityStepDetailProps) => {
  const t = webResearchMessages.useTranslate()
  const { call, result } = entry
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')

  if (call.name === 'web_scrape') {
    const page = pageOf(call, result)
    const domain = page.url ? getSiteName(page.url) : null
    return (
      <div className={styles.detail}>
        {failed ? (
          <Banner tone="error" compact role="note">
            <div className={styles.errorText}>
              {result?.content?.trim() || t('activityWebScrapeFailed')}
            </div>
          </Banner>
        ) : null}
        {page.url ? (
          <div className={styles.pageItem}>
            <a
              className={styles.pageLink}
              href={page.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => openLink(event, page.url)}
            >
              <span className={styles.pageLinkText}>{page.title || page.url}</span>
              <span className={styles.linkIcon} aria-hidden="true">
                <IconOpenExternalOutline14 />
              </span>
            </a>
            {domain ? <div className={styles.pageSub}>{domain}</div> : null}
          </div>
        ) : null}
      </div>
    )
  }

  const query = queryOf(call, result)
  const sources = result?.sources ?? []
  return (
    <div className={styles.detail}>
      {query ? <div className={styles.queryItem}>“{query}”</div> : null}
      {failed && result?.content?.trim() ? (
        <Banner tone="error" compact role="note">
          <div className={styles.errorText}>{result.content.trim()}</div>
        </Banner>
      ) : null}
      {sources.length > 0 ? (
        <div className={styles.pageList}>
          {sources.slice(0, 6).map((source) => {
            const domain = source.siteName || getSiteName(source.url)
            return (
              <div key={source.url} className={styles.pageItem}>
                <a
                  className={styles.pageLink}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => openLink(event, source.url)}
                >
                  <span className={styles.pageLinkText}>{source.title || source.url}</span>
                  <span className={styles.linkIcon} aria-hidden="true">
                    <IconOpenExternalOutline14 />
                  </span>
                </a>
                {domain ? <div className={styles.pageSub}>{domain}</div> : null}
              </div>
            )
          })}
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
      const domain = page.url ? getSiteName(page.url) : null
      return {
        lane: 'research',
        icon: <IconGlobeLanguageOutline14 />,
        liveVerb: webResearchMessages.translate('activityWebScrapeWorking'),
        detail: page.title || page.url || undefined,
        ...(domain ? { meta: domain } : {}),
        hasDetail: Boolean(page.url || failed),
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
    const count = result?.sources?.length ?? 0
    return {
      lane: 'research',
      icon: <IconSearchOutline16 />,
      liveVerb: webResearchMessages.translate('activityWebSearchWorking'),
      detail: query || undefined,
      ...(count > 0
        ? {
            meta: webResearchMessages.translate(
              count === 1 ? 'activityWebResultsOne' : 'activityWebResultsMany',
              { count }
            ),
          }
        : {}),
      hasDetail: Boolean(query || count > 0 || failed),
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
  renderStepDetail: WebResearchStepDetail,
}
