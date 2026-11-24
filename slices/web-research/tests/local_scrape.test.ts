import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryStore } from '@deepseek-chat/spine/ports'
import {
  createWebResearchSlice,
  type LocalScrapeResult,
  type LocalScraper,
} from '@deepseek-chat/slice-web-research'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('web-research: localScrape port', () => {
  it('routes web_scrape through localScrape without hitting Firecrawl or consuming Firecrawl credits', async () => {
    let firecrawlCalls = 0
    const scrapedUrls: string[] = []
    const localScrape: LocalScraper = async (url) => {
      scrapedUrls.push(url)
      return {
        url: `${url}#final`,
        title: 'Local Page',
        markdown: 'Extracted locally from Rust.',
        source: 'http',
      }
    }

    const web = createWebResearchSlice({
      fetch: async () => {
        firecrawlCalls += 1
        return json({ success: true, data: { web: [{ url: 'https://a.example', title: 'A' }] } })
      },
      store: memoryStore(),
      secret: null,
      localScrape,
      params: {
        // Exhaust Firecrawl credits after a single search (2 credits).
        maxCreditsPerReply: 2,
        keylessRatePerMinute: 1,
        rateWindowMs: 60_000,
      },
    })

    const sig = new AbortController().signal
    const search = await web.run(
      'web_search',
      { query: 'rust' },
      { signal: sig, replyKey: 'rep-1' }
    )
    assert.equal(search.status, 'ok')
    assert.equal(firecrawlCalls, 1)

    // Second search is blocked by the Firecrawl credit budget.
    const overBudget = await web.run(
      'web_search',
      { query: 'more' },
      { signal: sig, replyKey: 'rep-1' }
    )
    assert.equal(overBudget.status, 'error')
    assert.match(overBudget.content, /credit budget reached/i)
    assert.equal(firecrawlCalls, 1)

    // Local scrapes still succeed immediately without spending Firecrawl credits or hitting rate limits.
    const s1 = await web.run(
      'web_scrape',
      { url: 'https://a.example/one' },
      { signal: sig, replyKey: 'rep-1' }
    )
    const s2 = await web.run(
      'web_scrape',
      { url: 'https://a.example/two' },
      { signal: sig, replyKey: 'rep-1' }
    )

    assert.equal(s1.status, 'ok')
    assert.equal(s2.status, 'ok')
    assert.equal(firecrawlCalls, 1, 'Firecrawl was never called for local scrapes')
    assert.deepEqual(scrapedUrls, ['https://a.example/one', 'https://a.example/two'])
    assert.deepEqual(s1.scrapedPage, { url: 'https://a.example/one#final', title: 'Local Page' })
    assert.match(
      s1.content,
      /^Title: Local Page\nURL: https:\/\/a\.example\/one#final\n\nExtracted locally/
    )
  })

  it('rejects non-http URLs before invoking localScrape and truncates oversized markdown', async () => {
    let calls = 0
    const localScrape: LocalScraper = async (url) => {
      calls += 1
      return { url, title: null, markdown: 'a'.repeat(50), source: 'markdown-negotiated' }
    }

    const web = createWebResearchSlice({
      fetch: async () => json({}),
      store: memoryStore(),
      secret: null,
      localScrape,
      params: { maxToolTextChars: 40 },
    })

    const bad = await web.run(
      'web_scrape',
      { url: 'file:///etc/passwd' },
      { signal: new AbortController().signal }
    )
    assert.equal(bad.status, 'error')
    assert.match(bad.content, /Invalid URL/)
    assert.equal(calls, 0)

    const ok = await web.run(
      'web_scrape',
      { url: 'https://docs.example/md' },
      { signal: new AbortController().signal }
    )
    assert.equal(ok.status, 'ok')
    assert.match(ok.content, /\[Truncated after 40 characters\]$/)
    assert.equal(calls, 1)
  })

  it('caches completed scrapes, coalesces in-flight scrapes, isolates aborts, and feeds quote verification', async () => {
    let localCalls = 0
    let releaseSlow: () => void = () => undefined
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })

    const localScrape: LocalScraper = async (url, { signal }) => {
      localCalls += 1
      if (url.endsWith('/shared')) {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
          void slowGate.then(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      }
      return {
        url,
        title: 'Doc',
        markdown: `Local quote from ${url}.`,
        source: 'webview',
      }
    }

    const web = createWebResearchSlice({
      fetch: async () => json({}),
      store: memoryStore(),
      secret: null,
      localScrape,
    })

    const urlShared = 'https://local.example/shared'
    const abortOne = new AbortController()
    const pAbort = web.run(
      'web_scrape',
      { url: urlShared },
      {
        signal: abortOne.signal,
        caller: { kind: 'agent', profile: 'research', runId: 'run-abort' },
        replyKey: 'rep-local',
      }
    )
    const pKeep = web.run(
      'web_scrape',
      { url: urlShared },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId: 'run-keep' },
        replyKey: 'rep-local',
      }
    )

    abortOne.abort()
    assert.deepEqual(await pAbort, { status: 'aborted', content: 'Aborted by user.' })

    releaseSlow()
    const kept = await pKeep
    assert.equal(kept.status, 'ok')
    assert.equal(localCalls, 1, 'coalesced concurrent local scrapes into one call')

    // Subsequent scrape in the same reply hits cache and records into another agent's quote cache.
    const cached = await web.run(
      'web_scrape',
      { url: urlShared },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId: 'run-cached' },
        replyKey: 'rep-local',
      }
    )
    assert.equal(cached.status, 'ok')
    assert.equal(localCalls, 1)

    for (const runId of ['run-keep', 'run-cached']) {
      const checked = await web.researchProfile.complete(
        {
          answer: 'Result [1]',
          sources: [
            { n: 1, url: urlShared, title: 'Doc', quote: `Local quote from ${urlShared}.` },
          ],
        },
        { runId, outcome: 'finished' }
      )
      assert.equal(checked.sources[0]?.verification, 'verified', `${runId} quote verified`)
    }
  })

  it('caps simultaneous in-flight localScrape calls at maxLocalScrapeConcurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const localScrape: LocalScraper = async (url): Promise<LocalScrapeResult> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight -= 1
      return { url, title: 'T', markdown: 'Body', source: 'http' }
    }

    const web = createWebResearchSlice({
      fetch: async () => json({}),
      store: memoryStore(),
      secret: null,
      localScrape,
      params: { maxLocalScrapeConcurrency: 2 },
    })

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        web.run(
          'web_scrape',
          { url: `https://local.example/p-${i}` },
          { signal: new AbortController().signal, replyKey: 'rep-conc' }
        )
      )
    )
    assert.ok(results.every((r) => r.status === 'ok'))
    assert.equal(maxInFlight, 2)
  })

  it('surfaces localScrape failures cleanly and reflects local scraping in instructions and tool description', async () => {
    const localScrape: LocalScraper = async () => {
      throw new Error(
        'Blocked request to private, loopback, link-local, or reserved network address.'
      )
    }

    const localWeb = createWebResearchSlice({
      fetch: async () => json({}),
      store: memoryStore(),
      secret: null,
      localScrape,
    })
    const remoteWeb = createWebResearchSlice({
      fetch: async () => json({}),
      store: memoryStore(),
      secret: null,
    })

    const err = await localWeb.run(
      'web_scrape',
      { url: 'https://internal.example/' },
      { signal: new AbortController().signal }
    )
    assert.equal(err.status, 'error')
    assert.match(err.content, /Blocked request to private/)

    const localTools = localWeb.declareTools({ searchEnabled: true, questionText: '' })
    const scrapeTool = localTools.find((t) => t.name === 'web_scrape')
    assert.ok(scrapeTool && !/Firecrawl/i.test(scrapeTool.description))

    const localAgentPrompt = localWeb.instructionsFor('agent')
    const remoteAgentPrompt = remoteWeb.instructionsFor('agent')
    assert.match(localAgentPrompt, /locally/i)
    assert.match(localAgentPrompt, /no Firecrawl credits|0 Firecrawl credits|free/i)
    assert.match(remoteAgentPrompt, /a scrape uses 1/i)

    const localReplyPrompt = localWeb.instructionsFor('reply')
    assert.match(localReplyPrompt, /locally/i)
  })
})
