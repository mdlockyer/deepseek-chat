import type { WebFetchToolResultBlock, WebSearchToolResultBlock } from '@deepseek-chat/lib-agent'
import type { ActivitySource, TurnBlock, TurnToolResultBlock } from './types.js'

const getSiteName = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export type ExtractedTurnSources = {
  readonly all: ActivitySource[]
  readonly cited: ActivitySource[]
  readonly other: ActivitySource[]
}

/**
 * Extracts all deduplicated numbered sources from a turn's blocks (both native DeepSeek server
 * search/fetch blocks and client `tool_result.sources`), then separates cited vs. uncited sources.
 */
export const extractTurnSources = (blocks: readonly TurnBlock[]): ExtractedTurnSources => {
  const serverResults = new Map<string, WebSearchToolResultBlock | WebFetchToolResultBlock>()
  const clientResults = new Map<string, TurnToolResultBlock>()
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      serverResults.set(block.tool_use_id, block)
    } else if (block.type === 'tool_result') {
      clientResults.set(block.tool_use_id, block)
    }
  }

  const byUrl = new Map<string, ActivitySource>()
  const all: ActivitySource[] = []
  const add = (
    url: string,
    title: string | null | undefined,
    publishedAt: string | null,
    meta?: { snippet?: string | null; siteName?: string | null; siteIcon?: string | null }
  ) => {
    const trimmed = url.trim()
    if (!trimmed) {
      return
    }
    const existing = byUrl.get(trimmed)
    if (existing) {
      return
    }
    const source: ActivitySource = {
      url: trimmed,
      title: title?.trim() || trimmed,
      siteName: meta?.siteName?.trim() || getSiteName(trimmed),
      publishedAt,
      snippet: meta?.snippet ?? null,
      siteIcon: meta?.siteIcon ?? null,
      index: all.length + 1,
    }
    byUrl.set(trimmed, source)
    all.push(source)
  }

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const result = clientResults.get(block.id)
      const list = result?.sources ?? result?.searchResults
      if (list) {
        for (const item of list) {
          add(item.url, item.title, item.publishedAt, {
            snippet: item.snippet,
            siteName: item.siteName,
          })
        }
      }
      if (result?.scrapedPage) {
        add(result.scrapedPage.url, result.scrapedPage.title, null)
      }
      continue
    }
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = serverResults.get(block.id)
    if (result?.type === 'web_search_tool_result') {
      for (const item of result.content) {
        if (item.type === 'web_search_result') {
          add(item.url, item.title, item.page_age, {
            snippet: item.snippet,
            siteName: item.site_name,
            siteIcon: item.site_icon ?? null,
          })
        }
      }
    } else if (
      result?.type === 'web_fetch_tool_result' &&
      result.content.type === 'web_fetch_result' &&
      block.kind === 'deep_search'
    ) {
      add(result.content.url, result.content.content.title, result.content.published_at)
    }
  }

  const citedIndexes: number[] = []
  const seenCited = new Set<number>()
  const noteCited = (index: number) => {
    if (index >= 1 && index <= all.length && !seenCited.has(index)) {
      seenCited.add(index)
      citedIndexes.push(index)
    }
  }

  for (const block of blocks) {
    if (block.type !== 'text' || block.isTemplate) {
      continue
    }
    for (const cite of block.citations ?? []) {
      const found = byUrl.get(cite.url)
      if (found) {
        noteCited(found.index)
      }
    }
    for (const match of block.text.matchAll(/\[(?:citation|ref):(\d+)\]/g)) {
      noteCited(Number(match[1]))
    }
  }

  const cited = citedIndexes
    .map((idx) => all[idx - 1])
    .filter((s): s is ActivitySource => Boolean(s))
  const other = all.filter((s) => !seenCited.has(s.index))
  return { all, cited, other }
}
