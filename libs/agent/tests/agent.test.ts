import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApiError,
  MAX_REQUEST_BYTES,
  ServerSentEventDecoder,
  applyEvent,
  classifyApiError,
  emptyTranscript,
  extractFileIds,
  getFileErrorCode,
  getUploadErrorInfo,
  isRetryableApiError,
  readMessageEvent,
  readServerSentEvents,
  request,
  streamMessage,
  type AgentIO,
  type CreateMessageRequest,
  type MessageStreamEvent,
} from '@deepseek-chat/lib-agent'

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

const makeIO = (fetchFn: AgentIO['fetch']): AgentIO => ({
  fetch: fetchFn,
  apiOrigin: 'https://api.test',
  apiKey: () => 'sk-test',
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
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://example.com',
            title: 'Example',
            cited_text: '结果已找到。',
            encrypted_index: '',
          },
        },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { ...usage, output_tokens: 42 },
      },
      { type: 'message_stop' },
    ]
    const payload = encodeEvents(events)

    const runWithCuts = async (cuts: number[]) => {
      const io = makeIO(
        async () =>
          new Response(chunkedStream(payload, cuts), {
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          })
      )
      let transcript = emptyTranscript()
      let clock = 1_000
      for await (const event of streamMessage(io, sampleRequest(), new AbortController().signal)) {
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
    assert.equal(reference.usage?.output_tokens, 42)
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

const drain = async (gen: AsyncIterable<unknown>) => {
  const out = []
  for await (const item of gen) {
    out.push(item)
  }
  return out
}

describe('libs/agent streamMessage and request error mapping', () => {
  it('maps HTTP, protocol, stream, interrupted, and network errors to the right ApiError kind', async () => {
    const controller = new AbortController()

    // HTTP 429 JSON error
    await assert.rejects(
      async () => {
        const io = makeIO(
          async () =>
            new Response(JSON.stringify({ error: { message: 'Slow down' } }), {
              status: 429,
              headers: { 'Content-Type': 'application/json' },
            })
        )
        await drain(streamMessage(io, sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'http' &&
        err.status === 429 &&
        err.message === 'Slow down' &&
        classifyApiError(err) === 'rateLimited' &&
        isRetryableApiError(err)
    )

    // Protocol error: non-SSE response
    await assert.rejects(
      async () => {
        const io = makeIO(
          async () =>
            new Response(JSON.stringify({ error: { message: 'Unexpected JSON' } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        )
        await drain(streamMessage(io, sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError && err.kind === 'protocol' && err.message === 'Unexpected JSON'
    )

    // Protocol error: request body > MAX_REQUEST_BYTES
    await assert.rejects(
      async () => {
        const io = makeIO(async () => new Response('', { status: 200 }))
        const huge = 'a'.repeat(MAX_REQUEST_BYTES + 10)
        await drain(
          streamMessage(
            io,
            sampleRequest({ messages: [{ role: 'user', content: huge }] }),
            controller.signal
          )
        )
      },
      (err: unknown) => err instanceof ApiError && err.kind === 'protocol'
    )

    // Stream error: SSE event: error with JSON error payload
    await assert.rejects(
      async () => {
        const io = makeIO(
          async () =>
            new Response('event: error\ndata: {"error":{"message":"overloaded"}}\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            })
        )
        await drain(streamMessage(io, sampleRequest(), controller.signal))
      },
      (err: unknown) =>
        err instanceof ApiError && err.kind === 'stream' && err.message === 'overloaded'
    )

    // Stream error: SSE event: error with non-JSON data
    await assert.rejects(
      async () => {
        const io = makeIO(
          async () =>
            new Response('event: error\ndata: raw failure\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            })
        )
        await drain(streamMessage(io, sampleRequest(), controller.signal))
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
        const io = makeIO(
          async () => new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } })
        )
        await drain(streamMessage(io, sampleRequest(), controller.signal))
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

  it('classifies file and upload 400 errors accurately', () => {
    const missing = new ApiError(
      'http',
      'file_ids do not exist or are not created under your account: file-api-1, file-api-2',
      400
    )
    assert.equal(getFileErrorCode(missing), 'fileIdMissing')
    assert.deepEqual(extractFileIds(missing.message), ['file-api-1', 'file-api-2'])

    const quota = new ApiError('http', 'User file count limit exceeded (limit 500)', 400)
    assert.deepEqual(getUploadErrorInfo(quota), { code: 'fileCountLimit', limit: '500' })
    assert.equal(isRetryableApiError(quota), false)
  })
})
