import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryStore } from '@deepseek-chat/test-support'
import { createWebResearchSlice } from '@deepseek-chat/slice-web-research'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const seeded = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('web-research: research profile task validation & quote verification', () => {
  it('rejects tasks without a non-blank objective and builds a task message with budget for valid inputs', () => {
    const web = createWebResearchSlice({
      fetch: async () => json({}),
      store: memoryStore(),
      secret: null,
      params: { researchMaxToolCalls: 14, researchMaxRounds: 9 },
    })

    assert.equal(web.toolNames.research, 'research')
    assert.equal(web.researchProfile.context, 'clean')
    assert.equal(web.researchProfile.finish.name, 'finish_research')
    assert.deepEqual(web.researchProfile.tools, ['web_search', 'web_scrape'])
    assert.deepEqual(web.researchProfile.limits, { maxRounds: 9, maxToolCalls: 14 })

    for (const bad of [
      null,
      undefined,
      {},
      { objective: '' },
      { objective: '   ' },
      { objective: 42 },
    ]) {
      const result = web.researchProfile.task(bad)
      assert.equal(result.kind, 'invalid', `rejects ${JSON.stringify(bad)}`)
    }

    const ok = web.researchProfile.task({
      objective: 'Compare Rust async runtimes',
      boundaries: 'Do not cover Go',
      return_format: 'Bullet list',
      source_guidance: 'Official docs only',
      effort: 'thorough',
    })
    assert.equal(ok.kind, 'ok')
    if (ok.kind === 'ok') {
      assert.match(ok.message, /Compare Rust async runtimes/)
      assert.match(ok.message, /Do not cover Go/)
      assert.match(ok.message, /Bullet list/)
      assert.match(ok.message, /Official docs only/)
      assert.match(ok.message, /14 tool calls/)
    }
  })

  it('verifies a source if and only if its whitespace-normalized quote appears in a page scraped under that runId (randomized)', async () => {
    const pagesByUrl = new Map<string, string>()
    const web = createWebResearchSlice({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { url: string }
        const md = pagesByUrl.get(body.url) ?? ''
        return json({
          success: true,
          data: {
            markdown: md,
            metadata: { title: `Title ${body.url}`, sourceURL: body.url, statusCode: 200 },
          },
        })
      },
      store: memoryStore(),
      secret: null,
      params: { keylessRatePerMinute: 1000, maxCreditsPerReply: 1000 },
    })

    const words = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'theta',
      'lambda',
      'sigma',
      'omega',
      '2026',
      'benchmark',
      'latency',
      'throughput',
    ]
    const rand = seeded(20261123)

    for (let trial = 0; trial < 20; trial += 1) {
      const runId = `run-${trial}`
      const otherRunId = `other-${trial}`
      const url = `https://docs.example/page-${trial}`
      const tokens = Array.from(
        { length: 25 },
        () => words[Math.floor(rand() * words.length)] ?? 'alpha'
      )
      // Mix irregular whitespace (newlines, tabs, multiple spaces) inside the scraped markdown.
      const markdown = tokens.reduce(
        (acc, w, idx) =>
          acc + (idx === 0 ? w : (idx % 4 === 0 ? '\n  ' : idx % 3 === 0 ? '\t' : ' ') + w),
        ''
      )
      pagesByUrl.set(url, markdown)

      const scraped = await web.run(
        'web_scrape',
        { url },
        {
          signal: new AbortController().signal,
          caller: { kind: 'agent', profile: 'research', runId },
        }
      )
      assert.equal(scraped.status, 'ok')

      // Pick a genuine contiguous slice from tokens with different whitespace -> must verify!
      const start = Math.floor(rand() * 15)
      const len = 4 + Math.floor(rand() * 5)
      const genuineQuote = tokens.slice(start, start + len).join('   \n ')
      const fabricatedQuote = 'never-appeared-anywhere-in-this-document-999'

      // Another runId that did NOT scrape `url` must mark even the genuine quote as unverified.
      const wrongRun = await web.researchProfile.complete(
        {
          answer: 'Other [1]',
          sources: [{ n: 1, url, title: 'Doc', quote: genuineQuote }],
        },
        { runId: otherRunId, outcome: 'finished' }
      )
      assert.equal(wrongRun.sources[0]?.verification, 'unverified')

      const checked = await web.researchProfile.complete(
        {
          answer: 'Findings [1] [2] [3]',
          sources: [
            { n: 1, url, title: 'Doc', quote: genuineQuote },
            { n: 2, url, title: 'Doc', quote: fabricatedQuote },
            {
              n: 3,
              url: 'https://unscraped.example/x',
              title: 'Snippet only',
              quote: genuineQuote,
            },
          ],
        },
        { runId, outcome: 'finished' }
      )
      assert.deepEqual(
        checked.sources.map((s) => s.verification),
        ['verified', 'unverified', 'unverified'],
        `trial ${trial}`
      )

      // Page cache must be dropped once `complete` finishes for that runId.
      const afterDrop = await web.researchProfile.complete(
        {
          answer: 'Replay [1]',
          sources: [{ n: 1, url, title: 'Doc', quote: genuineQuote }],
        },
        { runId, outcome: 'finished' }
      )
      assert.equal(afterDrop.sources[0]?.verification, 'unverified')
    }
  })

  it('verifies quotes against page title, stripped Markdown formatting, and ordered ellipsis spans while rejecting out-of-order or fabricated spans', async () => {
    const markdown = [
      'Starlark is inspired by **Python3**, used in [Bazel](https://bazel.build), [Buck](https://buck.build) and [Buck2](https://buck2.build).',
      'It compiles via `starlark_syntax` into bytecode.',
      'Finally, execution is deterministic.',
    ].join('\n\n')
    const url = 'https://docs.example/starlark'
    const web = createWebResearchSlice({
      fetch: async () =>
        json({
          success: true,
          data: {
            markdown,
            metadata: {
              title: 'GitHub - facebook/starlark-rust: Starlark in Rust',
              sourceURL: url,
              statusCode: 200,
            },
          },
        }),
      store: memoryStore(),
      secret: null,
      params: { keylessRatePerMinute: 1000, maxCreditsPerReply: 1000 },
    })

    const runId = 'run-rich-quotes'
    const scraped = await web.run(
      'web_scrape',
      { url },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId },
      }
    )
    assert.equal(scraped.status, 'ok')

    const checked = await web.researchProfile.complete(
      {
        answer: 'Findings [1] [2] [3] [4] [5] [6] [7]',
        sources: [
          {
            n: 1,
            url,
            title: 'Starlark',
            quote: 'Starlark is inspired by Python3, used in Bazel, Buck and Buck2.',
          },
          {
            n: 2,
            url,
            title: 'Starlark',
            quote: 'GitHub - facebook/starlark-rust: Starlark in Rust',
          },
          {
            n: 3,
            url,
            title: 'Starlark',
            quote: 'Starlark is inspired by Python3 ... Finally, execution is deterministic.',
          },
          {
            n: 4,
            url,
            title: 'Starlark',
            quote: 'It compiles via starlark_syntax … execution is deterministic.',
          },
          {
            n: 5,
            url,
            title: 'Starlark',
            quote: 'Finally, execution is deterministic. ... Starlark is inspired by Python3',
          },
          {
            n: 6,
            url,
            title: 'Starlark',
            quote: 'Starlark is inspired by Python3 ... totally fabricated claim.',
          },
          {
            n: 7,
            url,
            title: 'Starlark',
            quote: '...',
          },
        ],
      },
      { runId, outcome: 'finished' }
    )

    assert.deepEqual(
      checked.sources.map((s) => s.verification),
      ['verified', 'verified', 'verified', 'verified', 'unverified', 'unverified', 'unverified']
    )
  })
})

