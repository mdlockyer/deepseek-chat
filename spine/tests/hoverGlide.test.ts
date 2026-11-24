import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HOVER_GLIDE_ITEM_ATTR,
  HoverGlideIndicator,
  INITIAL_HOVER_GLIDE_STATE,
  enterGlideTarget,
  expireGlideCooldown,
  hoverGlideItem,
  leaveGlideTarget,
  measureGlideRect,
  syncGlideRect,
  type GlideRect,
} from '@deepseek-chat/spine/design'

const rowRect = (index: number): GlideRect => ({
  x: 2,
  y: index * 40,
  width: 236,
  height: 40,
})

describe('hover glide geometry', () => {
  it('maps viewport boxes into scroll-content coordinates and round-trips back to viewport', () => {
    const cases = [
      {
        target: { left: 14, top: 180, width: 236, height: 40 },
        container: { left: 10, top: 100, width: 240, height: 500 },
        scrollLeft: 0,
        scrollTop: 320,
        clientLeft: 1,
        clientTop: 2,
      },
      {
        target: { left: 260, top: 48, width: 112, height: 36 },
        container: { left: 40, top: 44, width: 400, height: 48 },
        scrollLeft: 145,
        scrollTop: 0,
        clientLeft: 0,
        clientTop: 0,
      },
    ]

    for (const c of cases) {
      const rect = measureGlideRect(
        c.target,
        c.container,
        c.scrollLeft,
        c.scrollTop,
        c.clientLeft,
        c.clientTop
      )
      assert.equal(rect.width, c.target.width)
      assert.equal(rect.height, c.target.height)
      // Reconstructing viewport coordinates from scroll-content space recovers the exact item box.
      assert.equal(c.container.left + c.clientLeft - c.scrollLeft + rect.x, c.target.left)
      assert.equal(c.container.top + c.clientTop - c.scrollTop + rect.y, c.target.top)
    }
  })
})

describe('hover glide state machine', () => {
  it('snaps on cold entry and glides on warm transitions between rows', () => {
    const first = enterGlideTarget(INITIAL_HOVER_GLIDE_STATE, 'row-1', rowRect(1), false)
    assert.equal(first.state.kind, 'active')
    assert.equal(first.effect.changed, true)
    assert.equal(first.effect.visible, true)
    assert.equal(first.effect.animatePosition, false, 'cold entry must snap without flying in')

    const same = enterGlideTarget(first.state, 'row-1', rowRect(1), false)
    assert.equal(same.effect.changed, false, 're-entering the same row is a no-op')

    const second = enterGlideTarget(first.state, 'row-2', rowRect(2), false)
    assert.equal(second.state.kind, 'active')
    assert.equal(second.effect.visible, true)
    assert.equal(second.effect.animatePosition, true, 'warm move between rows glides')
    assert.deepEqual(second.effect.rect, rowRect(2))
  })

  it('keeps gliding across brief gaps during cooldown, and resets cold once cooldown expires', () => {
    const active = enterGlideTarget(INITIAL_HOVER_GLIDE_STATE, 'row-1', rowRect(1), false).state

    const left = leaveGlideTarget(active)
    assert.equal(left.state.kind, 'cooling')
    assert.equal(left.effect.visible, false)
    assert.equal(left.effect.scheduleCooldown, true)

    // Crossing a section header before cooldown expires cancels cooldown and glides smoothly.
    const acrossGap = enterGlideTarget(left.state, 'row-2', rowRect(3), false)
    assert.equal(acrossGap.state.kind, 'active')
    assert.equal(acrossGap.effect.animatePosition, true)
    assert.equal(acrossGap.effect.cancelCooldown, true)
    assert.equal(acrossGap.effect.visible, true)

    // Letting cooldown expire collapses hidden geometry and forces the next entry to snap cold.
    const coolingAgain = leaveGlideTarget(acrossGap.state).state
    const expired = expireGlideCooldown(coolingAgain)
    assert.equal(expired.state.kind, 'cold')
    assert.equal(expired.effect.resetGeometry, true)

    const fresh = enterGlideTarget(expired.state, 'row-5', rowRect(5), false)
    assert.equal(fresh.effect.animatePosition, false, 'entry after cooldown snaps cold')
    assert.equal(fresh.effect.visible, true)
  })

  it('tracks muted (active) rows invisibly so moving across or off them glides cleanly', () => {
    // Entering an active row directly parks behind it invisibly.
    const onActive = enterGlideTarget(INITIAL_HOVER_GLIDE_STATE, 'row-active', rowRect(2), true)
    assert.equal(onActive.state.kind, 'active')
    assert.equal(onActive.effect.visible, false)
    assert.equal(onActive.effect.animatePosition, false)

    // Moving off the active row onto its neighbor glides straight out from it.
    const toSibling = enterGlideTarget(onActive.state, 'row-next', rowRect(3), false)
    assert.equal(toSibling.effect.visible, true)
    assert.equal(toSibling.effect.animatePosition, true)
    assert.deepEqual(toSibling.effect.rect, rowRect(3))

    // Moving back onto the active row glides in while hiding to avoid double-tint or corner halos.
    const backToActive = enterGlideTarget(toSibling.state, 'row-active', rowRect(2), true)
    assert.equal(backToActive.effect.visible, false)
    assert.equal(backToActive.effect.animatePosition, true)
  })

  it('snaps on explicit snap option (scroll sync) and container resize sync', () => {
    const active = enterGlideTarget(INITIAL_HOVER_GLIDE_STATE, 'row-1', rowRect(1), false).state

    const scrolled = enterGlideTarget(active, 'row-4', rowRect(4), false, { snap: true })
    assert.equal(scrolled.effect.animatePosition, false)
    assert.deepEqual(scrolled.effect.rect, rowRect(4))

    const shifted = syncGlideRect(scrolled.state, { x: 2, y: 180, width: 260, height: 40 })
    assert.equal(shifted.effect.changed, true)
    assert.equal(shifted.effect.animatePosition, false)
    assert.equal(shifted.effect.visible, true)

    const unchanged = syncGlideRect(shifted.state, { x: 2, y: 180, width: 260, height: 40 })
    assert.equal(unchanged.effect.changed, false)
  })
})

describe('hover glide markup helpers', () => {
  it('marks normal and muted items and renders an aria-hidden indicator', () => {
    assert.deepEqual(hoverGlideItem(), { [HOVER_GLIDE_ITEM_ATTR]: '' })
    assert.deepEqual(hoverGlideItem(true), { [HOVER_GLIDE_ITEM_ATTR]: 'muted' })

    const html = renderToStaticMarkup(createElement(HoverGlideIndicator, { className: 'custom' }))
    assert.match(html, /aria-hidden="true"/)
    assert.match(html, /class="[^"]*custom/)
  })
})
