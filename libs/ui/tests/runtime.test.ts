import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocale } from '@deepseek-chat/spine/i18n'
import {
  HOVER_GLIDE_ITEM_ATTR,
  HoverGlideIndicator,
  INITIAL_HOVER_GLIDE_STATE,
  ToastViewport,
  UiProvider,
  VIEWPORT_PADDING,
  computeAnchoredPosition,
  createNoticeBus,
  createOverlayCoordinator,
  enterGlideTarget,
  expireGlideCooldown,
  hoverGlideItem,
  leaveGlideTarget,
  measureGlideRect,
  syncGlideRect,
  type GlideRect,
} from '@deepseek-chat/lib-ui'

const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('lib-ui OverlayCoordinator', () => {
  it('announces only 0->1 and 1->0 transitions and ignores duplicate releases', () => {
    const coord = createOverlayCoordinator()
    const seen: boolean[] = []
    const unsub = coord.subscribe((open) => seen.push(open))

    const releaseA = coord.acquire()
    const releaseB = coord.acquire()
    assert.equal(coord.isOpen(), true)
    releaseA()
    releaseA()
    assert.equal(coord.isOpen(), true)
    releaseB()
    assert.equal(coord.isOpen(), false)
    unsub()

    assert.deepEqual(seen, [true, false])
  })

  it('matches a reference active-lock set across randomized acquire/release sequences', () => {
    const rand = mulberry32(42)
    const coord = createOverlayCoordinator()
    const active: Array<() => void> = []
    const transitions: boolean[] = []
    coord.subscribe((open) => transitions.push(open))

    for (let step = 0; step < 120; step += 1) {
      const wasOpen = active.length > 0
      if (active.length === 0 || rand() < 0.55) {
        active.push(coord.acquire())
      } else {
        const idx = Math.floor(rand() * active.length)
        const [release] = active.splice(idx, 1)
        release?.()
        // Duplicate release must be an idempotent no-op.
        release?.()
      }
      const isNowOpen = active.length > 0
      assert.equal(coord.isOpen(), isNowOpen)
      if (wasOpen !== isNowOpen) {
        assert.equal(transitions.at(-1), isNowOpen)
      }
    }
    while (active.length > 0) {
      active.pop()?.()
    }
    assert.equal(coord.isOpen(), false)
  })
})

describe('lib-ui NoticeBus & ToastViewport', () => {
  beforeEach(() =>
    mock.timers.enable({ apis: ['setTimeout'] } as unknown as Parameters<
      typeof mock.timers.enable
    >[0])
  )
  afterEach(() => {
    mock.timers.reset()
    setLocale('en-US')
  })

  it('replaces the active notice, cancels stale timers, and keeps linked notices longer', () => {
    const bus = createNoticeBus()
    bus.show({ text: () => 'first' })
    mock.timers.tick(2000)
    bus.show({ text: () => 'second' })
    mock.timers.tick(1500)
    assert.equal(bus.getSnapshot().content?.text(), 'second')
    mock.timers.tick(1500)
    assert.equal(bus.getSnapshot().content, null)

    bus.show({ text: () => 'quota', link: { text: () => 'details', href: 'https://example.test' } })
    mock.timers.tick(4999)
    assert.notEqual(bus.getSnapshot().content, null)
    mock.timers.tick(1)
    assert.equal(bus.getSnapshot().content, null)
  })

  it('renders active notice inside ToastViewport via UiProvider in the live locale', () => {
    const bus = createNoticeBus()
    let message = 'initial'
    bus.show({
      text: () => message,
      tone: 'error',
      link: { text: () => 'Details', href: 'https://example.test/' },
    })
    message = 'rendered-now'

    const html = renderToStaticMarkup(
      createElement(UiProvider, { notices: bus }, createElement(ToastViewport))
    )
    assert.match(html, /role="status"/)
    assert.match(html, /rendered-now/)
    assert.match(html, /href="https:\/\/example\.test\/"/)
  })
})

