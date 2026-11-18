import { ApiError, DEFAULT_REST_TIMEOUT_MS, request } from './client.js'
import type { ClientTool } from './types.js'

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2'
const SEARCH_TIMEOUT_MS = 30_000
const SCRAPE_TIMEOUT_MS = 45_000
const MAX_TOOL_TEXT_CHARS = 24_000
const DEFAULT_SEARCH_LIMIT = 8

export const FIRECRAWL_SEARCH_TOOL_NAME = 'web_search'
export const FIRECRAWL_SCRAPE_TOOL_NAME = 'web_scrape'

export const FIRECRAWL_SEARCH_TOOL: ClientTool = {
  name: FIRECRAWL_SEARCH_TOOL_NAME,
  description:
    'Search the live web using Firecrawl and return ranked results with titles, URLs, and snippets. Follow up with web_scrape on promising URLs when full page details are needed.',
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query string.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Maximum number of results to return (default 8).',
      },
    },
  },
}

export const FIRECRAWL_SCRAPE_TOOL: ClientTool = {
  name: FIRECRAWL_SCRAPE_TOOL_NAME,
  description:
    'Fetch and extract clean markdown content from a specific http:// or https:// webpage URL using Firecrawl.',
  input_schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The http:// or https:// URL to read.' },
    },
  },
}

export type FirecrawlSearchSource = {
  url: string
  title: string
  snippet: string
  siteName: string | null
  publishedAt: string | null
}

export type FirecrawlSearchOutcome = {
  text: string
  sources: FirecrawlSearchSource[]
}

export type FirecrawlScrapeOutcome = {
  url: string
  title: string | null
  text: string
}

type RawSearchItem = {
  url?: unknown
  title?: unknown
  description?: unknown
  snippet?: unknown
  highlights?: unknown
  date?: unknown
}

type SearchApiResponse = {
  success?: unknown
  error?: unknown
  data?:
    | RawSearchItem[]
    | {
        web?: RawSearchItem[]
        news?: RawSearchItem[]
      }
}

type ScrapeApiResponse = {
  success?: unknown
  error?: unknown
  data?: {
    markdown?: unknown
    metadata?: {
      title?: unknown
      sourceURL?: unknown
      statusCode?: unknown
      error?: unknown
    }
  }
}

const isHttpUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const getSiteName = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

const firecrawlHeaders = (apiKey?: string | null): Record<string, string> => {
  const key = apiKey?.trim()
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  }
}

const formatFirecrawlError = (error: unknown, hasKey: boolean): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Firecrawl API key is invalid (HTTP 401). Update or remove it in Settings → API key.'
    }
    if (error.status === 429) {
      return hasKey
        ? 'Firecrawl rate or credit limit reached (HTTP 429). Please retry shortly or check your Firecrawl quota.'
        : 'Firecrawl keyless daily limit reached (HTTP 429). Add a free Firecrawl API key in Settings → API key for higher limits.'
    }
    return error.message || `Firecrawl request failed (${error.status ?? error.kind})`
  }
  return error instanceof Error ? error.message : String(error)
}