describe('web-research: shared rate limiter, credit budget, and agent wording', () => {
  it('never exceeds the configured rate across a concurrent burst from five runs', async () => {
    const rateWindowMs = 80
    const rateCap = 3
    const requestTimes: number[] = []

    const web = createWebResearchSlice({
      fetch: async () => {
        requestTimes.push(Date.now())
        return json({ success: true, data: { web: [{ url: 'https://a.example', title: 'A' }] } })
      },
      store: memoryStore(),
      secret: null,
      params: {
        rateWindowMs,
        keylessRatePerMinute: rateCap,
        maxCreditsPerReply: 200,
      },
    })

    // Fire 8 concurrent searches across 5 distinct subagent runIds.
    const tasks = Array.from({ length: 8 }, (_, idx) =>
      web.run(
        'web_search',
        { query: `burst-${idx}`, limit: 5 },
        {
          signal: new AbortController().signal,
          caller: { kind: 'agent', profile: 'research', runId: `agent-${idx % 5}` },
          replyKey: 'reply-burst',
        }
      )
    )
    const outcomes = await Promise.all(tasks)
    assert.ok(outcomes.every((o) => o.status === 'ok'))
    assert.equal(requestTimes.length, 8)

    // Sliding window check: in every window of length (rateWindowMs - 10ms tolerance), count <= rateCap.
    const strictSpan = rateWindowMs - 10
    for (let i = 0; i < requestTimes.length; i += 1) {
      let inWindow = 0
      for (let j = i; j < requestTimes.length; j += 1) {
        if (requestTimes[j] - requestTimes[i] < strictSpan) {
          inWindow += 1
        }
      }
      assert.ok(
        inWindow <= rateCap,
        `observed ${inWindow} requests within ${strictSpan}ms (cap ${rateCap})`
      )
    }
  })

  it('enforces per-reply credit budget without sending requests past the limit', async () => {
    let fetchCount = 0
    const web = createWebResearchSlice({
      fetch: async (url) => {
        fetchCount += 1
        if (url.endsWith('/search')) {
          return json({ success: true, data: { web: [{ url: 'https://a.example', title: 'A' }] } })
        }
        return json({
          success: true,
          data: {
            markdown: 'hello',
            metadata: { sourceURL: 'https://a.example', statusCode: 200 },
          },
        })
      },
      store: memoryStore(),
      secret: null,
      params: {
        keylessRatePerMinute: 100,
        maxCreditsPerReply: 5, // 2 searches (4 credits) + 1 scrape (1 credit) = 5; next call exceeds budget!
      },
    })

    const sig = new AbortController().signal
    const r1 = await web.run('web_search', { query: 'q1' }, { signal: sig, replyKey: 'rep-1' })
    const r2 = await web.run('web_search', { query: 'q2' }, { signal: sig, replyKey: 'rep-1' })
    const r3 = await web.run(
      'web_scrape',
      { url: 'https://a.example' },
      { signal: sig, replyKey: 'rep-1' }
    )
    const r4 = await web.run(
      'web_scrape',
      { url: 'https://b.example' },
      { signal: sig, replyKey: 'rep-1' }
    )

    assert.equal(r1.status, 'ok')
    assert.equal(r2.status, 'ok')
    assert.equal(r3.status, 'ok')
    assert.equal(r4.status, 'error')
    assert.match(r4.content, /credit budget reached/i)
    assert.equal(fetchCount, 3, '4th call did not hit Firecrawl')

    // A different reply has its own fresh budget.
    const other = await web.run(
      'web_scrape',
      { url: 'https://a.example' },
      { signal: sig, replyKey: 'rep-2' }
    )
    assert.equal(other.status, 'ok')
    assert.equal(fetchCount, 4)
  })

  it('words instructions and tool results for agent callers without UI instructions or Settings advice', async () => {
    let mode: 'ok' | '429' = 'ok'
    const web = createWebResearchSlice({
      fetch: async () =>
        mode === 'ok'
          ? json({
              success: true,
              data: { web: [{ url: 'https://a.example', title: 'A', description: 'desc' }] },
            })
          : json({ error: 'Too many requests' }, 429),
      store: memoryStore(),
      secret: null,
      params: {
        defaultSearchLimit: 6,
        maxToolTextChars: 12_345,
        scrapeTimeoutMs: 30_000,
        backoff429Ms: 0,
      },
    })

    const agentPrompt = web.instructionsFor('agent')
    assert.match(agentPrompt, /default 6/)
    assert.match(agentPrompt, /12,345 characters/)
    assert.match(agentPrompt, /30-second timeout/)
    assert.ok(!agentPrompt.includes('clickable source links'))

    const searchRes = await web.run(
      'web_search',
      { query: 'hello' },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId: 'r1' },
      }
    )
    assert.equal(searchRes.status, 'ok')
    assert.ok(
      !searchRes.content.includes('[ref:1]') && !searchRes.content.includes('[citation:1]'),
      'agent search result omits UI citation footer'
    )

    mode = '429'
    const errRes = await web.run(
      'web_search',
      { query: 'hello' },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId: 'r1' },
      }
    )
    assert.equal(errRes.status, 'error')
    assert.ok(
      !errRes.content.includes('Settings'),
      'agent 429 error does not tell child to open Settings'
    )
  })

  it('caps simultaneous in-flight Firecrawl requests at maxConcurrentRequests', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const web = createWebResearchSlice({
      fetch: async (_url, init) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 15))
        inFlight -= 1
        const body = JSON.parse(String(init.body)) as { url: string }
        return json({
          success: true,
          data: {
            markdown: `Body ${body.url}`,
            metadata: { sourceURL: body.url, statusCode: 200 },
          },
        })
      },
      store: memoryStore(),
      secret: null,
      params: {
        keylessRatePerMinute: 1000,
        maxConcurrentRequests: 2,
        maxCreditsPerReply: 100,
      },
    })

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        web.run(
          'web_scrape',
          { url: `https://c.example/page-${i}` },
          { signal: new AbortController().signal, replyKey: 'rep-conc' }
        )
      )
    )
    assert.ok(results.every((r) => r.status === 'ok'))
    assert.equal(maxInFlight, 2)
  })

  it('automatically retries transient keyed HTTP 429s, skips retry on keyless or credit-exhausted 429s, and refunds credits on failures', async () => {
    // 1. Keyed transient 429 twice then 200 -> succeeds and charges only 1 credit.
    let transientCalls = 0
    const keyedTransient = createWebResearchSlice({
      fetch: async () => {
        transientCalls += 1
        if (transientCalls <= 2) {
          return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
          })
        }
        return json({
          success: true,
          data: {
            markdown: 'Recovered',
            metadata: { sourceURL: 'https://r.example/1', statusCode: 200 },
          },
        })
      },
      store: memoryStore({ 'chat-demo:firecrawl-api-key': 'fc-key' }),
      secret: null,
      params: {
        keyedRatePerMinute: 100,
        backoff429Ms: 5,
        max429Retries: 3,
        maxCreditsPerReply: 1,
      },
    })

    const recovered = await keyedTransient.run(
      'web_scrape',
      { url: 'https://r.example/1' },
      { signal: new AbortController().signal, replyKey: 'rep-retry' }
    )
    assert.equal(recovered.status, 'ok')
    assert.equal(transientCalls, 3)

    // 2. Permanent credit exhaustion 429 does NOT retry and refunds its reserved credit.
    let permCalls = 0
    let failMode = true
    const keyedPerm = createWebResearchSlice({
      fetch: async (_url, init) => {
        permCalls += 1
        if (failMode) {
          return json({ error: 'Insufficient credits for this request' }, 429)
        }
        const body = JSON.parse(String(init.body)) as { url: string }
        return json({
          success: true,
          data: { markdown: 'ok', metadata: { sourceURL: body.url, statusCode: 200 } },
        })
      },
      store: memoryStore({ 'chat-demo:firecrawl-api-key': 'fc-key' }),
      secret: null,
      params: {
        keyedRatePerMinute: 100,
        backoff429Ms: 5,
        max429Retries: 3,
        maxCreditsPerReply: 1,
      },
    })

    const permErr = await keyedPerm.run(
      'web_scrape',
      { url: 'https://r.example/fail' },
      { signal: new AbortController().signal, replyKey: 'rep-perm' }
    )
    assert.equal(permErr.status, 'error')
    assert.equal(permCalls, 1, 'permanent credit 429 must not retry')

    // Because the failed call refunded its credit, a subsequent call within budget=1 still runs.
    failMode = false
    const afterRefund = await keyedPerm.run(
      'web_scrape',
      { url: 'https://r.example/ok' },
      { signal: new AbortController().signal, replyKey: 'rep-perm' }
    )
    assert.equal(afterRefund.status, 'ok')
    assert.equal(permCalls, 2)

    // 3. Keyless 429 does NOT retry.
    let keylessCalls = 0
    const keyless = createWebResearchSlice({
      fetch: async () => {
        keylessCalls += 1
        return json({ error: 'Rate limit exceeded' }, 429)
      },
      store: memoryStore(),
      secret: null,
      params: { backoff429Ms: 5, max429Retries: 3 },
    })
    const keylessErr = await keyless.run(
      'web_search',
      { query: 'test' },
      { signal: new AbortController().signal }
    )
    assert.equal(keylessErr.status, 'error')
    assert.equal(keylessCalls, 1)
  })

  it('caches scrapes and coalesces concurrent identical URLs within a reply while recording quotes for each agent and isolating aborts', async () => {
    let fetchCount = 0
    let releaseSlow: () => void = () => undefined
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let shouldFailFirst = true

    const web = createWebResearchSlice({
      fetch: async (_url, init) => {
        fetchCount += 1
        const body = JSON.parse(String(init.body)) as { url: string }
        if (body.url.endsWith('/flaky') && shouldFailFirst) {
          shouldFailFirst = false
          return json({ error: 'Temporary failure' }, 500)
        }
        if (body.url.endsWith('/shared')) {
          await slowGate
        }
        return json({
          success: true,
          data: {
            markdown: `Verified passage from ${body.url}.`,
            metadata: { title: 'Doc', sourceURL: body.url, statusCode: 200 },
          },
        })
      },
      store: memoryStore(),
      secret: null,
      params: { keylessRatePerMinute: 100, maxCreditsPerReply: 10 },
    })

    // Completed cache hit across lead -> agent still records into agent's quote cache.
    const urlA = 'https://cache.example/a'
    const leadRes = await web.run(
      'web_scrape',
      { url: urlA },
      { signal: new AbortController().signal, caller: { kind: 'reply' }, replyKey: 'rep-cache' }
    )
    const agentRes = await web.run(
      'web_scrape',
      { url: urlA },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId: 'run-cached' },
        replyKey: 'rep-cache',
      }
    )
    assert.equal(leadRes.status, 'ok')
    assert.equal(agentRes.status, 'ok')
    assert.equal(fetchCount, 1, 'second scrape of same URL in same reply hit cache')

    const verifiedFromCache = await web.researchProfile.complete(
      {
        answer: 'Used [1]',
        sources: [{ n: 1, url: urlA, title: 'Doc', quote: `Verified passage from ${urlA}.` }],
      },
      { runId: 'run-cached', outcome: 'finished' }
    )
    assert.equal(verifiedFromCache.sources[0]?.verification, 'verified')

    // In-flight coalescing + independent abort of one waiter.
    const urlShared = 'https://cache.example/shared'
    const abortOne = new AbortController()
    const pAbort = web.run(
      'web_scrape',
      { url: urlShared },
      {
        signal: abortOne.signal,
        caller: { kind: 'agent', profile: 'research', runId: 'run-aborted' },
        replyKey: 'rep-cache',
      }
    )
    const pKeep = web.run(
      'web_scrape',
      { url: urlShared },
      {
        signal: new AbortController().signal,
        caller: { kind: 'agent', profile: 'research', runId: 'run-kept' },
        replyKey: 'rep-cache',
      }
    )
    abortOne.abort()
    releaseSlow()
    const [rAborted, rKept] = await Promise.all([pAbort, pKeep])
    assert.equal(rAborted.status, 'aborted')
    assert.equal(rKept.status, 'ok')
    assert.equal(fetchCount, 2, 'concurrent waiters coalesced into one fetch')

    const verifiedKept = await web.researchProfile.complete(
      {
        answer: 'Used [1]',
        sources: [
          { n: 1, url: urlShared, title: 'Doc', quote: `Verified passage from ${urlShared}.` },
        ],
      },
      { runId: 'run-kept', outcome: 'finished' }
    )
    assert.equal(verifiedKept.sources[0]?.verification, 'verified')

    // Failed scrape is never cached.
    const urlFlaky = 'https://cache.example/flaky'
    const firstFlaky = await web.run(
      'web_scrape',
      { url: urlFlaky },
      { signal: new AbortController().signal, replyKey: 'rep-cache' }
    )
    const secondFlaky = await web.run(
      'web_scrape',
      { url: urlFlaky },
      { signal: new AbortController().signal, replyKey: 'rep-cache' }
    )
    assert.equal(firstFlaky.status, 'error')
    assert.equal(secondFlaky.status, 'ok')
    assert.equal(fetchCount, 4)
  })
})
