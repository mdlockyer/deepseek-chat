import type { AgentSource } from './tools.js'
import type { ReplyBlock, WebSearchSourceMeta } from './types.js'

const getSiteName = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/**
 * Collects every cited URL already assigned in a reply, in the exact order `buildReplyView`
 * registers them in `SourceRegistry`. This is the single source of truth for reply citation numbers.
 */
export const collectCitedUrls = (blocks: readonly ReplyBlock[]): Map<string, number> => {
  const results = new Map<
    string,
    Extract<ReplyBlock, { type: 'web_search_tool_result' | 'web_fetch_tool_result' }>
  >()
  const toolResults = new Map<string, Extract<ReplyBlock, { type: 'tool_result' }>>()
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      results.set(block.tool_use_id, block)
    } else if (block.type === 'tool_result') {
      toolResults.set(block.tool_use_id, block)
    }
  }

  const cited = new Map<string, number>()
  const addUrl = (url: string) => {
    if (url && !cited.has(url)) {
      cited.set(url, cited.size + 1)
    }
  }

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const result = toolResults.get(block.id)
      if (!result) {
        continue
      }
      for (const item of result.searchResults ?? []) {
        addUrl(item.url)
      }
      if (result.scrapedPage) {
        addUrl(result.scrapedPage.url)
      }
      continue
    }
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = results.get(block.id)
    if (result?.type === 'web_search_tool_result') {
      for (const item of result.content) {
        if (item.type === 'web_search_result') {
          addUrl(item.url)
        }
      }
    } else if (
      result?.type === 'web_fetch_tool_result' &&
      result.content.type === 'web_fetch_result' &&
      block.kind === 'deep_search'
    ) {
      addUrl(result.content.url)
    }
  }

  return cited
}

export type NumberedChildResult = {
  /** Child's answer with `[n]` markers rewritten to `[ref:M]`, followed by a source ledger. */
  content: string
  /** Sources in assigned order, ready to store on `wait`'s `tool_result.searchResults`. */
  searchResults: WebSearchSourceMeta[]
  /** Updated citation map including any newly numbered URLs. */
  citedUrls: Map<string, number>
}

/**
 * Assigns reply-wide citation numbers to a child's sources, continuing from `existingCitedUrls`
 * without gaps, and rewrites the child's `[n]` citations to `[ref:M]`.
 */
export const assignChildCitations = (
  content: string,
  sources: readonly AgentSource[],
  existingCitedUrls: ReadonlyMap<string, number>
): NumberedChildResult => {
  const citedUrls = new Map(existingCitedUrls)
  const localToGlobal = new Map<number, number>()
  const numberedSources: Array<{
    globalN: number
    source: AgentSource
  }> = []
  const ledgerByGlobalN = new Map<number, number>()
  const searchResults: WebSearchSourceMeta[] = []
  const addedUrls = new Set<string>()

  for (const source of sources) {
    const url = source.url.trim()
    if (!url) {
      continue
    }
    let globalN = citedUrls.get(url)
    if (globalN === undefined) {
      globalN = citedUrls.size + 1
      citedUrls.set(url, globalN)
    }
    localToGlobal.set(source.n, globalN)
    const existingIdx = ledgerByGlobalN.get(globalN)
    if (existingIdx === undefined) {
      ledgerByGlobalN.set(globalN, numberedSources.length)
      numberedSources.push({ globalN, source })
    } else if (
      source.verification === 'verified' &&
      numberedSources[existingIdx]?.source.verification !== 'verified'
    ) {
      numberedSources[existingIdx] = { globalN, source }
    }
    if (!addedUrls.has(url)) {
      addedUrls.add(url)
      searchResults.push({
        url,
        title: source.title.trim() || url,
        snippet: '',
        siteName: getSiteName(url),
        publishedAt: null,
      })
    }
  }

  // Single-pass rewrite so remapped numbers never collide with later source numbers,
  // and markdown links `[1](url)` stay untouched. Uses `[ref:M]` so DeepSeek's server-side
  // `[citation:M]` parser never strips client-side citations from `text_delta`.
  const rewritten =
    localToGlobal.size > 0
      ? content.replace(/\[(?:(?:citation|ref):)?(\d+)\](?!\()/g, (match, rawNum: string) => {
          const mapped = localToGlobal.get(Number(rawNum))
          return mapped !== undefined ? `[ref:${mapped}]` : match
        })
      : content

  if (numberedSources.length === 0) {
    return { content: rewritten, searchResults, citedUrls }
  }

  const ledger = numberedSources
    .map(
      ({ globalN, source }) =>
        `[ref:${globalN}] ${source.title.trim() || source.url} — ${source.url} (${source.verification})`
    )
    .join('\n')

  return {
    content: `${rewritten}\n\nSources:\n${ledger}`,
    searchResults,
    citedUrls,
  }
}

/**
 * Rewrites `[n] <title>\nURL: <url>` headers in a `web_search` tool result so every result carries
 * its true reply-wide citation index in call order, advancing `citedUrls` in place.
 * Eliminates colliding numbers when multiple `web_search` / `web_scrape` calls run concurrently.
 */
export const renumberSearchResultContent = (
  content: string,
  searchResults: readonly WebSearchSourceMeta[],
  citedUrls: Map<string, number>
): string => {
  if (searchResults.length === 0) {
    return content
  }
  const urlToIndex = new Map<string, number>()
  for (const item of searchResults) {
    const url = item.url.trim()
    if (!url) {
      continue
    }
    let index = citedUrls.get(url)
    if (index === undefined) {
      index = citedUrls.size + 1
      citedUrls.set(url, index)
    }
    urlToIndex.set(url, index)
  }
  if (urlToIndex.size === 0) {
    return content
  }
  return content.replace(
    /^\[(\d+)\]( [^\n]*\nURL: (\S+))/gm,
    (match, _old: string, rest: string, url: string) => {
      const next = urlToIndex.get(url.trim())
      return next !== undefined ? `[${next}]${rest}` : match
    }
  )
}
