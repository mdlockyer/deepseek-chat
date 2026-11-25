import type { FirecrawlParams } from './firecrawl.js'

export const RESEARCH_TOOL_NAME = 'research'
export const FINISH_RESEARCH_TOOL_NAME = 'finish_research'

export type ResearchToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export type ResearchSource = {
  n: number
  url: string
  title: string
  verification: 'verified' | 'unverified'
}

export type ResearchProfile = {
  readonly model: 'deepseek-flash' | 'deepseek-v4-pro'
  readonly thinking: boolean
  readonly label: string
  readonly system: string
  readonly tools: readonly string[]
  readonly context: 'clean'
  readonly finish: ResearchToolDefinition
  readonly limits: { readonly maxRounds: number; readonly maxToolCalls: number }
  readonly task: (
    input: unknown
  ) => { kind: 'ok'; message: string } | { kind: 'invalid'; reason: string }
  readonly complete: (
    output: unknown,
    run: { runId: string; outcome: 'finished' | 'exhausted' }
  ) => Promise<{ content: string; sources: ResearchSource[] }>
}

export const RESEARCH_TOOL: ResearchToolDefinition = {
  name: RESEARCH_TOOL_NAME,
  description:
    'Start a read-only web research subagent with its own fresh context to investigate one focused thread using web_search and web_scrape. Returns immediately with a runId so you can start multiple researchers in parallel, then collect their results with wait.',
  input_schema: {
    type: 'object',
    required: ['objective'],
    properties: {
      objective: {
        type: 'string',
        description:
          'Complete, self-contained description of what this researcher must investigate and answer.',
      },
      boundaries: {
        type: 'string',
        description:
          'What is out of scope because you or other researchers are covering it. Always fill this in when starting multiple researchers so they do not overlap.',
      },
      return_format: {
        type: 'string',
        description: 'The shape or structure of findings you want back.',
      },
      source_guidance: {
        type: 'string',
        description: 'Preferred source types, primary docs, or recency guidance.',
      },
      effort: {
        type: 'string',
        enum: ['quick', 'standard', 'thorough'],
        description: 'Expected research depth (default "standard").',
      },
    },
  },
}

const FINISH_RESEARCH_TOOL: ResearchToolDefinition = {
  name: FINISH_RESEARCH_TOOL_NAME,
  description:
    "Hand your findings to the lead and end your task. Call it once, when you're done or when the app asks you to finish.",
  input_schema: {
    type: 'object',
    required: ['answer', 'sources'],
    properties: {
      answer: {
        type: 'string',
        description:
          'Your findings in Markdown, written for the lead. Cite sources as [1], [2] matching `sources`. Say plainly what you couldn’t establish.',
      },
      sources: {
        type: 'array',
        description:
          'Each unique page you cite (list each URL once), with a verbatim quote from the scraped page.',
        items: {
          type: 'object',
          required: ['n', 'url', 'title', 'quote'],
          properties: {
            n: { type: 'integer', minimum: 1 },
            url: { type: 'string', description: 'URL exactly as you scraped it.' },
            title: { type: 'string' },
            quote: {
              type: 'string',
              description:
                'One or two contiguous sentences copied verbatim from that scraped page that support the claim (avoid joining distant passages with "...").',
            },
          },
        },
      },
    },
  },
}

const RESEARCH_ROLE_PROMPT = [
  "You're a web researcher. The lead split a bigger question into parts and gave you one; other researchers may be working on neighbouring parts right now, which is why your task names boundaries. Stay inside them. If you notice something important outside them, mention it in one line at the end rather than researching it.",
  'Work like a careful person with a limited budget. Start with a short, broad search to see what exists, then narrow. Prefer primary sources (official documentation, the organisation’s own pages, papers, filings, data) over aggregators and SEO content, and prefer recent sources when the question is about how things are now. When sources disagree, report the disagreement instead of quietly picking one. Stop once you can answer the objective well, because more searching after that spends the person’s credits without improving your answer.',
  "Your result goes through code before the lead sees it. For each source you cite, the app checks that your quote appears verbatim in a page you fetched with `web_scrape` during this task, and marks any source whose quote it can't find as unverified. So scrape the pages you rely on, copy one or two contiguous sentences verbatim (don't stitch distant passages together with `...`), list each URL only once in `sources`, and don't cite a page from its search snippet alone: the check can't see snippets.",
].join('\n\n')