const truncate = (text: string, limit = MAX_TOOL_TEXT_CHARS): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[Truncated after ${limit.toLocaleString()} characters]`

const extractSnippet = (item: RawSearchItem): string => {
  if (typeof item.description === 'string' && item.description.trim()) {
    return item.description.trim()
  }
  if (typeof item.snippet === 'string' && item.snippet.trim()) {
    return item.snippet.trim()
  }
  if (Array.isArray(item.highlights)) {
    const joined = item.highlights
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join(' ')
      .trim()
    if (joined) {
      return joined
    }
  }
  return ''
}

const normalizeSearchItems = (payload: SearchApiResponse): FirecrawlSearchSource[] => {
  const rawList: RawSearchItem[] = Array.isArray(payload.data)
    ? payload.data
    : [
        ...(Array.isArray(payload.data?.web) ? payload.data.web : []),
        ...(Array.isArray(payload.data?.news) ? payload.data.news : []),
      ]
  const seen = new Set<string>()
  const sources: FirecrawlSearchSource[] = []
  for (const item of rawList) {
    if (typeof item?.url !== 'string' || !isHttpUrl(item.url) || seen.has(item.url)) {
      continue
    }
    seen.add(item.url)
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.url
    sources.push({
      url: item.url,
      title,
      snippet: extractSnippet(item),
      siteName: getSiteName(item.url),
      publishedAt: typeof item.date === 'string' && item.date.trim() ? item.date.trim() : null,
    })
  }
  return sources
}

/** 用 GET /v2/team/credit-usage 校验 Firecrawl API Key（不消耗额度） */
export const verifyFirecrawlApiKey = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<void> => {
  await request(
    `${FIRECRAWL_BASE_URL}/team/credit-usage`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal,
    },
    DEFAULT_REST_TIMEOUT_MS
  )
}

export const searchWithFirecrawl = async (
  query: string,
  options: {
    apiKey?: string | null
    limit?: number
    signal?: AbortSignal
    /** 同一回复内已编号的来源 URL → 编号，保证多次搜索时 [citation:N] 与前端编号一致 */
    existingSourceIndexes?: ReadonlyMap<string, number>
  } = {}
): Promise<FirecrawlSearchOutcome> => {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    throw new Error('Search query must not be empty.')
  }
  const hasKey = Boolean(options.apiKey?.trim())
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT), 1), 10)
  let response: Response
  try {
    response = await request(
      `${FIRECRAWL_BASE_URL}/search`,
      {
        method: 'POST',
        headers: firecrawlHeaders(options.apiKey),
        body: JSON.stringify({ query: trimmedQuery, limit }),
        signal: options.signal,
      },
      SEARCH_TIMEOUT_MS
    )
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    throw new Error(formatFirecrawlError(error, hasKey), { cause: error })
  }

  const payload = (await response.json()) as SearchApiResponse
  if (payload.success === false) {
    throw new Error(
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error
        : 'Firecrawl search failed.'
    )
  }

  const sources = normalizeSearchItems(payload)
  if (sources.length === 0) {
    return {
      text: `No search results found for "${trimmedQuery}".`,
      sources: [],
    }
  }

  let nextIndex = (options.existingSourceIndexes?.size ?? 0) + 1
  const lines = sources.map((source) => {
    const index = options.existingSourceIndexes?.get(source.url) ?? nextIndex++
    const parts = [`[${index}] ${source.title}`, `URL: ${source.url}`]
    if (source.snippet) {
      parts.push(`Snippet: ${source.snippet}`)
    }
    return parts.join('\n')
  })
  const text = truncate(
    `${lines.join('\n\n')}\n\nWhen referencing these sources in your answer, cite them inline using [citation:1], [citation:2], etc. matching the numbers above.`
  )
  return { text, sources }
}

export const scrapeWithFirecrawl = async (
  url: string,
  options: { apiKey?: string | null; signal?: AbortSignal } = {}
): Promise<FirecrawlScrapeOutcome> => {
  const trimmedUrl = url.trim()
  if (!isHttpUrl(trimmedUrl)) {
    throw new Error(`Invalid URL: ${url}. Only http:// and https:// URLs are supported.`)
  }
  const hasKey = Boolean(options.apiKey?.trim())
  let response: Response
  try {
    response = await request(
      `${FIRECRAWL_BASE_URL}/scrape`,
      {
        method: 'POST',
        headers: firecrawlHeaders(options.apiKey),
        body: JSON.stringify({
          url: trimmedUrl,
          formats: ['markdown'],
          onlyMainContent: true,
        }),
        signal: options.signal,
      },
      SCRAPE_TIMEOUT_MS
    )
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    throw new Error(formatFirecrawlError(error, hasKey), { cause: error })
  }

  const payload = (await response.json()) as ScrapeApiResponse
  if (payload.success === false) {
    throw new Error(
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error
        : 'Firecrawl scrape failed.'
    )
  }

  const data = payload.data
  const metadata = data?.metadata
  const finalUrl =
    typeof metadata?.sourceURL === 'string' && isHttpUrl(metadata.sourceURL)
      ? metadata.sourceURL
      : trimmedUrl
  const title =
    typeof metadata?.title === 'string' && metadata.title.trim() ? metadata.title.trim() : null
  const markdown = typeof data?.markdown === 'string' ? data.markdown.trim() : ''
  const statusCode = typeof metadata?.statusCode === 'number' ? metadata.statusCode : 200
  if (!markdown && statusCode >= 400) {
    const detail =
      typeof metadata?.error === 'string' && metadata.error.trim() ? ` (${metadata.error})` : ''
    throw new Error(`Page returned HTTP ${statusCode}${detail}.`)
  }

  const header = [title ? `Title: ${title}` : null, `URL: ${finalUrl}`].filter(Boolean).join('\n')
  const body = markdown || '[No readable text content extracted from this page.]'
  return {
    url: finalUrl,
    title,
    text: truncate(`${header}\n\n${body}`),
  }
}
