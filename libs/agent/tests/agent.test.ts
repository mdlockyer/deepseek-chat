import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApiError,
  DEEPSEEK_MODELS,
  MAX_REQUEST_BYTES,
  ServerSentEventDecoder,
  applyEvent,
  classifyApiError,
  createDeepSeekProvider,
  emptyTranscript,
  isRetryableApiError,
  readMessageEvent,
  readServerSentEvents,
  request,
  resolveModelSpec,
  type CreateMessageRequest,
  type MessageStreamEvent,
} from '@deepseek-chat/lib-agent'
import type { HttpFetch } from '@deepseek-chat/spine/ports'

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

const sampleRequest = (overrides: Partial<CreateMessageRequest> = {}): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: 'You are a helper.',
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'enabled' },
  tools: [],
  ...overrides,
})

const makeProvider = (fetchFn: HttpFetch) =>
  createDeepSeekProvider({
    fetch: fetchFn,
    apiOrigin: 'https://api.test',
    getApiKey: () => 'sk-test',
  })

const encodeEvents = (events: unknown[]) =>
  new TextEncoder().encode(
    events
      .map((event) => {
        const type = (event as { type?: string }).type ?? 'message'
        return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
      })
      .join('')
  )

const chunkedStream = (bytes: Uint8Array, cutPoints: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0
      for (const cut of cutPoints) {
        if (cut > offset && cut <= bytes.length) {
          controller.enqueue(bytes.subarray(offset, cut))
          offset = cut
        }
      }
      if (offset < bytes.length) {
        controller.enqueue(bytes.subarray(offset))
      }
      controller.close()
    },
  })

const drain = async (gen: AsyncIterable<unknown>) => {
  const out = []
  for await (const item of gen) {
    out.push(item)
  }
  return out
}

describe('libs/agent SSE chunk invariance and pure reducer', () => {
  it('produces the exact same transcript regardless of random SSE byte chunk boundaries', async () => {
    const usage = {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4,
      output_tokens: 28,
    }
    const events: MessageStreamEvent[] = [
      { type: 'message_start', message: { id: 'msg-1', model: 'deepseek-flash', usage } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思考：先查数据 🚀' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-abc' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu-1', name: 'web_search', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"query":"你好' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: ' 世界","limit":3}' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: '结果已找到。' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 42 },
      },
      { type: 'message_stop' },
    ]
    const payload = encodeEvents(events)

    const runWithCuts = async (cuts: number[]) => {
      const provider = makeProvider(
        async () =>
          new Response(chunkedStream(payload, cuts), {
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          })
      )
      let transcript = emptyTranscript()
      let clock = 1_000
      for await (const event of provider.streamMessage(
        sampleRequest(),
        new AbortController().signal
      )) {
        const before = structuredClone(transcript)
        const next = applyEvent(transcript, event, clock)
        // Purity check: previous transcript object is never mutated.
        assert.deepEqual(transcript, before)
        transcript = next
        clock += 10
      }
      return transcript
    }

    const reference = await runWithCuts([])
    assert.equal(reference.stopReason, 'tool_use')
    // Partial message_delta usage merges with message_start usage instead of clobbering input/cache tokens.
    assert.deepEqual(reference.usage, {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4,
      output_tokens: 42,
    })
    assert.equal(reference.blocks.length, 3)
    assert.deepEqual(reference.blocks[1], {
      type: 'tool_use',
      id: 'tu-1',
      name: 'web_search',
      input: { query: '你好 世界', limit: 3 },
    })

    const rand = seeded(20261123)
    for (let trial = 0; trial < 25; trial++) {
      const cutCount = 1 + Math.floor(rand() * 40)
      const cuts = Array.from({ length: cutCount }, () => Math.floor(rand() * payload.length)).sort(
        (a, b) => a - b
      )
      const actual = await runWithCuts(cuts)
      assert.deepEqual(actual, reference)
    }
  })

  it('parses Anthropic-style minimal usage without cache fields and drops legacy DeepSeek server-tool events', () => {
    const start = readMessageEvent({
      type: 'message_start',
      message: { id: 'm1', model: 'claude-sonnet', usage: { input_tokens: 150, output_tokens: 1 } },
    })
    assert.deepEqual(start, {
      type: 'message_start',
      message: {
        id: 'm1',
        model: 'claude-sonnet',
        usage: {
          input_tokens: 150,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    })

    const delta = readMessageEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', title: 'Ignored Proprietary Title' },
      usage: { output_tokens: 88 },
    })
    assert.deepEqual(delta, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 88 },
    })

    // Legacy DeepSeek server tools and citations_delta are dropped cleanly.
    assert.equal(
      readMessageEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 's1',
          name: 'deepseek_web_search',
          kind: 'search',
          input: { action: 'search', queries: ['q'] },
        },
      }),
      null
    )
    assert.equal(
      readMessageEvent({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: { type: 'web_search_result_location', url: 'https://example.com', title: null },
        },
      }),
      null
    )
  })

  it('preserves malformed tool_use inputJson without throwing and supports CRLF/BOM decoding', async () => {
    const decoder = new ServerSentEventDecoder()
    assert.deepEqual(decoder.push('data: alpha\r\n\r\n'), [
      { event: 'message', data: 'alpha', lastEventId: '' },
    ])
    const events: MessageStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'bad-1', name: 'tool', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not json' },
      },
      { type: 'content_block_stop', index: 0 },
    ]
    let t = emptyTranscript()
    for (const e of events) {
      t = applyEvent(t, e, 100)
    }
    assert.deepEqual(t.blocks, [
      { type: 'tool_use', id: 'bad-1', name: 'tool', input: {}, inputJson: '{not json' },
    ])

    const stream = chunkedStream(new TextEncoder().encode('\uFEFFdata: ok\n\n'), [2, 5])
    const decoded = []
    for await (const sse of readServerSentEvents(stream)) {
      decoded.push(sse)
    }
    assert.deepEqual(decoded, [{ event: 'message', data: 'ok', lastEventId: '' }])
    assert.equal(readMessageEvent({ type: 'unknown' }), null)
  })
})