export const buildAgentWebInstructions = (
  params: FirecrawlParams,
  hasLocalScrape = false
): string => {
  if (hasLocalScrape) {
    return [
      '**Web Research (`web_search`, `web_scrape`).** `web_search` goes through Firecrawl, a hosted search service, using the person’s Firecrawl key or its keyless free tier. `web_scrape` fetches and converts public webpages locally on this machine without touching Firecrawl.',
      `\`web_search\` returns up to \`limit\` results (1–10, default ${params.defaultSearchLimit}), each with a title, URL, site name and snippet. Web results come before news, only http(s) links appear, and duplicates are removed. A snippet is the search engine's summary, not the page's text.`,
      `\`web_scrape\` fetches one public http(s) page or text-based PDF locally (trying Markdown content negotiation and direct HTML/PDF extraction first, then falling back to an isolated offscreen render for JavaScript-heavy pages) and returns its main content as Markdown with navigation, footers, and ads stripped. Private, localhost, and link-local/metadata network addresses are blocked by design for SSRF safety, and scanned image-only PDFs or other binary downloads are not extracted locally. It cuts off after ${params.maxToolTextChars.toLocaleString('en-US')} characters and says so. If what you need is past the cut, look for a more specific page rather than scraping the same URL again.`,
      `\`web_search\` spends the person’s Firecrawl credits (2 credits per 10 results; a free account gets 1,000 credits a month) and shares one Firecrawl rate limiter across all researchers: if you hit the rate limit or a transient HTTP 429, the app waits and retries for you automatically. \`web_scrape\` runs locally for free (0 Firecrawl credits) and shares a per-reply scrape cache so pages already read in this reply return from cache immediately. Both tools still count against your tool-call budget. A call only comes back as an error when it couldn't recover (a blocked page, an unsupported content type, a ${Math.round(params.scrapeTimeoutMs / 1000)}-second timeout, or an exhausted search quota), and the error says which. Don't retry a URL that failed and don't use \`post\` to stall; move on to another source or finish with what you have.`,
    ].join('\n\n')
  }
  return [
    '**Web Research (`web_search`, `web_scrape`).** Both tools go through Firecrawl, a hosted search-and-scrape service, using the person’s Firecrawl key or its keyless free tier.',
    `\`web_search\` returns up to \`limit\` results (1–10, default ${params.defaultSearchLimit}), each with a title, URL, site name and snippet. Web results come before news, only http(s) links appear, and duplicates are removed. A snippet is the search engine's summary, not the page's text.`,
    `\`web_scrape\` fetches one http(s) page and returns its main content as Markdown, with navigation, footers and ads stripped. It cuts off after ${params.maxToolTextChars.toLocaleString('en-US')} characters and says so. If what you need is past the cut, look for a more specific page rather than scraping the same URL again.`,
    `Both cost the person money or free quota: a search uses 2 credits per 10 results, a scrape uses 1, and a free account gets 1,000 credits a month. That's why you have a budget. Every researcher's calls share one rate limiter, concurrency cap, and per-reply scrape cache: if you hit the rate limit or a transient HTTP 429, the app waits and retries for you automatically, and pages already scraped in this reply return from cache without spending extra credits. A call only comes back as an error when it couldn't recover (a page that blocks scraping, a ${Math.round(params.scrapeTimeoutMs / 1000)}-second timeout, or an exhausted quota), and the error says which. Don't retry a URL that failed and don't use \`post\` to stall; move on to another source or finish with what you have.`,
  ].join('\n\n')
}

