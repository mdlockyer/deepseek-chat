import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HttpFetch } from '@deepseek-chat/spine/ports'
import { ApiError, requestWith } from '@deepseek-chat/slice-conversations'

describe('request timeouts and abort handling', () => {
  it('aborts a hanging request with a network ApiError when timeoutMs elapses', async () => {
    const hangingFetch: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        )
      })

    await assert.rejects(
      () => requestWith(hangingFetch, 'https://api.deepseek.com/models', { method: 'GET' }, 15),
      (error: unknown) =>
        error instanceof ApiError &&
        error.kind === 'network' &&
        error.localMessage?.key === 'requestTimedOut'
    )
  })

  it('forwards external AbortSignal without misreporting it as a timeout', async () => {
    const external = new AbortController()
    const hangingFetch: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Caller aborted', 'AbortError')),
          { once: true }
        )
      })

    setTimeout(() => external.abort(), 5)

    await assert.rejects(
      () =>
        requestWith(
          hangingFetch,
          'https://api.deepseek.com/models',
          { method: 'GET', signal: external.signal },
          5000
        ),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    )
  })

  it('returns the response when fetch resolves before timeoutMs', async () => {
    const okFetch: HttpFetch = async () => new Response('ok', { status: 200 })

    const response = await requestWith(
      okFetch,
      'https://api.deepseek.com/models',
      { method: 'GET' },
      5000
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ok')
  })
})
