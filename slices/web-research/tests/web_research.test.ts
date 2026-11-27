import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SecretSlot } from '@deepseek-chat/spine/ports'
import { memoryStore } from '@deepseek-chat/test-support'
import {
  createWebResearchSlice,
  type WebResearchDeps,
  type WebToolResult,
} from '@deepseek-chat/slice-web-research'

const KEY = 'chat-demo:firecrawl-api-key'

/** Web storage holding the given Firecrawl key. */
const keyed = (key: string) => ({ store: memoryStore({ [KEY]: key }) })

type Call = { url: string; init: RequestInit }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Records requests and answers each with `respond`. */
const fakeFetch = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetch: WebResearchDeps['fetch'] = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return respond(call)
  }
  return { fetch, calls }
}

/** A fetch that only settles when its signal aborts, like a server that never answers. */
const hangingFetch: WebResearchDeps['fetch'] = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })

const setup = (
  respond: (call: Call) => Response | Promise<Response>,
  overrides: Partial<WebResearchDeps> = {}
) => {
  const fake = fakeFetch(respond)
  const web = createWebResearchSlice({
    fetch: fake.fetch,
    store: memoryStore(),
    secret: null,
    ...overrides,
  })
  return { web, calls: fake.calls }
}

const signal = () => new AbortController().signal
const authHeader = (call: Call | undefined) => new Headers(call?.init.headers).get('Authorization')

describe('web-research: declaring tools', () => {
  const { web } = setup(() => json({}))
  const names = (tools: { name: string }[]) => tools.map((tool) => tool.name)

  it('declares search, scrape, and research when search is enabled', () => {
    assert.deepEqual(names(web.declareTools({ searchEnabled: true, questionText: 'hi' })), [
      'web_search',
      'web_scrape',
      'research',
    ])
  })

  it('declares only scrape when search is off but the question has a URL', () => {
    const tools = web.declareTools({
      searchEnabled: false,
      questionText: 'summarise https://example.com/a please',
    })
    assert.deepEqual(names(tools), ['web_scrape'])
  })

  it('declares nothing when search is off and there is no URL', () => {
    assert.deepEqual(web.declareTools({ searchEnabled: false, questionText: 'example.com' }), [])
  })

  it('claims exactly its two tool names', () => {
    assert.equal(web.handles('web_search'), true)
    assert.equal(web.handles('web_scrape'), true)
    assert.equal(web.handles('python'), false)
  })
})