describe('lib-ui computeAnchoredPosition invariants', () => {
  it('keeps floating boxes inside viewport bounds across randomized geometries', () => {
    const rand = mulberry32(1337)
    const sides = ['top', 'bottom'] as const
    const aligns = ['start', 'center', 'end'] as const

    for (let i = 0; i < 200; i += 1) {
      const vw = 360 + Math.floor(rand() * 1200)
      const vh = 480 + Math.floor(rand() * 800)
      const aw = 24 + Math.floor(rand() * 160)
      const ah = 24 + Math.floor(rand() * 48)
      const al = Math.floor(rand() * Math.max(1, vw - aw))
      const at = Math.floor(rand() * Math.max(1, vh - ah))
      const fw = 80 + Math.floor(rand() * 200)
      const fh = 40 + Math.floor(rand() * 180)
      const side = sides[Math.floor(rand() * sides.length)]
      const align = aligns[Math.floor(rand() * aligns.length)]

      const pos = computeAnchoredPosition({
        anchor: { left: al, right: al + aw, top: at, bottom: at + ah, width: aw, height: ah },
        floating: { width: fw, height: fh, scrollHeight: fh },
        viewport: { width: vw, height: vh },
        options: { side, align, offset: 4 },
      })

      assert.ok(pos.left !== undefined)
      assert.ok(
        pos.left >= VIEWPORT_PADDING,
        `left ${pos.left} violated VIEWPORT_PADDING (${VIEWPORT_PADDING})`
      )
      if (fw + VIEWPORT_PADDING * 2 <= vw) {
        assert.ok(
          pos.left + fw <= vw - VIEWPORT_PADDING + 0.01,
          `right edge ${pos.left + fw} overflowed viewport ${vw}`
        )
      }
      if (fh + VIEWPORT_PADDING * 2 <= vh) {
        assert.ok(pos.top >= VIEWPORT_PADDING - 0.01, `top ${pos.top} overflowed viewport`)
        assert.ok(
          pos.top + fh <= vh - VIEWPORT_PADDING + 0.01,
          `bottom edge ${pos.top + fh} overflowed viewport ${vh}`
        )
      }
    }
  })
})

const rowRect = (index: number): GlideRect => ({ x: 2, y: index * 40, width: 236, height: 40 })

describe('lib-ui HoverGlide state machine & geometry', () => {
  it('round-trips viewport and scroll-content coordinates and transitions cold/warm/cooling/muted', () => {
    const rect = measureGlideRect(
      { left: 14, top: 180, width: 236, height: 40 },
      { left: 10, top: 100, width: 240, height: 500 },
      0,
      320,
      1,
      2
    )
    assert.equal(10 + 1 - 0 + rect.x, 14)
    assert.equal(100 + 2 - 320 + rect.y, 180)

    const first = enterGlideTarget(INITIAL_HOVER_GLIDE_STATE, 'r1', rowRect(1), false)
    assert.equal(first.effect.animatePosition, false)
    const second = enterGlideTarget(first.state, 'r2', rowRect(2), false)
    assert.equal(second.effect.animatePosition, true)
    const left = leaveGlideTarget(second.state)
    assert.equal(left.state.kind, 'cooling')
    const expired = expireGlideCooldown(left.state)
    assert.equal(expired.state.kind, 'cold')
    assert.equal(expired.effect.resetGeometry, true)

    const synced = syncGlideRect(second.state, { x: 2, y: 120, width: 260, height: 40 })
    assert.equal(synced.effect.changed, true)
    assert.equal(synced.effect.animatePosition, false)

    assert.deepEqual(hoverGlideItem(), { [HOVER_GLIDE_ITEM_ATTR]: '' })
    assert.deepEqual(hoverGlideItem(true), { [HOVER_GLIDE_ITEM_ATTR]: 'muted' })
    const html = renderToStaticMarkup(createElement(HoverGlideIndicator))
    assert.match(html, /aria-hidden="true"/)
  })
})
