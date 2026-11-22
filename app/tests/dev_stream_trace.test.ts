/**
 * The dev server's stream-trace endpoint (rspack.config.ts). It writes to the developer's disk,
 * and the dev server listens on every interface, so only this machine may write, by POST, a
 * bounded JSON line.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { createStreamTraceHandler } from '../../rspack.config.js'

/** Sends one request through the handler; resolves with the status and the lines written. */
const send = (request: { method: string; from: string; body: string }) =>
  new Promise<{ status: number; lines: string[] }>((resolve) => {
    const lines: string[] = []
    const req = Object.assign(new EventEmitter(), {
      method: request.method,
      socket: { remoteAddress: request.from },
      destroy: () => undefined,
    })
    const res = {
      statusCode: 200,
      setHeader: () => undefined,
      end: () => resolve({ status: res.statusCode, lines }),
    }
    createStreamTraceHandler((line) => lines.push(line))(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse
    )
    // Deliver the body in 16 KB chunks, as a socket would.
    for (let at = 0; at < request.body.length; at += 16_384) {
      req.emit('data', Buffer.from(request.body.slice(at, at + 16_384)))
    }
    req.emit('end')
  })

const trace = JSON.stringify({ round: 0, firstEventMs: 12, blocks: [] })

describe('dev stream-trace endpoint', () => {
  it('appends one line for a JSON POST from this machine', async () => {
    for (const from of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const { status, lines } = await send({ method: 'POST', from, body: trace })
      assert.equal(status, 204, from)
      assert.deepEqual(lines, [`${trace}\n`], from)
    }
  })

  it('refuses other machines, other methods, non-JSON and oversized bodies, writing nothing', async () => {
    const refused = [
      { method: 'POST', from: '192.168.1.20', body: trace },
      { method: 'POST', from: '100.114.208.4', body: trace },
      { method: 'GET', from: '127.0.0.1', body: '' },
      { method: 'POST', from: '127.0.0.1', body: 'not json' },
      // Far beyond any real trace (a trace holds sizes and timings only).
      { method: 'POST', from: '127.0.0.1', body: `{"pad":"${'a'.repeat(5_000_000)}"}` },
    ]
    for (const request of refused) {
      const { status, lines } = await send(request)
      const label = `${request.method} from ${request.from}, ${request.body.length} bytes`
      assert.ok(status >= 400, `${label}: status ${status}`)
      assert.deepEqual(lines, [], label)
    }
  })
})
