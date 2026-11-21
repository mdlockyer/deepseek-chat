import type { HttpFetch } from '@deepseek-chat/spine/ports'
import {
  DEFAULT_FIRECRAWL_PARAMS,
  createFirecrawlClient,
  type FirecrawlParams,
  type KeyVerification,
  type WebSearchSource,
} from './firecrawl.js'

export type { FirecrawlParams, KeyVerification, WebSearchSource } from './firecrawl.js'

export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const WEB_SCRAPE_TOOL_NAME = 'web_scrape'

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
}

export type WebResearchDeps = {
  readonly fetch: HttpFetch
  /** The user's Firecrawl key, or null for the keyless tier. Read on every call. */
  readonly apiKey: () => string | null
  readonly params?: Partial<FirecrawlParams>
}

export type WebResearchSlice = {
  readonly toolNames: { readonly search: string; readonly scrape: string }
  readonly instructions: string
  declareTools(turn: { searchEnabled: boolean; questionText: string }): WebToolDefinition[]
  handles(toolName: string): boolean
  run(toolName: string, input: unknown, options: WebRunOptions): Promise<WebToolResult>
  verifyKey(apiKey: string, signal?: AbortSignal): Promise<KeyVerification>
}

const SEARCH_TOOL: WebToolDefinition = {
  name: WEB_SEARCH_TOOL_NAME,
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

const INSTRUCTIONS =
  'You have live web tools (`web_search` and `web_scrape`) powered by Firecrawl. Use `web_search` when current information or verification is needed, and `web_scrape` to read full pages or user-provided URLs. When citing `web_search` results in your final answer, cite them inline using `[citation:1]`, `[citation:2]`, etc. matching the 1-based result numbers returned by `web_search`.'

const containsHttpUrl = (text: string) => /https?:\/\/\S+/i.test(text)

const ABORTED: WebToolResult = { status: 'aborted', content: 'Aborted by user.' }

export const createWebResearchSlice = (deps: WebResearchDeps): WebResearchSlice => {
  const client = createFirecrawlClient(deps.fetch, { ...DEFAULT_FIRECRAWL_PARAMS, ...deps.params })

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
    try {
      const outcome = await client.search(query, {
        apiKey: deps.apiKey(),
        signal: options.signal,
        ...(typeof raw?.limit === 'number' ? { limit: raw.limit } : {}),
        ...(options.citedUrls ? { citedUrls: options.citedUrls } : {}),
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
    try {
      const outcome = await client.scrape(url, { apiKey: deps.apiKey(), signal: options.signal })
      return {
        status: 'ok',
        content: outcome.text,
        scrapedPage: { url: outcome.url, title: outcome.title },
      }
    } catch (error) {
      return failed(error, options.signal)
    }
  }

  return {
    toolNames: { search: WEB_SEARCH_TOOL_NAME, scrape: WEB_SCRAPE_TOOL_NAME },
    instructions: INSTRUCTIONS,
    declareTools: ({ searchEnabled, questionText }) =>
      searchEnabled
        ? [SEARCH_TOOL, SCRAPE_TOOL]
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
  }
}
