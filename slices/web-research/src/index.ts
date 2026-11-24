import type { HttpFetch, KeyValueStore, SecretSlot } from '@deepseek-chat/spine/ports'
import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import {
  DEFAULT_FIRECRAWL_PARAMS,
  createFirecrawlClient,
  describeFirecrawlFailure,
  formatScrapeOutcome,
  getRetryable429DelayMs,
  isHttpUrl,
  type FirecrawlParams,
  type KeyVerification,
  type ScrapeOutcome,
  type WebAudience,
  type WebSearchSource,
} from './firecrawl.js'
import { createKeyStore, type FirecrawlKeyState } from './key.js'
import { KeySettings, createUseKeyEditor, type KeyEditor } from './KeySettings.js'
import {
  SCRAPE_CREDITS,
  createConcurrencyGate,
  createFirecrawlLimiter,
  searchCredits,
} from './limiter.js'
import {
  RESEARCH_TOOL,
  RESEARCH_TOOL_NAME,
  buildAgentWebInstructions,
  buildLeadResearchInstructions,
  createPageCache,
  createResearchProfile,
  type ResearchProfile,
} from './researchProfile.js'

export type { FirecrawlParams, KeyVerification, WebAudience, WebSearchSource } from './firecrawl.js'
export type { FirecrawlKeyState } from './key.js'
export type { KeyEditor } from './KeySettings.js'
export {
  FINISH_RESEARCH_TOOL_NAME,
  RESEARCH_TOOL_NAME,
  type ResearchProfile,
  type ResearchSource,
} from './researchProfile.js'

export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const WEB_SCRAPE_TOOL_NAME = 'web_scrape'

/** Who invoked a web tool call: the lead reply or a child subagent. */
export type WebCaller = { kind: 'reply' } | { kind: 'agent'; profile: string; runId: string }

/** Model-visible client tool definition (client tools carry no `type` field). */
export type WebToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export type WebToolResult = {
  readonly status: 'ok' | 'error' | 'aborted'
  /** Text returned to the model. */
  readonly content: string
  /** Successful search: the sources, numbered in the content. */
  readonly searchResults?: WebSearchSource[]
  /** Successful scrape: the page actually read. */
  readonly scrapedPage?: { url: string; title: string | null }
}

export type WebRunOptions = {
  readonly signal: AbortSignal
  /** Raw JSON of the tool input, quoted back in invalid-input errors. */
  readonly inputJson?: string
  /** URL → citation number already used earlier in the same reply. */
  readonly citedUrls?: ReadonlyMap<string, number>
  /** Caller provenance: affects result wording and per-run quote cache. */
  readonly caller?: WebCaller
  /** Identifier for the reply, used to enforce the per-reply Firecrawl credit budget and scrape cache. */
  readonly replyKey?: string
}

export type LocalScrapeResult = {
  /** Final URL after redirects (http/https). */
  readonly url: string
  /** Extracted page title, if any. */
  readonly title: string | null
  /** Main page content as Markdown. */
  readonly markdown: string
  /** How the page was fetched/extracted. */
  readonly source: 'markdown-negotiated' | 'http' | 'pdf' | 'webview'
}

export type LocalScraper = (
  url: string,
  options: { signal: AbortSignal; timeoutMs: number }
) => Promise<LocalScrapeResult>

export type WebResearchDeps = {
  readonly fetch: HttpFetch
  /** Web storage for the user's optional Firecrawl key. */
  readonly store: KeyValueStore
  /** Desktop private storage; `null` keeps the key in web storage. */
  readonly secret: SecretSlot | null
  /** Optional local desktop scraper for `web_scrape`; `null` or omitted uses Firecrawl. */
  readonly localScrape?: LocalScraper | null
  readonly params?: Partial<FirecrawlParams>
}

