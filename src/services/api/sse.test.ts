import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ServerSentEventDecoder, readServerSentEvents } from './sse.js'

describe('ServerSentEventDecoder', () => {
  it('joins multiline data fields and strips at most one leading space', () => {
    const decoder = new ServerSentEventDecoder()
    const events = decoder.push(
      'event: delta\nid: 42\ndata: line 1\ndata:  line 2\ndata:line 3\n\n'
    )
    assert.deepEqual(events, [
      {
        event: 'delta',
        data: 'line 1\n line 2\nline 3',
        lastEventId: '42',
      },
    ])
  })

  it('defaults event type to message, preserves lastEventId, and ignores NUL in id', () => {
    const decoder = new ServerSentEventDecoder()
    const events = decoder.push(
      'id: evt-1\ndata: first\n\n: keep-alive\n\nid: bad\0id\ndata: second\n\n'
    )
    assert.deepEqual(events, [
      { event: 'message', data: 'first', lastEventId: 'evt-1' },
      { event: 'message', data: 'second', lastEventId: 'evt-1' },
    ])
  })

  it('handles CRLF split across chunk boundaries and discards unterminated trailing data', () => {
    const decoder = new ServerSentEventDecoder()
    assert.deepEqual(decoder.push('data: hello\r'), [])
    assert.deepEqual(decoder.push('\n\rdata: world'), [
      { event: 'message', data: 'hello', lastEventId: '' },
    ])
    assert.deepEqual(decoder.push('\r'), [])
    assert.deepEqual(decoder.end(), [])

    const singleCr = new ServerSentEventDecoder()
    assert.deepEqual(singleCr.push('data: final\n\r'), [])
    assert.deepEqual(singleCr.end(), [{ event: 'message', data: 'final', lastEventId: '' }])
  })

  it('flushes a pending event when end() completes a trailing CR blank line', () => {
    const decoder = new ServerSentEventDecoder()
    assert.deepEqual(decoder.push('data: last\n\r'), [])
    assert.deepEqual(decoder.end(), [{ event: 'message', data: 'last', lastEventId: '' }])
  })
})

describe('readServerSentEvents', () => {
  it('decodes split multi-byte UTF-8 characters across stream chunks', async () => {
    const encoder = new TextEncoder()
    const payload = encoder.encode('data: 你好世界\n\n')
    // Split in the middle of the first 3-byte UTF-8 character (`你` starts at byte 6).
    const chunk1 = payload.subarray(0, 7)
    const chunk2 = payload.subarray(7)

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1)
        controller.enqueue(chunk2)
        controller.close()
      },
    })

    const received = []
    for await (const event of readServerSentEvents(stream)) {
      received.push(event)
    }

    assert.deepEqual(received, [{ event: 'message', data: '你好世界', lastEventId: '' }])
  })
})
