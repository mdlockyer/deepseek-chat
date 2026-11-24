import type { HttpFetch, KeyValueStore, SecretSlot } from '@deepseek-chat/spine/ports'
import { useSyncExternalStore } from 'react'
import {
  DEFAULT_FIRECRAWL_PARAMS,
  createFirecrawlClient,
  type FirecrawlParams,
  type KeyVerification,
  type WebAudience,
  type WebSearchSource,
} from './firecrawl.js'
import { createKeyStore, type FirecrawlKeyState } from './key.js'
import { KeySettings, createUseKeyEditor, type KeyEditor } from './KeySettings.js'
import { SCRAPE_CREDITS, createFirecrawlLimiter, searchCredits } from './limiter.js'
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
  /** Identifier for the reply, used to enforce the per-reply Firecrawl credit budget. */
  readonly replyKey?: string
}

export type WebResearchDeps = {
  readonly fetch: HttpFetch
  /** Web storage for the user's optional Firecrawl key. */
  readonly store: KeyValueStore
  /** Desktop private storage; `null` keeps the key in web storage. */
  readonly secret: SecretSlot | null
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
  KeySettings: typeof KeySettings
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

const SCRAPE_TOOL: WebToolDefinition = {
  name: WEB_SCRAPE_TOOL_NAME,
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

const buildReplyWebInstructions = (includeResearch: boolean): string => {
  const base = [
    'Web Research (`web_search`, `web_scrape`):',
    'You have fast headless web tools powered by Firecrawl. Reach for `web_search` and `web_scrape` when you need current facts, documentation, or clean Markdown from a URL—they are much faster and lighter than driving the built-in browser. Save the built-in browser for interactive flows, logged-in sessions, JavaScript-heavy apps, or visual inspection.',
    'When citing `web_search` results in your answer, place inline markers like `[citation:1]`, `[citation:2]` matching the 1-based result numbers returned by `web_search`—the app renders them as clickable source links and populates the Search Results panel.',
  ].join('\n')
  return includeResearch ? `${base}\n\n${buildLeadResearchInstructions()}` : base
}

const containsHttpUrl = (text: string) => /https?:\/\/\S+/i.test(text)

const ABORTED: WebToolResult = { status: 'aborted', content: 'Aborted by user.' }

export const createWebResearchSlice = (deps: WebResearchDeps): WebResearchSlice => {
  const params: FirecrawlParams = { ...DEFAULT_FIRECRAWL_PARAMS, ...deps.params }
  const limiter = createFirecrawlLimiter({
    rateWindowMs: params.rateWindowMs,
    keylessRatePerMinute: params.keylessRatePerMinute,
    keyedRatePerMinute: params.keyedRatePerMinute,
    backoff429Ms: params.backoff429Ms,
    maxCreditsPerReply: params.maxCreditsPerReply,
  })
  const client = createFirecrawlClient(deps.fetch, params, {
    onRateLimited: () => limiter.noteRateLimited(),
  })
  const keys = createKeyStore({ store: deps.store, secret: deps.secret })
  const pageCache = createPageCache()
  const searchTool = buildSearchTool(params)
  const toolNames = {
    search: WEB_SEARCH_TOOL_NAME,
    scrape: WEB_SCRAPE_TOOL_NAME,
    research: RESEARCH_TOOL_NAME,
  } as const
  const researchProfile = createResearchProfile(params, pageCache, toolNames)

  const invalidInput = (expected: string, input: unknown, inputJson?: string): WebToolResult => ({
    status: 'error',
    content: `Invalid input: expected ${expected}, got ${inputJson ?? JSON.stringify(input)}`,
  })

  const failed = (error: unknown, signal: AbortSignal): WebToolResult =>
    signal.aborted
      ? ABORTED
      : { status: 'error', content: error instanceof Error ? error.message : String(error) }

  const runSearch = async (input: unknown, options: WebRunOptions): Promise<WebToolResult> => {
    const raw =
      input && typeof input === 'object' ? (input as { query?: unknown; limit?: unknown }) : null
    const query = typeof raw?.query === 'string' ? raw.query : ''
    if (!query.trim()) {
      return invalidInput('{"query": string}', input, options.inputJson)
    }
    const apiKey = keys.getApiKey()
    const limit = Math.min(
      Math.max(
        Math.trunc(typeof raw?.limit === 'number' ? raw.limit : params.defaultSearchLimit),
        1
      ),
      10
    )
    const audience: WebAudience = options.caller?.kind === 'agent' ? 'agent' : 'reply'
    try {
      const slot = await limiter.acquire({
        hasKey: Boolean(apiKey?.trim()),
        credits: searchCredits(limit),
        replyKey: options.replyKey,
        signal: options.signal,
      })
      if (!slot.ok) {
        return { status: 'error', content: slot.message }
      }
      const outcome = await client.search(query, {
        apiKey,
        signal: options.signal,
        limit,
        audience,
        ...(audience === 'reply' && options.citedUrls ? { citedUrls: options.citedUrls } : {}),
      })
      return { status: 'ok', content: outcome.text, searchResults: outcome.sources }
    } catch (error) {
      return failed(error, options.signal)
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
    const audience: WebAudience = options.caller?.kind === 'agent' ? 'agent' : 'reply'
    try {
      // Validate URL before acquiring limiter slot / spending credits.
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
      const slot = await limiter.acquire({
        hasKey: Boolean(apiKey?.trim()),
        credits: SCRAPE_CREDITS,
        replyKey: options.replyKey,
        signal: options.signal,
      })
      if (!slot.ok) {
        return { status: 'error', content: slot.message }
      }
      const outcome = await client.scrape(url, { apiKey, signal: options.signal, audience })
      if (options.caller?.kind === 'agent') {
        pageCache.record(options.caller.runId, [trimmed, outcome.url], outcome.markdown)
      }
      return {
        status: 'ok',
        content: outcome.text,
        scrapedPage: { url: outcome.url, title: outcome.title },
      }
    } catch (error) {
      return failed(error, options.signal)
    }
  }

  const instructionsFor = (audience: WebAudience, declaredNames?: ReadonlySet<string>): string => {
    if (audience === 'agent') {
      return buildAgentWebInstructions(params)
    }
    const includeResearch = declaredNames ? declaredNames.has(RESEARCH_TOOL_NAME) : true
    return buildReplyWebInstructions(includeResearch)
  }

  return {
    toolNames,
    instructions: buildReplyWebInstructions(true),
    instructionsFor,
    researchProfile,
    declareTools: ({ searchEnabled, questionText }) =>
      searchEnabled
        ? [searchTool, SCRAPE_TOOL, RESEARCH_TOOL]
        : containsHttpUrl(questionText)
          ? [SCRAPE_TOOL]
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
    KeySettings,
  }
}