describe('libs/agent ModelSpec and DeepSeek ModelProvider', () => {
  it('resolves known and fallback ModelSpecs cleanly', () => {
    const flash = resolveModelSpec(DEEPSEEK_MODELS, 'deepseek', 'deepseek-flash')
    assert.equal(flash.id, 'deepseek-flash')
    assert.equal(flash.provider, 'deepseek')
    assert.ok(flash.contextWindow > 0 && flash.maxOutputTokens > 0)
    assert.equal(flash.capabilities.promptCaching, true)

    const custom = resolveModelSpec(DEEPSEEK_MODELS, 'custom', 'my-custom-model')
    assert.equal(custom.id, 'my-custom-model')
    assert.equal(custom.provider, 'custom')
    assert.ok(custom.contextWindow > 0 && custom.maxOutputTokens > 0)
  })

  it('sends standard Anthropic Messages requests without DeepSeek-proprietary fields and scopes Files beta header', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      []
    const provider = makeProvider(async (url, init) => {
      seen.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      })
      const payload = encodeEvents([
        { type: 'message_start', message: { id: 'm1', model: 'deepseek-flash' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
      return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } })
    })

    // Plain request with base64 image: no anthropic-beta header, no safety_check/title.
    await drain(
      provider.streamMessage(
        sampleRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
                },
                { type: 'text', text: 'describe' },
              ],
            },
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'hmm' },
                { type: 'text', text: 'a dot' },
              ],
            },
            { role: 'user', content: 'thanks' },
          ],
        }),
        new AbortController().signal
      )
    )
    assert.equal(seen[0]?.url, 'https://api.test/anthropic/v1/messages')
    assert.equal(seen[0]?.headers['anthropic-beta'], undefined)
    assert.equal('safety_check' in (seen[0]?.body ?? {}), false)
    assert.equal('title' in (seen[0]?.body ?? {}), false)
    // Thinking block without signature gets normalized to signature: '' inside the DeepSeek wire adapter.
    const firstSeen = seen[0]
    assert.ok(firstSeen)
    const assistantMsg = (firstSeen.body.messages as { role: string; content: unknown[] }[])[1]
    assert.deepEqual(assistantMsg?.content[0], {
      type: 'thinking',
      thinking: 'hmm',
      signature: '',
    })

    // Request with remote file_id: sets anthropic-beta header.
    await drain(
      provider.streamMessage(
        sampleRequest({
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'file', file_id: 'file-api-9' } }],
            },
          ],
        }),
        new AbortController().signal
      )
    )
    assert.equal(seen[1]?.headers['anthropic-beta'], 'files-api-2025-04-14')
  })

  it('encapsulates DeepSeek Files API purposes, size caps, invalidation IDs, and quota classification', async () => {
    const purposes: Array<FormDataEntryValue | null> = []
    const provider = makeProvider(async (url, init) => {
      assert.equal(url, 'https://api.test/anthropic/v1/files')
      const form = init.body as FormData
      purposes.push(form.get('purpose'))
      return new Response(
        JSON.stringify({
          id: `file-api-${purposes.length}`,
          type: 'file',
          size_bytes: 4,
          created_at: new Date(0).toISOString(),
          filename: 'f',
          mime_type: 'application/octet-stream',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const att = provider.attachments
    assert.ok(att)
    assert.equal(
      await att.upload({
        id: '1',
        blob: new Blob(['pdf']),
        name: 'report.pdf',
        mimeType: 'application/pdf',
        isImage: false,
      }),
      'file-api-1'
    )
    assert.equal(
      await att.upload({
        id: '2',
        blob: new Blob(['csv']),
        name: 'data.csv',
        mimeType: 'text/csv',
        isImage: false,
      }),
      'file-api-2'
    )
    assert.equal(
      await att.upload({
        id: '3',
        blob: new Blob(['png']),
        name: 'pic.png',
        mimeType: 'image/png',
        isImage: true,
      }),
      'file-api-3'
    )
    assert.deepEqual(purposes, ['rich_layout_recognition', 'user_data', null])
    assert.equal(att.maxFileSizeMB?.('data.csv', false), 32)
    assert.equal(att.maxFileSizeMB?.('report.pdf', false), 64)
    assert.equal(att.maxFileSizeMB?.('pic.png', true), 64)

    const missing = new ApiError(
      'http',
      'file_ids do not exist or are not created under your account: file-api-1, file-api-2',
      400
    )
    assert.deepEqual(att.invalidatedFileIds(missing), ['file-api-1', 'file-api-2'])
    assert.equal(att.invalidatedFileIds(new ApiError('http', 'unrelated bad request', 400)), null)

    const quota = new ApiError('http', 'User file count limit exceeded (limit 500)', 400)
    assert.deepEqual(att.classifyUploadError(quota), { code: 'fileCountLimit', limit: '500' })
    assert.equal(isRetryableApiError(quota), false)
  })
})

describe('libs/agent error classification and timeouts', () => {
  it('maps HTTP, contextOverflow, payloadTooLarge, protocol, stream, interrupted, and network errors accurately', async () => {
    const controller = new AbortController()

    // HTTP 429 JSON error
    await assert.rejects(
      async () => {
        const provider = makeProvider(
          async () =>
            new Response(JSON.stringify({ error: { message: 'Slow down' } }), {
              status: 429,
              headers: { 'Content-Type': 'application/json' },
            })
        )
        await drain(provider.streamMessage(sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'http' &&
        err.status === 429 &&
        err.message === 'Slow down' &&
        classifyApiError(err) === 'rateLimited' &&
        isRetryableApiError(err)
    )

    // HTTP 400 context overflow
    const overflow = new ApiError(
      'http',
      "This model's maximum context length is 128000 tokens.",
      400
    )
    assert.equal(classifyApiError(overflow), 'contextOverflow')
    assert.equal(isRetryableApiError(overflow), false)

    // Protocol error: non-SSE response
    await assert.rejects(
      async () => {
        const provider = makeProvider(
          async () =>
            new Response(JSON.stringify({ error: { message: 'Unexpected JSON' } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        )
        await drain(provider.streamMessage(sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError && err.kind === 'protocol' && err.message === 'Unexpected JSON'
    )

    // Protocol error: request body > MAX_REQUEST_BYTES -> classified as payloadTooLarge
    await assert.rejects(
      async () => {
        const provider = makeProvider(async () => new Response('', { status: 200 }))
        const huge = 'a'.repeat(MAX_REQUEST_BYTES + 10)
        await drain(
          provider.streamMessage(
            sampleRequest({ messages: [{ role: 'user', content: huge }] }),
            controller.signal
          )
        )
      },
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'protocol' &&
        classifyApiError(err) === 'payloadTooLarge' &&
        !isRetryableApiError(err)
    )

    // Stream error: SSE event: error with JSON error payload
    await assert.rejects(
      async () => {
        const provider = makeProvider(
          async () =>
            new Response('event: error\ndata: {"error":{"message":"overloaded"}}\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            })
        )
        await drain(provider.streamMessage(sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError && err.kind === 'stream' && err.message === 'overloaded'
    )

    // Stream error: SSE event: error with non-JSON data
    await assert.rejects(
      async () => {
        const provider = makeProvider(
          async () =>
            new Response('event: error\ndata: raw failure\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            })
        )
        await drain(provider.streamMessage(sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError && err.kind === 'stream' && err.message === 'raw failure'
    )

    // Interrupted error: stream closes before message_stop
    await assert.rejects(
      async () => {
        const payload = encodeEvents([
          { type: 'message_start', message: { id: 'm1', model: 'deepseek-flash' } },
        ])
        const provider = makeProvider(
          async () => new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } })
        )
        await drain(provider.streamMessage(sampleRequest(), controller.signal))
      },
      (err: unknown) => err instanceof ApiError && err.kind === 'interrupted'
    )

    // Network timeout error
    await assert.rejects(
      () =>
        request(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true }
              )
            }),
          'https://api.test/models',
          { method: 'GET' },
          15
        ),
      (err: unknown) => err instanceof ApiError && err.kind === 'network' && err.timedOut === true
    )
  })
})