describe('web-research: search', () => {
  it('runs keyless search without Authorization header and formats numbered results', async () => {
    const { web, calls } = setup(() =>
      json({
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
      })
    )

    const result = await web.run(
      'web_search',
      { query: 'firecrawl keyless', limit: 5 },
      { signal: signal() }
    )

    assert.deepEqual(calls[0]?.init.headers, { 'Content-Type': 'application/json' })
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      query: 'firecrawl keyless',
      limit: 5,
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.searchResults?.length, 2)
    assert.equal(result.searchResults?.[0]?.siteName, 'firecrawl.dev')
    assert.equal(result.searchResults?.[1]?.snippet, 'Keyless search is live.')
    assert.match(result.content, /\[1\] Firecrawl/)
    assert.match(result.content, /\[2\] Firecrawl Docs/)
    assert.match(result.content, /\[ref:1\]/)
  })

  it('sends the trimmed key as a Bearer token, read on every call', async () => {
    const { web, calls } = setup(
      () => json({ success: true, data: { web: [] } }),
      keyed('  fc-one  ')
    )

    await web.run('web_search', { query: 'a' }, { signal: signal() })
    await web.setApiKey('fc-two')
    await web.run('web_search', { query: 'b' }, { signal: signal() })

    assert.deepEqual(calls.map(authHeader), ['Bearer fc-one', 'Bearer fc-two'])
  })

  it('keeps only http(s) results, deduplicated, web before news, URL as missing title', async () => {
    const { web } = setup(() =>
      json({
        success: true,
        data: {
          web: [
            { url: 'https://a.example/', title: 'A' },
            { url: 'ftp://files.example/x', title: 'FTP' },
            { url: 'https://a.example/', title: 'A again' },
          ],
          news: [{ url: 'https://b.example/', title: '  ' }],
        },
      })
    )

    const result = await web.run('web_search', { query: 'q' }, { signal: signal() })

    assert.deepEqual(
      result.searchResults?.map((source) => [source.url, source.title]),
      [
        ['https://a.example/', 'A'],
        ['https://b.example/', 'https://b.example/'],
      ]
    )
  })

  it('continues citation numbers from URLs already cited in the reply', async () => {
    const { web } = setup(() =>
      json({
        success: true,
        data: [{ url: 'https://old.example/' }, { url: 'https://new.example/' }],
      })
    )
    // Two URLs already cited: old.example is [2]; the next new URL gets 2 + 1 = [3].
    const citedUrls = new Map([
      ['https://first.example/', 1],
      ['https://old.example/', 2],
    ])

    const result = await web.run('web_search', { query: 'q' }, { signal: signal(), citedUrls })

    assert.match(result.content, /^\[2\] https:\/\/old\.example\//m)
    assert.match(result.content, /^\[3\] https:\/\/new\.example\//m)
  })

  it('clamps the requested limit to 1..10 and defaults it', async () => {
    const { web, calls } = setup(() => json({ success: true, data: [] }))

    await web.run('web_search', { query: 'q', limit: 50 }, { signal: signal() })
    await web.run('web_search', { query: 'q', limit: 0 }, { signal: signal() })
    await web.run('web_search', { query: 'q' }, { signal: signal() })

    assert.deepEqual(
      calls.map((call) => JSON.parse(String(call.init.body)).limit),
      [10, 1, 8]
    )
  })

  it('reports no results as ok with an explanation and no sources', async () => {
    const { web } = setup(() => json({ success: true, data: { web: [] } }))

    const result = await web.run('web_search', { query: ' nothing ' }, { signal: signal() })

    assert.deepEqual(result, {
      status: 'ok',
      content: 'No search results found for "nothing".',
      searchResults: [],
    })
  })

  it('rejects a blank query without a request, quoting the raw input', async () => {
    const { web, calls } = setup(() => json({}))

    const result = await web.run(
      'web_search',
      { query: '  ' },
      { signal: signal(), inputJson: '{"query":"  "}' }
    )

    assert.deepEqual(result, {
      status: 'error',
      content: 'Invalid input: expected {"query": string}, got {"query":"  "}',
    })
    assert.equal(calls.length, 0)
  })
})

describe('web-research: failures', () => {
  it('distinguishes keyless 429 limit from keyed 429 limit', async () => {
    const respond = () => json({ success: false, error: 'Rate limit exceeded' }, 429)
    const keyless = setup(respond).web
    const withKey = setup(respond, { ...keyed('fc-test-123'), params: { backoff429Ms: 0 } }).web

    const a = await keyless.run('web_search', { query: 'hello' }, { signal: signal() })
    const b = await withKey.run('web_search', { query: 'hello' }, { signal: signal() })

    assert.equal(a.status, 'error')
    assert.match(a.content, /keyless daily limit reached/)
    assert.equal(b.status, 'error')
    assert.match(b.content, /rate or credit limit reached/)
  })

  it('says the key is invalid on 401', async () => {
    const { web } = setup(() => json({ error: 'Unauthorized' }, 401), keyed('fc-bad'))

    const result = await web.run('web_scrape', { url: 'https://a.example/' }, { signal: signal() })

    assert.equal(result.status, 'error')
    assert.match(result.content, /Firecrawl API key is invalid \(HTTP 401\)/)
  })

  it('passes other HTTP errors through with the server message', async () => {
    const { web } = setup(() => json({ error: { message: 'Bad query syntax' } }, 400))

    const result = await web.run('web_search', { query: 'q' }, { signal: signal() })

    assert.deepEqual(result, { status: 'error', content: 'Bad query syntax' })
  })

  it('reports a timeout as an error the model can read', async () => {
    const web = createWebResearchSlice({
      fetch: hangingFetch,
      store: memoryStore(),
      secret: null,
      params: { searchTimeoutMs: 5 },
    })

    const result = await web.run('web_search', { query: 'q' }, { signal: signal() })

    assert.deepEqual(result, {
      status: 'error',
      content: 'Firecrawl request timed out after 0.005 s.',
    })
  })

  it('reports a caller abort as aborted, not as an error', async () => {
    const web = createWebResearchSlice({ fetch: hangingFetch, store: memoryStore(), secret: null })
    const controller = new AbortController()

    const pending = web.run('web_search', { query: 'q' }, { signal: controller.signal })
    controller.abort()

    assert.deepEqual(await pending, { status: 'aborted', content: 'Aborted by user.' })
  })

  it('answers an unknown tool name with an error', async () => {
    const { web } = setup(() => json({}))
    const result: WebToolResult = await web.run('web_fly', {}, { signal: signal() })
    assert.deepEqual(result, { status: 'error', content: 'Unknown tool: web_fly' })
  })
})

describe('web-research: scrape', () => {
  it('validates URLs and truncates oversized markdown on scrape', async () => {
    const { web, calls } = setup(() =>
      json({
        success: true,
        data: {
          markdown: 'x'.repeat(30_000),
          metadata: { title: 'Long Page', sourceURL: 'https://example.com/long', statusCode: 200 },
        },
      })
    )

    const invalid = await web.run('web_scrape', { url: 'file:///etc/passwd' }, { signal: signal() })
    assert.equal(invalid.status, 'error')
    assert.match(invalid.content, /Invalid URL/)
    assert.equal(calls.length, 0, 'no request for a non-http URL')

    const scraped = await web.run(
      'web_scrape',
      { url: 'https://example.com/long' },
      { signal: signal() }
    )
    assert.deepEqual(scraped.scrapedPage, { url: 'https://example.com/long', title: 'Long Page' })
    assert.match(scraped.content, /Truncated after 24,000 characters\]$/)
  })

  it('cuts text at exactly maxToolTextChars', async () => {
    const page = (markdown: string) => () =>
      json({ success: true, data: { markdown, metadata: { sourceURL: 'https://a.example/' } } })
    // Text is "URL: https://a.example/\n\n" (25 chars) + markdown; limit 30 leaves 5 for markdown.
    const fits = setup(page('12345'), { params: { maxToolTextChars: 30 } }).web
    const over = setup(page('123456'), { params: { maxToolTextChars: 30 } }).web

    const a = await fits.run('web_scrape', { url: 'https://a.example/' }, { signal: signal() })
    const b = await over.run('web_scrape', { url: 'https://a.example/' }, { signal: signal() })

    assert.equal(a.content, 'URL: https://a.example/\n\n12345')
    assert.equal(b.content, 'URL: https://a.example/\n\n12345\n\n[Truncated after 30 characters]')
  })

  it('treats an empty page with an error status as an error', async () => {
    const { web } = setup(() =>
      json({
        success: true,
        data: { markdown: '', metadata: { statusCode: 404, error: 'Not Found' } },
      })
    )

    const result = await web.run('web_scrape', { url: 'https://a.example/x' }, { signal: signal() })

    assert.deepEqual(result, { status: 'error', content: 'Page returned HTTP 404 (Not Found).' })
  })

  it('rejects a missing url without a request', async () => {
    const { web, calls } = setup(() => json({}))

    const result = await web.run('web_scrape', { href: 'https://a.example' }, { signal: signal() })

    assert.equal(result.status, 'error')
    assert.match(result.content, /^Invalid input: expected \{"url": string\}/)
    assert.equal(calls.length, 0)
  })
})

