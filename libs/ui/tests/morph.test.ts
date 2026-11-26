import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MORPH_CLOSE,
  MORPH_OPEN,
  contentClip,
  menuShape,
  sampleMorph,
  triggerShape,
  type MorphShape,
} from '@deepseek-chat/lib-ui'

// A 280 x 225 menu (border box, 1px border, 6px padding) opening over a 158 x 36 pill.
const menu = { width: 280, height: 225 }
const pill = { width: 158, height: 36, radius: 9999 }

/** The sampled shape nearest `ms` into a run. */
const shapeAt = (run: { total: number; shapes: MorphShape[] }, ms: number) => {
  const shape = run.shapes[Math.round((ms / run.total) * (run.shapes.length - 1))]
  assert.ok(shape, `no sample at ${ms}ms`)
  return shape
}

describe('MorphMenu geometry', () => {
  it('starts the background on the trigger, in the corner the menu shares with it', () => {
    // Spare space: 280 - 158 = 122 across, 225 - 36 = 189 down; the full menu sits at -1.
    assert.deepEqual(triggerShape(menu, pill, 'top', 'end'), {
      top: 188,
      right: -1,
      bottom: -1,
      left: 121,
      radius: 18,
    })
    assert.deepEqual(triggerShape(menu, pill, 'top', 'start'), {
      top: 188,
      right: 121,
      bottom: -1,
      left: -1,
      radius: 18,
    })
    assert.deepEqual(triggerShape(menu, pill, 'bottom', 'end'), {
      top: -1,
      right: -1,
      bottom: 188,
      left: 121,
      radius: 18,
    })
  })

  it("keeps a square trigger's own corner radius", () => {
    const plus = { width: 32, height: 32, radius: 8 }
    assert.equal(triggerShape(menu, plus, 'top', 'start').radius, 8)
  })

  it('clips the content to where the background is', () => {
    // Content box: 6px in from the padding edge, 266 x 211, in a 278 x 223 padding box.
    const content = { top: 6, left: 6, width: 266, height: 211 }
    const padding = { width: 278, height: 223 }
    // Full menu: nothing clipped; corner 16 - (6 + 1) = 9.
    assert.equal(contentClip(menuShape(16), content, padding), 'inset(0px 0px 0px 0px round 9px)')
    // On the pill: everything above 188 - 6 = 182 and left of 121 - 6 = 115 is hidden.
    assert.equal(
      contentClip(triggerShape(menu, pill, 'top', 'end'), content, padding),
      'inset(182px 0px 0px 115px round 11px)'
    )
  })
})

describe('MorphMenu motion', () => {
  const from = triggerShape(menu, pill, 'top', 'end')
  const to = menuShape(16)

  it('runs from the first shape to the last', () => {
    for (const motion of [MORPH_OPEN, MORPH_CLOSE]) {
      const { shapes } = sampleMorph(from, to, motion)
      assert.deepEqual(shapes[0], from)
      assert.deepEqual(shapes.at(-1), to)
    }
  })

  it('opens by spreading sideways ahead of growing upward, then overshooting slightly', () => {
    const run = sampleMorph(from, to, MORPH_OPEN)
    const at = (ms: number) => shapeAt(run, ms)
    const progress = (shape: MorphShape) => ({
      x: (from.left - shape.left) / (from.left - to.left),
      y: (from.top - shape.top) / (from.top - to.top),
    })
    const early = progress(at(40))
    assert.ok(early.x > early.y, `at 40ms x ${early.x} should lead y ${early.y}`)
    // About 90% of the way by 90ms on both axes.
    assert.ok(progress(at(90)).x > 0.85 && progress(at(90)).y > 0.85)
    // The rise passes the menu's edge by about 3px (about 1.5% of 189px) before settling.
    const highest = Math.min(...run.shapes.map((shape) => shape.top))
    assert.ok(highest < -2.5 && highest > -5, `peak overshoot ${highest}`)
  })

  it('closes by folding height before width, without overshoot', () => {
    const run = sampleMorph(to, from, MORPH_CLOSE)
    const mid = shapeAt(run, 60)
    const y = (mid.top - to.top) / (from.top - to.top)
    const x = (mid.left - to.left) / (from.left - to.left)
    assert.ok(y > x, `at 60ms height ${y} should lead width ${x}`)
    assert.ok(run.shapes.every((shape) => shape.top <= from.top && shape.left <= from.left))
  })
})
