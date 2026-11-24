import type { HttpFetch } from '@deepseek-chat/spine/ports'

/** Firecrawl v2 client. Behaviour is specified in ../SPEC.md. */

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2'

export type FirecrawlParams = {
  searchTimeoutMs: number
  scrapeTimeoutMs: number
  verifyTimeoutMs: number
  maxToolTextChars: number
  defaultSearchLimit: number
  /** Sliding window length for rate limiting (ms). */
  rateWindowMs: number
  /** Requests per window when running keyless. */
  keylessRatePerMinute: number
  /** Requests per window when a Firecrawl key is set. */
  keyedRatePerMinute: number
  /** Maximum simultaneous in-flight Firecrawl requests across all callers. */
  maxConcurrentRequests: number
  /** Maximum simultaneous in-flight local `web_scrape` calls across all callers. */
  maxLocalScrapeConcurrency: number
  /** Base backoff applied after HTTP 429 (ms; doubles on subsequent retries). */
  backoff429Ms: number
  /** Maximum automatic retries for transient keyed HTTP 429 responses. */
  max429Retries: number
  /** Maximum Firecrawl credits spent within one reply (0 = unlimited). */
  maxCreditsPerReply: number
  /** Maximum model rounds for a `research` subagent. */
  researchMaxRounds: number
  /** Maximum tool calls for a `research` subagent. */
  researchMaxToolCalls: number
}

export const DEFAULT_FIRECRAWL_PARAMS: FirecrawlParams = {
  searchTimeoutMs: 30_000,
  scrapeTimeoutMs: 45_000,
  verifyTimeoutMs: 15_000,
  maxToolTextChars: 24_000,
  defaultSearchLimit: 8,
  rateWindowMs: 60_000,
  keylessRatePerMinute: 10,
  keyedRatePerMinute: 20,
  maxConcurrentRequests: 3,
  maxLocalScrapeConcurrency: 6,
  backoff429Ms: 2_000,
  max429Retries: 3,
  maxCreditsPerReply: 120,
  researchMaxRounds: 12,
  researchMaxToolCalls: 16,
}

export type WebAudience = 'reply' | 'agent'

export type WebSearchSource = {
  url: string
  title: string
  snippet: string
  siteName: string | null
  publishedAt: string | null
}

export type SearchOutcome = { text: string; sources: WebSearchSource[] }

export type ScrapeOutcome = { url: string; title: string | null; text: string; markdown: string }

export type KeyVerification =
  | { kind: 'valid' }
  | { kind: 'invalid' }
  | { kind: 'unreachable' }
  | { kind: 'failed'; message: string }

/** Why a request did not produce a 2xx response. */
type RequestFailure =
  | { kind: 'http'; status: number; message: string; retryAfterMs?: number }
  | { kind: 'network'; message: string }
  | { kind: 'timeout'; timeoutMs: number }

class FirecrawlRequestError extends Error {
  readonly failure: RequestFailure

  constructor(failure: RequestFailure) {
    super(
      failure.kind === 'timeout'
        ? `Firecrawl request timed out after ${failure.timeoutMs / 1000} s.`
        : failure.message
    )
    this.name = 'FirecrawlRequestError'
    this.failure = failure
  }
}

const PERMANENT_429_RE =
  /\b(insufficient\s+credits?|out\s+of\s+credits?|credit\s+limit|credits?\s+exhausted|monthly\s+limit|payment\s+required)\b/i

const parseRetryAfterMs = (header: string | null): number | undefined => {
  if (!header) {
    return undefined
  }
  const trimmed = header.trim()
  if (!trimmed) {
    return undefined
  }
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now())
  }
  return undefined
}

const unwrapFirecrawlError = (error: unknown): FirecrawlRequestError | null => {
  if (error instanceof FirecrawlRequestError) {
    return error
  }
  if (error instanceof Error && error.cause instanceof FirecrawlRequestError) {
    return error.cause
  }
  return null
}

/**
 * Returns the backoff delay (ms) if `error` is a transient keyed HTTP 429 worth retrying,
 * or `null` if the failure should be surfaced immediately (keyless daily cap, exhausted credits,
 * or non-429 error).
 */