describe('web-research: key verification', () => {
  it('verifies via credit-usage with the trimmed key', async () => {
    const { web, calls } = setup(() => json({ success: true }))

    assert.deepEqual(await web.verifyKey('  fc-test-123  '), { kind: 'valid' })
    assert.match(calls[0]?.url ?? '', /\/team\/credit-usage$/)
    assert.equal(calls[0]?.init.method, 'GET')
    assert.equal(authHeader(calls[0]), 'Bearer fc-test-123')
  })

  it('classifies 401 as invalid, other HTTP as failed, no response as unreachable', async () => {
    const invalid = setup(() => json({ error: 'bad key' }, 401)).web
    const failed = setup(() => json({ error: 'maintenance' }, 503)).web
    const unreachable = createWebResearchSlice({
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
      store: memoryStore(),
      secret: null,
    })

    assert.deepEqual(await invalid.verifyKey('k'), { kind: 'invalid' })
    assert.deepEqual(await failed.verifyKey('k'), { kind: 'failed', message: 'maintenance' })
    assert.deepEqual(await unreachable.verifyKey('k'), { kind: 'unreachable' })
  })
})

/** Desktop secret slot double: holds one value, can be told to fail. */
const fakeSecret = (initial: string | null = null) => {
  let value = initial
  let failSave = false
  let gate: Promise<void> = Promise.resolve()
  const slot: SecretSlot = {
    load: async () => {
      // Snapshot at call time, as a native read would; the gate only delays the answer.
      const read = value
      await gate
      return read
    },
    save: async (next) => {
      if (failSave) {
        throw new Error('keychain locked')
      }
      value = next
    },
  }
  return {
    slot,
    value: () => value,
    failSaves: () => {
      failSave = true
    },
    holdLoad: () => {
      let release: () => void = () => undefined
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
  }
}

const slice = (store = memoryStore(), secret: SecretSlot | null = null) =>
  createWebResearchSlice({ fetch: async () => json({}), store, secret })

describe('web-research: key storage on the web', () => {
  it('is ready at once with the stored key, trimmed; blank means keyless', () => {
    assert.deepEqual(slice(memoryStore({ [KEY]: ' fc-web ' })).getKeyState(), {
      status: 'ready',
      apiKey: 'fc-web',
    })
    assert.equal(slice(memoryStore({ [KEY]: '  ' })).getApiKey(), null)
  })

  it('saves and removes the key under the original storage key', async () => {
    const store = memoryStore()
    const web = slice(store)

    await web.setApiKey(' fc-new ')
    assert.equal(store.get(KEY), 'fc-new')
    await web.setApiKey(null)
    assert.equal(store.get(KEY), null)
    assert.equal(web.getApiKey(), null)
  })
})

describe('web-research: key storage on desktop', () => {
  it('has no key until hydrated, then the slot key', async () => {
    const web = slice(memoryStore(), fakeSecret('fc-desk').slot)

    assert.deepEqual(web.getKeyState(), { status: 'loading' })
    assert.equal(web.getApiKey(), null)
    await web.hydrate()
    assert.equal(web.getApiKey(), 'fc-desk')
  })

  it('migrates a legacy web key into the empty slot and removes the web copy', async () => {
    const store = memoryStore({ [KEY]: 'fc-legacy' })
    const secret = fakeSecret(null)
    const web = slice(store, secret.slot)

    await web.hydrate()

    assert.equal(secret.value(), 'fc-legacy')
    assert.equal(store.get(KEY), null)
    assert.equal(web.getApiKey(), 'fc-legacy')
  })

  it('keeps the slot key over a legacy one', async () => {
    const store = memoryStore({ [KEY]: 'fc-legacy' })
    const secret = fakeSecret('fc-slot')
    const web = slice(store, secret.slot)

    await web.hydrate()

    assert.equal(web.getApiKey(), 'fc-slot')
    assert.equal(secret.value(), 'fc-slot')
    assert.equal(store.get(KEY), null)
  })

  it('becomes keyless-ready when migration fails, leaving the legacy key for next launch', async () => {
    const store = memoryStore({ [KEY]: 'fc-legacy' })
    const secret = fakeSecret(null)
    secret.failSaves()
    const web = slice(store, secret.slot)

    await web.hydrate()

    assert.deepEqual(web.getKeyState(), { status: 'ready', apiKey: null })
    assert.equal(store.get(KEY), 'fc-legacy')
  })

  it('saves to the slot only, and rejects keeping the old key when the slot fails', async () => {
    const store = memoryStore()
    const secret = fakeSecret(null)
    const web = slice(store, secret.slot)
    await web.hydrate()

    await web.setApiKey('fc-2')
    assert.equal(secret.value(), 'fc-2')
    assert.equal(store.get(KEY), null)

    secret.failSaves()
    await assert.rejects(() => web.setApiKey('fc-3'), /keychain locked/)
    assert.equal(web.getApiKey(), 'fc-2')
  })

  it('lets a key saved during hydration win over the one being read', async () => {
    const secret = fakeSecret('fc-read')
    const release = secret.holdLoad()
    const web = slice(memoryStore(), secret.slot)

    const hydrating = web.hydrate()
    await web.setApiKey('fc-typed')
    release()
    await hydrating

    assert.equal(web.getApiKey(), 'fc-typed')
  })

  it('sends the hydrated slot key with tool calls', async () => {
    const { web, calls } = setup(() => json({ success: true, data: [] }), {
      secret: fakeSecret('fc-desk').slot,
    })
    await web.hydrate()

    await web.run('web_search', { query: 'q' }, { signal: signal() })

    assert.equal(authHeader(calls[0]), 'Bearer fc-desk')
  })
})

describe('web-research: desktop migration never overwrites a newer or unreadable key', () => {
  /** A slot whose reads wait for `release()`; `failLoad` makes the read fail. */
  const slotWith = (initial: string | null, options: { failLoad?: boolean } = {}) => {
    let value = initial
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slot: SecretSlot = {
      load: async () => {
        const read = value
        await gate
        if (options.failLoad) {
          throw new Error('keychain busy')
        }
        return read
      },
      save: async (next) => {
        value = next
      },
    }
    return { slot, release, value: () => value }
  }

  it('keeps a key saved while a legacy key was being migrated, in the state and the slot', async () => {
    const secret = slotWith(null)
    const store = memoryStore({ [KEY]: 'fc-legacy' })
    const web = slice(store, secret.slot)
    const hydrating = web.hydrate()
    await web.setApiKey('fc-typed')
    secret.release()
    await hydrating
    assert.equal(web.getApiKey(), 'fc-typed')
    assert.equal(secret.value(), 'fc-typed', 'the next launch reads the typed key')
    // The legacy copy waits for the next launch, which reads the saved key and removes it.
    assert.equal(store.get(KEY), 'fc-legacy')
    const nextLaunch = slice(store, {
      load: async () => secret.value(),
      save: async () => undefined,
    })
    await nextLaunch.hydrate()
    assert.equal(nextLaunch.getApiKey(), 'fc-typed')
    assert.equal(store.get(KEY), null, 'no key stays in web storage after that')
  })

  it('does not migrate over a slot it could not read, and keeps the legacy copy', async () => {
    const secret = slotWith('fc-stored', { failLoad: true })
    const store = memoryStore({ [KEY]: 'fc-legacy' })
    const web = slice(store, secret.slot)
    secret.release()
    await web.hydrate()
    assert.deepEqual(web.getKeyState(), { status: 'ready', apiKey: null })
    assert.equal(secret.value(), 'fc-stored', 'the stored key is untouched')
    assert.equal(store.get(KEY), 'fc-legacy', 'the legacy copy stays for the next launch')
  })
})

describe('web-research: ToolCapability, toggle, citation renumbering, and archive serialization', () => {
  it('owns chat-demo:search toggle, formats race-free citations, and serializes search/scrape', async () => {
    const store = memoryStore()
    const { web } = setup(
      (call) =>
        call.url.endsWith('/search')
          ? json({
              success: true,
              data: {
                web: [
                  { url: 'https://a.example/', title: 'Alpha', description: 'First.' },
                  { url: 'https://b.example/', title: 'Beta', description: 'Second.' },
                ],
              },
            })
          : json({
              success: true,
              data: {
                markdown: '# Page',
                metadata: { title: 'Page Title', sourceURL: 'https://a.example/' },
              },
            }),
      { store }
    )

    const toggle = web.capability.toggle
    assert.ok(toggle)
    assert.equal(toggle.isEnabled(), false)
    let notifications = 0
    toggle.subscribe(() => {
      notifications += 1
    })
    toggle.setEnabled(true)
    assert.equal(toggle.isEnabled(), true)
    assert.equal(store.get('chat-demo:search'), 'true')
    assert.equal(notifications, 1)

    assert.equal(web.capability.effectOf('web_search'), 'read')
    assert.equal(web.capability.effectOf('web_scrape'), 'read')
    assert.equal(web.capability.effectOf('research'), 'spawn')
    assert.ok(web.capability.agentProfile?.('research'))
    assert.equal(web.capability.describe?.('research', 'agent'), null)
    assert.ok(web.capability.describe?.('research', 'reply'))

    const ctx = {
      sessionId: 's1',
      replyId: 'r1',
      signal: signal(),
      caller: { kind: 'reply' as const },
      citedUrls: new Map<string, number>(),
      isActive: () => true,
      onProgress: () => {},
      readReplyState: () => undefined,
      writeReplyState: () => {},
    }

    const searchRes = await web.capability.run(
      { id: 'c1', name: 'web_search', input: { query: 'test query' } },
      ctx
    )
    assert.equal(searchRes.status, 'ok')
    assert.equal(searchRes.sources?.length, 2)
    assert.ok(searchRes.formatContentWithCitations)
    const renumbered = searchRes.formatContentWithCitations(
      new Map([
        ['https://a.example/', 5],
        ['https://b.example/', 6],
      ])
    )
    assert.match(renumbered, /^\[5\] Alpha/m)
    assert.match(renumbered, /^\[6\] Beta/m)

    const searchArchive = web.capability.serializeForArchive?.(
      { id: 'c1', name: 'web_search', input: { query: 'test query' } },
      {
        tool_use_id: 'c1',
        content: searchRes.content,
        status: 'ok',
        sources: searchRes.sources,
        payload: searchRes.payload,
      }
    )
    assert.equal(searchArchive?.[0]?.type, 'TOOL_SEARCH')
    if (searchArchive?.[0]?.type === 'TOOL_SEARCH') {
      assert.deepEqual(searchArchive[0].queries, ['test query'])
      assert.equal(searchArchive[0].results.length, 2)
    }

    const scrapeRes = await web.capability.run(
      { id: 'c2', name: 'web_scrape', input: { url: 'https://a.example/' } },
      ctx
    )
    assert.equal(scrapeRes.status, 'ok')
    const scrapeArchive = web.capability.serializeForArchive?.(
      { id: 'c2', name: 'web_scrape', input: { url: 'https://a.example/' } },
      { tool_use_id: 'c2', content: scrapeRes.content, status: 'ok', payload: scrapeRes.payload }
    )
    assert.equal(scrapeArchive?.[0]?.type, 'TOOL_OPEN')
    web.dispose()
  })
})
