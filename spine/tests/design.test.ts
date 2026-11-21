import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Toast,
  acquireOverlay,
  getToast,
  isOverlayOpen,
  onOverlayChange,
  showToast,
} from '@deepseek-chat/spine/design'
import { setLocale } from '@deepseek-chat/spine/i18n'

describe('design overlay', () => {
  it('announces only the first open and the last close', () => {
    const seen: boolean[] = []
    const unsubscribe = onOverlayChange((open) => seen.push(open))

    const releaseMenu = acquireOverlay()
    const releaseModal = acquireOverlay()
    releaseMenu()
    assert.equal(isOverlayOpen(), true, 'modal still open')
    releaseModal()
    unsubscribe()

    assert.deepEqual(seen, [true, false])
    assert.equal(isOverlayOpen(), false)
  })

  it('ignores a second release of the same overlay', () => {
    const seen: boolean[] = []
    const unsubscribe = onOverlayChange((open) => seen.push(open))

    const releaseA = acquireOverlay()
    const releaseB = acquireOverlay()
    releaseA()
    releaseA()
    assert.equal(isOverlayOpen(), true, 'B is still open despite A released twice')
    releaseB()
    unsubscribe()

    assert.deepEqual(seen, [true, false])
  })
})

describe('design toast', () => {
  // Node ≥ 20.4 takes { apis }; the repo's @types/node (20.9) still types the older array form.
  beforeEach(() =>
    mock.timers.enable({ apis: ['setTimeout'] } as unknown as Parameters<
      typeof mock.timers.enable
    >[0])
  )
  afterEach(() => {
    mock.timers.reset()
    setLocale('en-US')
  })

  it('replaces the current toast and hides it after 3 s', () => {
    showToast({ text: () => 'first' })
    showToast({ text: () => 'second' })
    assert.equal(getToast().content?.text(), 'second')

    mock.timers.tick(2999)
    assert.notEqual(getToast().content, null)
    mock.timers.tick(1)
    assert.equal(getToast().content, null)
  })

  it('keeps a toast with a link for 5 s', () => {
    showToast({ text: () => 'quota', link: { text: () => 'details', href: 'https://x.test' } })

    mock.timers.tick(4999)
    assert.notEqual(getToast().content, null)
    mock.timers.tick(1)
    assert.equal(getToast().content, null)
  })

  it('does not let an old timer hide a newer toast', () => {
    showToast({ text: () => 'old' })
    mock.timers.tick(2000)
    showToast({ text: () => 'new' })
    // old toast's 3 s would end at t=3000; the new one lives until t=5000.
    mock.timers.tick(1500)
    assert.equal(getToast().content?.text(), 'new')
  })

  it('renders text in the locale current at render time, with tone and link', () => {
    showToast({
      text: () => (globalThis as { __locale?: string }).__locale ?? 'unset',
      tone: 'error',
      link: { text: () => 'Top up', href: 'https://pay.test/' },
    })
    ;(globalThis as { __locale?: string }).__locale = 'rendered-now'

    const html = renderToStaticMarkup(createElement(Toast))

    assert.match(html, /role="status"/)
    assert.match(html, /rendered-now/)
    assert.match(html, /<a [^>]*href="https:\/\/pay\.test\/"[^>]*>Top up<\/a>/)
    assert.match(html, /class="[^"]*error/)
  })
})