export const getRetryable429DelayMs = (
  error: unknown,
  hasKey: boolean,
  attempt: number,
  params: Pick<FirecrawlParams, 'backoff429Ms' | 'rateWindowMs'>
): number | null => {
  if (!hasKey) {
    return null
  }
  const fcError = unwrapFirecrawlError(error)
  if (!fcError || fcError.failure.kind !== 'http' || fcError.failure.status !== 429) {
    return null
  }
  if (PERMANENT_429_RE.test(fcError.failure.message)) {
    return null
  }
  const cap = Math.max(0, params.rateWindowMs)
  if (fcError.failure.retryAfterMs !== undefined) {
    return Math.min(cap, Math.max(0, fcError.failure.retryAfterMs))
  }
  const exp = Math.max(0, params.backoff429Ms) * 2 ** Math.max(0, attempt)
  return Math.min(cap, exp)
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

export const isHttpUrl = (value: string): boolean => {
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

const extractErrorMessage = (text: string): string | null => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null
  }
  const { error } = body as { error?: unknown }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message?: unknown }
    return typeof message === 'string' ? message : null
  }
  return null
}

/**
 * Sends a request with a timeout. Resolves only for 2xx; otherwise throws FirecrawlRequestError.
 * If the caller's signal aborts, the abort error propagates unchanged.
 */