export const buildLeadResearchInstructions = (hasLocalScrape = false): string =>
  [
    '**Research subagents (`research`).** When a question needs many sources across separate threads, you can start researchers with `research`. Each one is another DeepSeek model with a fresh context and only the web tools. `research` returns as soon as the researcher has started. Start all the researchers you want in one response so they run at the same time, then call `wait`.',
    hasLocalScrape
      ? 'Use one researcher for a narrow question, two to four for a comparison, and more only for a broad survey, because each one spends the person’s Firecrawl search credits (a typical researcher uses about 8–12 search credits; page reads run locally for free). For a single fact, search yourself. Once researchers are running, let them handle the searching and scraping rather than duplicating queries yourself in parallel. You and your researchers share one Firecrawl search rate limit and credit budget, so redundant searches compete for the same slots.'
      : 'Use one researcher for a narrow question, two to four for a comparison, and more only for a broad survey, because each one spends the person’s search credits (a typical researcher uses about 20). For a single fact, search yourself. Once researchers are running, let them handle the searching and scraping rather than fetching the same URLs yourself in parallel. You and your researchers share one Firecrawl rate limit and credit budget, so redundant calls compete for the same slots.',
    'A researcher can’t see this conversation, so write each task as you would for a capable colleague who just walked in: the full objective, what the person cares about, explicit `boundaries` naming what the other researchers are covering so nobody duplicates work, and the shape you want back. Results arrive with their sources already numbered to continue this reply’s citations, so cite them inline with `[ref:n]` directly before punctuation in your chat reply. Board findings are hints; they aren’t checked, so cite only sources from results. A source marked unverified had a quote the app couldn’t find on its page; be careful with claims that rest on it. Researchers only read: you write the answer and anything else the person sees.',
  ].join('\n\n')

/** Normalizes any whitespace sequence to a single space and trims ends for deterministic quote checks. */
export const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Strips inline Markdown syntax (images, links, code ticks, bold/italic wrappers) while keeping
 * visible prose and snake_case identifiers intact, so rendered-prose quotes still match Markdown.
 */
