import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { scrapeWithFirecrawl, searchWithFirecrawl, verifyFirecrawlApiKey } from './firecrawl.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Firecrawl API client', () => {
  it('runs keyless search without Authorization header and formats numbered results', async () => {
    let seenHeaders: HeadersInit | undefined
    let seenBody: string | undefined
    globalThis.fetch = (async (_input, init) => {
      seenHeaders = init?.headers
      seenBody = typeof init?.body === 'string' ? init.body : undefined
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                url: 'https://www.firecrawl.dev/',
                title: 'Firecrawl',
                description: 'Web search and scraping API.',
              },
              {
                url: 'https://docs.firecrawl.dev/',
                title: 'Firecrawl Docs',
                highlights: ['Keyless search is live.'],
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    const result = await searchWithFirecrawl('firecrawl keyless', { limit: 5 })
    assert.deepEqual(seenHeaders, { 'Content-Type': 'application/json' })
    assert.deepEqual(JSON.parse(seenBody ?? '{}'), { query: 'firecrawl keyless', limit: 5 })
    assert.equal(result.sources.length, 2)
    assert.equal(result.sources[0].siteName, 'firecrawl.dev')
    assert.match(result.text, /\[1\] Firecrawl/)
    assert.match(result.text, /\[2\] Firecrawl Docs/)
    assert.match(result.text, /\[citation:1\]/)
  })

  it('sends Bearer token when API key is configured and verifies via credit-usage', async () => {
    const authHeaders: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      authHeaders.push(headers.get('Authorization') ?? '')
      return new Response(JSON.stringify({ success: true, data: { web: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await verifyFirecrawlApiKey('  fc-test-123  ')
    await searchWithFirecrawl('test', { apiKey: 'fc-test-123' })
    assert.deepEqual(authHeaders, ['Bearer fc-test-123', 'Bearer fc-test-123'])
  })

  it('distinguishes keyless 429 limit from keyed 429 limit', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false, error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    await assert.rejects(
      () => searchWithFirecrawl('hello'),
      (error: unknown) =>
        error instanceof Error && error.message.includes('keyless daily limit reached')
    )

    await assert.rejects(
      () => searchWithFirecrawl('hello', { apiKey: 'fc-test-123' }),
      (error: unknown) =>
        error instanceof Error && error.message.includes('rate or credit limit reached')
    )
  })

  it('validates URLs and truncates oversized markdown on scrape', async () => {
    await assert.rejects(
      () => scrapeWithFirecrawl('file:///etc/passwd'),
      (error: unknown) => error instanceof Error && error.message.includes('Invalid URL')
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: 'x'.repeat(30_000),
            metadata: {
              title: 'Long Page',
              sourceURL: 'https://example.com/long',
              statusCode: 200,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch

    const scraped = await scrapeWithFirecrawl('https://example.com/long')
    assert.equal(scraped.title, 'Long Page')
    assert.equal(scraped.url, 'https://example.com/long')
    assert.match(scraped.text, /Truncated after 24,000 characters/)
  })
})