export type WebResearchSlice = {
  readonly toolNames: {
    readonly search: string
    readonly scrape: string
    readonly research: string
  }
  /** Default lead-audience prompt section (for backwards compatibility). */
  readonly instructions: string
  /** Prompt section worded for `audience` (`reply` or `agent`) and the declared tool names. */
  instructionsFor(audience: WebAudience, declaredNames?: ReadonlySet<string>): string
  /** Deep research subagent profile owned by this slice. */
  readonly researchProfile: ResearchProfile
  declareTools(turn: { searchEnabled: boolean; questionText: string }): WebToolDefinition[]
  handles(toolName: string): boolean
  run(toolName: string, input: unknown, options: WebRunOptions): Promise<WebToolResult>
  verifyKey(apiKey: string, signal?: AbortSignal): Promise<KeyVerification>
  /** The user's Firecrawl key (null: keyless tier, or still loading on desktop). */
  getApiKey(): string | null
  getKeyState(): FirecrawlKeyState
  useKeyState(): FirecrawlKeyState
  /** Desktop: read the key (migrating a legacy web-storage copy). Never rejects. */
  hydrate(): Promise<void>
  /** Save (trimmed) or remove the key; rejects if desktop storage cannot be written. */
  setApiKey(apiKey: string | null): Promise<void>
  useKeyEditor(): KeyEditor
  KeySettings: ComponentType<{ editor: KeyEditor }>
}

const buildSearchTool = (params: FirecrawlParams): WebToolDefinition => ({
  name: WEB_SEARCH_TOOL_NAME,
  description: `Search the live web using Firecrawl and return ranked results with titles, URLs, and snippets. Follow up with web_scrape on promising URLs when full page details are needed.`,
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query string.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: `Maximum number of results to return (default ${params.defaultSearchLimit}).`,
      },
    },
  },
})

const buildScrapeTool = (hasLocalScrape: boolean): WebToolDefinition => ({
  name: WEB_SCRAPE_TOOL_NAME,
  description: hasLocalScrape
    ? 'Fetch and extract clean Markdown content from a specific public http:// or https:// webpage or text-based PDF URL locally on this machine.'
    : 'Fetch and extract clean markdown content from a specific http:// or https:// webpage URL using Firecrawl.',
  input_schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The http:// or https:// URL to read.' },
    },
  },
})

const buildReplyWebInstructions = (includeResearch: boolean, hasLocalScrape: boolean): string => {
  const base = [
    'Web Research (`web_search`, `web_scrape`):',
    hasLocalScrape
      ? 'You have fast headless web tools: `web_search` searches the live web via Firecrawl, while `web_scrape` fetches and converts public webpages and text-based PDFs into clean Markdown locally on this machine (using no Firecrawl credits, with an isolated offscreen render fallback for JavaScript-heavy pages; private, localhost, and link-local/metadata network addresses are blocked by design for SSRF safety). Reach for `web_search` and `web_scrape` when you need current facts, documentation, papers, or clean Markdown from a URL; they are much faster and lighter than driving the built-in browser. Save the built-in browser for interactive flows, logged-in sessions, localhost apps, or visual inspection.'
      : 'You have fast headless web tools powered by Firecrawl. Reach for `web_search` and `web_scrape` when you need current facts, documentation, or clean Markdown from a URL; they are much faster and lighter than driving the built-in browser. Save the built-in browser for interactive flows, logged-in sessions, JavaScript-heavy apps, or visual inspection.',
    'When citing `web_search` results in your chat reply, place inline markers like `[citation:1]`, `[citation:2]` matching the 1-based result numbers returned by `web_search`. The app renders them as clickable source links and populates the Search Results panel. (Files presented with `present_file` render standalone Markdown and do not resolve `[citation:n]`, so use regular `[title](url)` links inside files and `[citation:n]` in your chat reply.)',
  ].join('\n')
  return includeResearch ? `${base}\n\n${buildLeadResearchInstructions(hasLocalScrape)}` : base
}

const containsHttpUrl = (text: string) => /https?:\/\/\S+/i.test(text)

const ABORTED: WebToolResult = { status: 'aborted', content: 'Aborted by user.' }

/** Bound retained per-reply scrape caches so long sessions do not grow unbounded. */
const MAX_CACHED_REPLIES = 8

type InFlightScrape = {
  readonly promise: Promise<ScrapeOutcome>
  readonly controller: AbortController
  waiters: number
}