const request = async (
  fetch: HttpFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController()
  const external = init.signal ?? undefined
  const onExternalAbort = () => controller.abort(external?.reason)
  if (external?.aborted) {
    controller.abort(external.reason)
  } else {
    external?.addEventListener('abort', onExternalAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (external?.aborted) {
      throw error
    }
    if (timedOut) {
      throw new FirecrawlRequestError({ kind: 'timeout', timeoutMs })
    }
    throw new FirecrawlRequestError({
      kind: 'network',
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    throw new FirecrawlRequestError({
      kind: 'http',
      status: response.status,
      message: extractErrorMessage(text) ?? (text || response.statusText),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })
  }
  return response
}

export const describeFirecrawlFailure = (
  error: unknown,
  hasKey: boolean,
  audience: WebAudience = 'reply'
): string => {
  const fcError = unwrapFirecrawlError(error)
  if (!fcError) {
    return error instanceof Error ? error.message : String(error)
  }
  const { failure } = fcError
  if (failure.kind === 'http' && failure.status === 401) {
    return audience === 'agent'
      ? 'Firecrawl authentication failed (HTTP 401). Stop trying Firecrawl and finish with what you already have.'
      : 'Firecrawl API key is invalid (HTTP 401). Update or remove it in Settings → API key.'
  }
  if (failure.kind === 'http' && failure.status === 429) {
    if (audience === 'agent') {
      return hasKey
        ? 'Firecrawl rate or credit limit reached (HTTP 429). Finish with what you have or move on to another source.'
        : 'Firecrawl keyless daily limit reached (HTTP 429). Finish with what you already have.'
    }
    return hasKey
      ? 'Firecrawl rate or credit limit reached (HTTP 429). Please retry shortly or check your Firecrawl quota.'
      : 'Firecrawl keyless daily limit reached (HTTP 429). Add a free Firecrawl API key in Settings → API key for higher limits.'
  }
  if (failure.kind === 'http') {
    return failure.message || `Firecrawl request failed (HTTP ${failure.status})`
  }
  return fcError.message || 'Firecrawl request failed (network)'
}

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

const normalizeSearchItems = (payload: SearchApiResponse): WebSearchSource[] => {
  const rawList: RawSearchItem[] = Array.isArray(payload.data)
    ? payload.data
    : [
        ...(Array.isArray(payload.data?.web) ? payload.data.web : []),
        ...(Array.isArray(payload.data?.news) ? payload.data.news : []),
      ]
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
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

export const truncateToolText = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[Truncated after ${limit.toLocaleString('en-US')} characters]`

export const formatScrapeOutcome = (input: {
  url: string
  title: string | null
  markdown: string
  maxToolTextChars: number
}): ScrapeOutcome => {
  const title = input.title?.trim() ? input.title.trim() : null
  const markdown = input.markdown.trim()
  const header = [title ? `Title: ${title}` : null, `URL: ${input.url}`].filter(Boolean).join('\n')
  const body = markdown || '[No readable text content extracted from this page.]'
  return {
    url: input.url,
    title,
    text: truncateToolText(`${header}\n\n${body}`, input.maxToolTextChars),
    markdown,
  }
}

export const createFirecrawlClient = (
  fetch: HttpFetch,
  params: FirecrawlParams,
  hooks?: { onRateLimited?: () => void }
) => {
  const headers = (apiKey: string | null): Record<string, string> => {
    const key = apiKey?.trim()
    return {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    }
  }

  const truncate = (text: string): string => truncateToolText(text, params.maxToolTextChars)

  /** GET /v2/team/credit-usage spends no credits. */
  const verifyKey = async (apiKey: string, signal?: AbortSignal): Promise<KeyVerification> => {
    try {
      await request(
        fetch,
        `${FIRECRAWL_BASE_URL}/team/credit-usage`,
        { method: 'GET', headers: { Authorization: `Bearer ${apiKey.trim()}` }, signal },
        params.verifyTimeoutMs
      )
      return { kind: 'valid' }
    } catch (error) {
      if (!(error instanceof FirecrawlRequestError)) {
        throw error
      }
      const { failure } = error
      if (failure.kind === 'http' && failure.status === 401) {
        return { kind: 'invalid' }
      }
      if (failure.kind !== 'http') {
        return { kind: 'unreachable' }
      }
      return { kind: 'failed', message: error.message }
    }
  }

  const search = async (
    query: string,
    options: {
      apiKey: string | null
      limit?: number
      signal: AbortSignal
      citedUrls?: ReadonlyMap<string, number>
      audience?: WebAudience
    }
  ): Promise<SearchOutcome> => {
    const audience = options.audience ?? 'reply'
    const trimmedQuery = query.trim()
    const hasKey = Boolean(options.apiKey?.trim())
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? params.defaultSearchLimit), 1), 10)
    let response: Response
    try {
      response = await request(
        fetch,
        `${FIRECRAWL_BASE_URL}/search`,
        {
          method: 'POST',
          headers: headers(options.apiKey),
          body: JSON.stringify({ query: trimmedQuery, limit }),
          signal: options.signal,
        },
        params.searchTimeoutMs
      )
    } catch (error) {
      if (options.signal.aborted) {
        throw error
      }
      if (
        error instanceof FirecrawlRequestError &&
        error.failure.kind === 'http' &&
        error.failure.status === 429
      ) {
        hooks?.onRateLimited?.()
      }
      throw new Error(describeFirecrawlFailure(error, hasKey, audience), { cause: error })
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
      return { text: `No search results found for "${trimmedQuery}".`, sources: [] }
    }

    let nextIndex = (options.citedUrls?.size ?? 0) + 1
    const lines = sources.map((source) => {
      const index = options.citedUrls?.get(source.url) ?? nextIndex++
      const parts = [`[${index}] ${source.title}`, `URL: ${source.url}`]
      if (source.snippet) {
        parts.push(`Snippet: ${source.snippet}`)
      }
      return parts.join('\n')
    })
    const body =
      audience === 'agent'
        ? lines.join('\n\n')
        : `${lines.join('\n\n')}\n\nWhen referencing these sources in your answer, cite them inline using [ref:1], [ref:2], etc. matching the numbers above, placed directly before punctuation with no leading space (for example: "Revenue grew 40%[ref:1].").`
    const text = truncate(body)
    return { text, sources }
  }

  const scrape = async (
    url: string,
    options: { apiKey: string | null; signal: AbortSignal; audience?: WebAudience }
  ): Promise<ScrapeOutcome> => {
    const audience = options.audience ?? 'reply'
    const trimmedUrl = url.trim()
    if (!isHttpUrl(trimmedUrl)) {
      throw new Error(`Invalid URL: ${url}. Only http:// and https:// URLs are supported.`)
    }
    const hasKey = Boolean(options.apiKey?.trim())
    let response: Response
    try {
      response = await request(
        fetch,
        `${FIRECRAWL_BASE_URL}/scrape`,
        {
          method: 'POST',
          headers: headers(options.apiKey),
          body: JSON.stringify({ url: trimmedUrl, formats: ['markdown'], onlyMainContent: true }),
          signal: options.signal,
        },
        params.scrapeTimeoutMs
      )
    } catch (error) {
      if (options.signal.aborted) {
        throw error
      }
      if (
        error instanceof FirecrawlRequestError &&
        error.failure.kind === 'http' &&
        error.failure.status === 429
      ) {
        hooks?.onRateLimited?.()
      }
      throw new Error(describeFirecrawlFailure(error, hasKey, audience), { cause: error })
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

    return formatScrapeOutcome({
      url: finalUrl,
      title,
      markdown,
      maxToolTextChars: params.maxToolTextChars,
    })
  }

  return { verifyKey, search, scrape }
}