const stripMarkdownInline = (text: string): string =>
  normalizeWhitespace(
    text
      .replace(/!\[([^\]]*)\]\([^)\s]+(?:\s+"[^"]*")?\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)\s]+(?:\s+"[^"]*")?\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[\s([{"'])\*([^*\n]+)\*(?=[\s)\]}"'.,;:!?]|$)/g, '$1$2')
  )

const ELLIPSIS_SPLIT_RE = /\s*(?:\.\.\.|…)\s*/

/**
 * Matches `needle` directly against `haystack`, or—when the model joined excerpts with `...`/`…`—
 * checks that every non-empty span appears verbatim in order inside `haystack`.
 */
const matchesOrderedSpans = (haystack: string, needle: string): boolean => {
  if (!needle) {
    return false
  }
  if (haystack.includes(needle)) {
    return true
  }
  if (!needle.includes('...') && !needle.includes('…')) {
    return false
  }
  const spans = needle.split(ELLIPSIS_SPLIT_RE).filter((span) => span.length > 0)
  if (spans.length === 0) {
    return false
  }
  let cursor = 0
  for (const span of spans) {
    const idx = haystack.indexOf(span, cursor)
    if (idx === -1) {
      return false
    }
    cursor = idx + span.length
  }
  return true
}

type CachedPage = {
  readonly raw: string
  readonly plain: string
}

const normalizeUrlKey = (url: string): string => url.trim()

export type PageCache = {
  record(runId: string, urls: readonly string[], markdown: string, title?: string | null): void
  take(runId: string): Map<string, CachedPage> | undefined
}

export const createPageCache = (): PageCache => {
  const byRun = new Map<string, Map<string, CachedPage>>()

  const record = (
    runId: string,
    urls: readonly string[],
    markdown: string,
    title?: string | null
  ) => {
    let pages = byRun.get(runId)
    if (!pages) {
      pages = new Map<string, CachedPage>()
      byRun.set(runId, pages)
    }
    const trimmedTitle = title?.trim()
    const combined = trimmedTitle ? `${trimmedTitle}\n\n${markdown}` : markdown
    const entry: CachedPage = {
      raw: normalizeWhitespace(combined),
      plain: stripMarkdownInline(combined),
    }
    for (const rawUrl of urls) {
      const key = normalizeUrlKey(rawUrl)
      if (key) {
        pages.set(key, entry)
      }
    }
  }

  const take = (runId: string): Map<string, CachedPage> | undefined => {
    const pages = byRun.get(runId)
    byRun.delete(runId)
    return pages
  }

  return { record, take }
}

const EFFORT_GUIDANCE: Record<
  'quick' | 'standard' | 'thorough',
  { searches: number; scrapes: number }
> = {
  quick: { searches: 2, scrapes: 2 },
  standard: { searches: 4, scrapes: 4 },
  thorough: { searches: 6, scrapes: 6 },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const createResearchProfile = (
  params: FirecrawlParams,
  pageCache: PageCache,
  toolNames: { readonly search: string; readonly scrape: string }
): ResearchProfile => ({
  model: 'deepseek-flash',
  thinking: true,
  label: 'Research',
  system: RESEARCH_ROLE_PROMPT,
  tools: [toolNames.search, toolNames.scrape],
  context: 'clean',
  finish: FINISH_RESEARCH_TOOL,
  limits: {
    maxRounds: params.researchMaxRounds,
    maxToolCalls: params.researchMaxToolCalls,
  },
  task: (input) => {
    if (!isRecord(input) || typeof input.objective !== 'string' || !input.objective.trim()) {
      return {
        kind: 'invalid',
        reason:
          'Missing or blank "objective": specify clearly what this researcher should investigate.',
      }
    }
    const objective = input.objective.trim()
    const boundaries =
      typeof input.boundaries === 'string' && input.boundaries.trim()
        ? input.boundaries.trim()
        : 'Stay focused on the objective above.'
    const returnFormat =
      typeof input.return_format === 'string' && input.return_format.trim()
        ? input.return_format.trim()
        : 'Concise Markdown summary with verbatim-quoted citations.'
    const sourceGuidance =
      typeof input.source_guidance === 'string' && input.source_guidance.trim()
        ? input.source_guidance.trim()
        : 'Use your judgement.'
    const effort: 'quick' | 'standard' | 'thorough' =
      input.effort === 'quick' || input.effort === 'thorough' ? input.effort : 'standard'
    const guide = EFFORT_GUIDANCE[effort]

    const message = [
      "Here's your part of the research.",
      `**Objective:** ${objective}`,
      `**Out of scope** (the lead or other researchers cover these): ${boundaries}`,
      `**What to return:** ${returnFormat}`,
      `**Sources:** ${sourceGuidance}`,
      `**Effort:** ${effort}. For this level, about ${guide.searches} searches and ${guide.scrapes} page reads is typical; your hard limit is ${params.researchMaxToolCalls} tool calls.`,
    ].join('\n\n')
    return { kind: 'ok', message }
  },
  complete: async (output, run) => {
    const pages = pageCache.take(run.runId)
    const record = isRecord(output) ? output : {}
    const answer =
      typeof record.answer === 'string' && record.answer.trim()
        ? record.answer.trim()
        : typeof output === 'string' && output.trim()
          ? output.trim()
          : 'No findings were returned before the run ended.'
    const rawSources = Array.isArray(record.sources) ? record.sources : []
    const sources: ResearchSource[] = []

    for (const item of rawSources) {
      if (!isRecord(item)) {
        continue
      }
      const url = typeof item.url === 'string' ? item.url.trim() : ''
      if (!url) {
        continue
      }
      const n = typeof item.n === 'number' && Number.isFinite(item.n) ? item.n : sources.length + 1
      const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : url
      const rawQuote = typeof item.quote === 'string' ? normalizeWhitespace(item.quote) : ''
      const plainQuote = typeof item.quote === 'string' ? stripMarkdownInline(item.quote) : ''
      const page = pages?.get(normalizeUrlKey(url))
      const verified = Boolean(
        page &&
        (matchesOrderedSpans(page.raw, rawQuote) || matchesOrderedSpans(page.plain, plainQuote))
      )
      sources.push({
        n,
        url,
        title,
        verification: verified ? 'verified' : 'unverified',
      })
    }

    return { content: answer, sources }
  },
})