type ReplyScrapeCache = {
  readonly completed: Map<string, ScrapeOutcome>
  readonly inFlight: Map<string, InFlightScrape>
}

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export const createWebResearchSlice = (deps: WebResearchDeps): WebResearchSlice => {
  const params: FirecrawlParams = { ...DEFAULT_FIRECRAWL_PARAMS, ...deps.params }
  const localScrape = deps.localScrape ?? null
  const hasLocalScrape = localScrape !== null
  const limiter = createFirecrawlLimiter({
    rateWindowMs: params.rateWindowMs,
    keylessRatePerMinute: params.keylessRatePerMinute,
    keyedRatePerMinute: params.keyedRatePerMinute,
    maxConcurrentRequests: params.maxConcurrentRequests,
    backoff429Ms: params.backoff429Ms,
    maxCreditsPerReply: params.maxCreditsPerReply,
  })
  const localScrapeGate = createConcurrencyGate(params.maxLocalScrapeConcurrency)
  const client = createFirecrawlClient(deps.fetch, params, {
    onRateLimited: () => limiter.noteRateLimited(),
  })
  const keys = createKeyStore({ store: deps.store, secret: deps.secret })
  const pageCache = createPageCache()
  const replyScrapes = new Map<string, ReplyScrapeCache>()
  const searchTool = buildSearchTool(params)
  const scrapeTool = buildScrapeTool(hasLocalScrape)
  const toolNames = {
    search: WEB_SEARCH_TOOL_NAME,
    scrape: WEB_SCRAPE_TOOL_NAME,
    research: RESEARCH_TOOL_NAME,
  } as const
  const researchProfile = createResearchProfile(params, pageCache, toolNames)

  const getReplyScrapeCache = (replyKey: string): ReplyScrapeCache => {
    const existing = replyScrapes.get(replyKey)
    if (existing) {
      return existing
    }
    while (replyScrapes.size >= MAX_CACHED_REPLIES) {
      const oldest = replyScrapes.keys().next().value
      if (oldest === undefined) {
        break
      }
      replyScrapes.delete(oldest)
    }
    const created: ReplyScrapeCache = { completed: new Map(), inFlight: new Map() }
    replyScrapes.set(replyKey, created)
    return created
  }

  const invalidInput = (expected: string, input: unknown, inputJson?: string): WebToolResult => ({
    status: 'error',
    content: `Invalid input: expected ${expected}, got ${inputJson ?? JSON.stringify(input)}`,
  })

  const failed = (
    error: unknown,
    signal: AbortSignal,
    hasKey: boolean,
    audience: WebAudience
  ): WebToolResult =>
    signal.aborted
      ? ABORTED
      : { status: 'error', content: describeFirecrawlFailure(error, hasKey, audience) }

  /**
   * Reserves per-reply credits once, acquires rate + concurrency slots, and automatically retries
   * transient keyed HTTP 429s with escalating backoff (refunding credits if the call still fails).
   */
  const runWithRateLimitAndRetry = async <T>(opts: {
    hasKey: boolean
    credits: number
    replyKey?: string
    signal: AbortSignal
    execute: (signal: AbortSignal) => Promise<T>
  }): Promise<
    | { ok: true; value: T }
    | { ok: false; kind: 'budget'; message: string }
    | { ok: false; kind: 'error'; error: unknown }
  > => {
    const budget = limiter.reserveCredits(opts.replyKey, opts.credits)
    if (!budget.ok) {
      return { ok: false, kind: 'budget', message: budget.message }
    }
    const maxRetries = Math.max(0, Math.trunc(params.max429Retries))
    for (let attempt = 0; ; attempt += 1) {
      let lease: { release(): void }
      try {
        lease = await limiter.acquireSlot({ hasKey: opts.hasKey, signal: opts.signal })
      } catch (error) {
        budget.reservation.refund()
        return { ok: false, kind: 'error', error }
      }
      try {
        const value = await opts.execute(opts.signal)
        return { ok: true, value }
      } catch (error) {
        if (opts.signal.aborted) {
          budget.reservation.refund()
          return { ok: false, kind: 'error', error }
        }
        const retryDelayMs =
          attempt < maxRetries ? getRetryable429DelayMs(error, opts.hasKey, attempt, params) : null
        if (retryDelayMs !== null) {
          limiter.noteRateLimited(retryDelayMs)
          continue
        }
        budget.reservation.refund()
        return { ok: false, kind: 'error', error }
      } finally {
        lease.release()
      }
    }
  }

  const runSearch = async (input: unknown, options: WebRunOptions): Promise<WebToolResult> => {
    const raw =
      input && typeof input === 'object' ? (input as { query?: unknown; limit?: unknown }) : null
    const query = typeof raw?.query === 'string' ? raw.query : ''
    if (!query.trim()) {
      return invalidInput('{"query": string}', input, options.inputJson)
    }
    const apiKey = keys.getApiKey()
    const hasKey = Boolean(apiKey?.trim())
    const limit = Math.min(
      Math.max(
        Math.trunc(typeof raw?.limit === 'number' ? raw.limit : params.defaultSearchLimit),
        1
      ),
      10
    )
    const audience: WebAudience = options.caller?.kind === 'agent' ? 'agent' : 'reply'
    const outcome = await runWithRateLimitAndRetry({
      hasKey,
      credits: searchCredits(limit),
      replyKey: options.replyKey,
      signal: options.signal,
      execute: (signal) =>
        client.search(query, {
          apiKey,
          signal,
          limit,
          audience,
          ...(audience === 'reply' && options.citedUrls ? { citedUrls: options.citedUrls } : {}),
        }),
    })
    if (!outcome.ok) {
      return outcome.kind === 'budget'
        ? { status: 'error', content: outcome.message }
        : failed(outcome.error, options.signal, hasKey, audience)
    }
    return { status: 'ok', content: outcome.value.text, searchResults: outcome.value.sources }
  }

  const recordAgentPage = (
    caller: WebCaller | undefined,
    requestedUrl: string,
    outcome: ScrapeOutcome
  ) => {
    if (caller?.kind === 'agent') {
      pageCache.record(caller.runId, [requestedUrl, outcome.url], outcome.markdown, outcome.title)
    }
  }

  const runScrape = async (input: unknown, options: WebRunOptions): Promise<WebToolResult> => {
    const url =
      input && typeof (input as { url?: unknown }).url === 'string'
        ? (input as { url: string }).url
        : null
    if (url === null || !url.trim()) {
      return invalidInput('{"url": string}', input, options.inputJson)
    }
    const apiKey = keys.getApiKey()
    const hasKey = Boolean(apiKey?.trim())
    const audience: WebAudience = options.caller?.kind === 'agent' ? 'agent' : 'reply'

    // Validate URL before checking cache or acquiring limiter slot / spending credits.
    const trimmed = url.trim()
    let isHttp = false
    try {
      const proto = new URL(trimmed).protocol
      isHttp = proto === 'http:' || proto === 'https:'
    } catch {
      isHttp = false
    }
    if (!isHttp) {
      return {
        status: 'error',
        content: `Invalid URL: ${url}. Only http:// and https:// URLs are supported.`,
      }
    }

    const cache = options.replyKey ? getReplyScrapeCache(options.replyKey) : null
    const cached = cache?.completed.get(trimmed)
    if (cached) {
      recordAgentPage(options.caller, trimmed, cached)
      return {
        status: 'ok',
        content: cached.text,
        scrapedPage: { url: cached.url, title: cached.title },
      }
    }

    const executeScrape = async (signal: AbortSignal): Promise<ScrapeOutcome> => {
      if (localScrape) {
        const lease = await localScrapeGate.acquire(signal)
        try {
          const result = await localScrape(trimmed, {
            signal,
            timeoutMs: params.scrapeTimeoutMs,
          })
          const finalUrl = isHttpUrl(result.url) ? result.url : trimmed
          return formatScrapeOutcome({
            url: finalUrl,
            title: result.title,
            markdown: result.markdown,
            maxToolTextChars: params.maxToolTextChars,
          })
        } finally {
          lease.release()
        }
      }
      const outcome = await runWithRateLimitAndRetry({
        hasKey,
        credits: SCRAPE_CREDITS,
        replyKey: options.replyKey,
        signal,
        execute: (reqSignal) => client.scrape(trimmed, { apiKey, signal: reqSignal, audience }),
      })
      if (!outcome.ok) {
        throw outcome.kind === 'budget' ? new Error(outcome.message) : outcome.error
      }
      return outcome.value
    }

    if (cache) {
      let entry = cache.inFlight.get(trimmed)
      if (!entry) {
        const controller = new AbortController()
        const promise = executeScrape(controller.signal)
        entry = { promise, controller, waiters: 0 }
        cache.inFlight.set(trimmed, entry)
        promise.then(
          (scraped) => {
            cache.completed.set(trimmed, scraped)
            cache.completed.set(scraped.url, scraped)
            if (cache.inFlight.get(trimmed) === entry) {
              cache.inFlight.delete(trimmed)
            }
          },
          () => {
            if (cache.inFlight.get(trimmed) === entry) {
              cache.inFlight.delete(trimmed)
            }
          }
        )
      }

      entry.waiters += 1
      try {
        const scraped = await raceAbort(entry.promise, options.signal)
        recordAgentPage(options.caller, trimmed, scraped)
        return {
          status: 'ok',
          content: scraped.text,
          scrapedPage: { url: scraped.url, title: scraped.title },
        }
      } catch (error) {
        if (options.signal.aborted && entry.waiters <= 1) {
          entry.controller.abort(options.signal.reason)
        }
        return failed(error, options.signal, hasKey, audience)
      } finally {
        entry.waiters = Math.max(0, entry.waiters - 1)
        if (entry.waiters === 0 && options.signal.aborted) {
          entry.controller.abort(options.signal.reason)
        }
      }
    }

    try {
      const scraped = await executeScrape(options.signal)
      recordAgentPage(options.caller, trimmed, scraped)
      return {
        status: 'ok',
        content: scraped.text,
        scrapedPage: { url: scraped.url, title: scraped.title },
      }
    } catch (error) {
      return failed(error, options.signal, hasKey, audience)
    }
  }

  const instructionsFor = (audience: WebAudience, declaredNames?: ReadonlySet<string>): string => {
    if (audience === 'agent') {
      return buildAgentWebInstructions(params, hasLocalScrape)
    }
    const includeResearch = declaredNames ? declaredNames.has(RESEARCH_TOOL_NAME) : true
    return buildReplyWebInstructions(includeResearch, hasLocalScrape)
  }

  const BoundKeySettings: ComponentType<{ editor: KeyEditor }> = ({ editor }) =>
    createElement(KeySettings, { editor, localScrape: hasLocalScrape })

  return {
    toolNames,
    instructions: buildReplyWebInstructions(true, hasLocalScrape),
    instructionsFor,
    researchProfile,
    declareTools: ({ searchEnabled, questionText }) =>
      searchEnabled
        ? [searchTool, scrapeTool, RESEARCH_TOOL]
        : containsHttpUrl(questionText)
          ? [scrapeTool]
          : [],
    handles: (toolName) => toolName === WEB_SEARCH_TOOL_NAME || toolName === WEB_SCRAPE_TOOL_NAME,
    run: (toolName, input, options) => {
      if (toolName === WEB_SEARCH_TOOL_NAME) {
        return runSearch(input, options)
      }
      if (toolName === WEB_SCRAPE_TOOL_NAME) {
        return runScrape(input, options)
      }
      return Promise.resolve({ status: 'error', content: `Unknown tool: ${toolName}` })
    },
    verifyKey: client.verifyKey,
    getApiKey: keys.getApiKey,
    getKeyState: keys.getState,
    useKeyState: () => useSyncExternalStore(keys.subscribe, keys.getState, keys.getState),
    hydrate: keys.hydrate,
    setApiKey: keys.setApiKey,
    useKeyEditor: createUseKeyEditor(keys, client.verifyKey),
    KeySettings: BoundKeySettings,
  }
}
