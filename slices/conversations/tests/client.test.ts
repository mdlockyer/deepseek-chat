import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ApiError, request } from '@deepseek-chat/slice-conversations'
import { installTestSlice } from './harness.js'

installTestSlice()

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('request timeouts and abort handling', () => {
  it('aborts a hanging request with a network ApiError when timeoutMs elapses', async () => {
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        )
      })) as typeof fetch

    await assert.rejects(
      () => request('https://api.deepseek.com/models', { method: 'GET' }, 15),
      (error: unknown) =>
        error instanceof ApiError &&
        error.kind === 'network' &&
        error.localMessage?.key === 'requestTimedOut'
    )
  })

  it('forwards external AbortSignal without misreporting it as a timeout', async () => {
    const external = new AbortController()
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Caller aborted', 'AbortError')),
          { once: true }
        )
      })) as typeof fetch

    setTimeout(() => external.abort(), 5)

    await assert.rejects(
      () =>
        request(
          'https://api.deepseek.com/models',
          { method: 'GET', signal: external.signal },
          5000
        ),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    )
  })

  it('returns the response when fetch resolves before timeoutMs', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch

    const response = await request('https://api.deepseek.com/models', { method: 'GET' }, 5000)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ok')
  })
})
