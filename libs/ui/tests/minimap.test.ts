import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MINIMAP_FULL_SCALE,
  Minimap,
  layoutMinimapMap,
  minimapBlockDetail,
  minimapLineDetail,
  mixRect,
  planScrollGlide,
  readingLineY,
  scrollSpringSettled,
  sectionAt,
  shapeMinimapSection,
  stepMinimapFocus,
  stepScrollSpring,
  type MinimapRun,
} from '@deepseek-chat/lib-ui'

describe('Reading line', () => {
  it('moves with scroll progress so every section can be current', () => {
    // A 600px view over 1000px of content scrolls 400px; the line runs from the top of the view
    // (0) to its bottom (1000), so content offset c is on the line at scrollTop c x 400 / 1000.
    assert.equal(readingLineY(0, 600, 1000), 0)
    assert.equal(readingLineY(200, 600, 1000), 500)
    assert.equal(readingLineY(400, 600, 1000), 1000)
    // A short section from 820 to 900, already on screen at the start, is current from
    // scrollTop 328 to 360: in between, the line sits inside it.
    const line = readingLineY(340, 600, 1000)
    assert.ok(line >= 820 && line < 900, `line at ${line}`)
    // Content that does not scroll reads at its end, so its last section is current.
    assert.equal(readingLineY(0, 600, 500), 600)
  })

  it('finds the section a point is in', () => {
    const tops = [0, 300, 900]
    assert.equal(sectionAt(tops, 0), 0)
    assert.equal(sectionAt(tops, 299), 0)
    assert.equal(sectionAt(tops, 300), 1)
    assert.equal(sectionAt(tops, 5000), 2)
    assert.equal(sectionAt(tops, -10), 0)
    assert.equal(sectionAt([], 10), 0)
  })
})

describe('Scroll glide', () => {
  it('lands on its target without overshooting, in well under a second', () => {
    // Critically damped: x(t) = 1 - (1 + wt)e^(-wt) with w = sqrt(210) ~ 14.5/s, which is within
    // 0.5px of a 1000px jump at wt ~ 10.2, about 0.7s.
    let spring = { position: 0, velocity: 0 }
    let elapsed = 0
    while (!scrollSpringSettled(spring, 1000)) {
      spring = stepScrollSpring(spring, 1000, 1 / 60)
      elapsed += 1 / 60
      assert.ok(spring.position <= 1000, `overshot to ${spring.position}`)
      assert.ok(elapsed < 1, 'did not settle within a second')
    }
    assert.ok(elapsed > 0.5, `settled implausibly fast (${elapsed}s)`)
  })

  it('scrolls the whole way for short jumps and cuts long ones short of the target', () => {
    // Viewport 800: 1.4 viewports is 1120px; the lead-in is 0.42 x 800 = 336px.
    assert.deepEqual(planScrollGlide(0, 1000, 800), { cut: false, start: 0 })
    assert.deepEqual(planScrollGlide(0, 2000, 800), { cut: true, start: 1664 })
    assert.deepEqual(planScrollGlide(5000, 0, 800), { cut: true, start: 336 })
  })
})

describe('Minimap map', () => {
  const near = (actual: number, expected: number, tolerance: number, what: string) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `${what}: ${actual} is not within ${tolerance} of ${expected}`
    )

  it('draws a document that fits at full detail, centred on the rail', () => {
    // 2000px at full detail is 200px of a 700px rail starting at 24: centred, it runs 274–474.
    const map = layoutMinimapMap({
      height: 2000,
      viewport: 800,
      focus: 1000,
      railTop: 24,
      railHeight: 700,
    })
    near(map.top(0), 24 + (700 - 2000 * MINIMAP_FULL_SCALE) / 2, 1e-9, 'top')
    near(map.top(2000), 24 + (700 + 2000 * MINIMAP_FULL_SCALE) / 2, 1e-9, 'bottom')
    near(map.toContent(map.top(1234)), 1234, 1e-9, 'round trip')
  })

  it('without a lens, fits a long document to the rail at one scale', () => {
    const map = layoutMinimapMap({
      height: 20_000,
      viewport: 800,
      focus: null,
      railTop: 24,
      railHeight: 700,
    })
    near(map.top(0), 24, 1e-9, 'top')
    near(map.top(20_000), 724, 1e-9, 'bottom')
    near(map.scaleAt(500), 700 / 20_000, 1e-12, 'scale near the start')
    near(map.scaleAt(19_000), 700 / 20_000, 1e-12, 'scale near the end')
  })

  it('with a lens, fills the rail exactly, never runs backwards, and inverts', () => {
    const map = layoutMinimapMap({
      height: 40_000,
      viewport: 800,
      focus: 20_000,
      railTop: 24,
      railHeight: 700,
    })
    near(map.top(0), 24, 1e-6, 'top')
    near(map.top(40_000), 724, 1e-6, 'bottom')
    let previous = map.top(0)
    for (let y = 50; y <= 40_000; y += 50) {
      const next = map.top(y)
      assert.ok(next >= previous - 1e-9, `runs backwards at ${y}`)
      previous = next
      near(map.toContent(next), y, 0.5, `round trip at ${y}`)
    }
  })

  it('with a lens, keeps the window one height wherever the reader is', () => {
    // Full detail within a viewport of the focus: an 800px window is 800 x 0.1 = 80px of rail.
    const windowAt = (focus: number) => {
      const map = layoutMinimapMap({
        height: 40_000,
        viewport: 800,
        focus,
        railTop: 24,
        railHeight: 700,
      })
      return map.top(focus + 400) - map.top(focus - 400)
    }
    near(windowAt(8_000), 800 * MINIMAP_FULL_SCALE, 0.5, 'window early on')
    near(windowAt(20_000), 800 * MINIMAP_FULL_SCALE, 0.5, 'window in the middle')
    near(windowAt(32_000), 800 * MINIMAP_FULL_SCALE, 0.5, 'window late on')
    // Far from the focus the rest of the document shares what's left, at a much smaller scale.
    const map = layoutMinimapMap({
      height: 40_000,
      viewport: 800,
      focus: 20_000,
      railTop: 24,
      railHeight: 700,
    })
    assert.ok(map.scaleAt(1_000) < MINIMAP_FULL_SCALE / 4, `far scale ${map.scaleAt(1_000)}`)
  })
})

describe('Minimap lens focus', () => {
  it('holds still while the reader stays within half a viewport of it', () => {
    // Viewport 800: the slack is 400px, so a reader centred 300px away doesn't move it.
    const step = stepMinimapFocus({ position: 1000, velocity: 0 }, 1300, 800, 1 / 60)
    assert.deepEqual(step, { focus: { position: 1000, velocity: 0 }, settled: true })
  })

  it('follows a reader who moves further, stopping at the edge of the slack without overshoot', () => {
    // The reader moves to 3000; the focus follows to 3000 - 400 = 2600 and stops there.
    let focus = { position: 1000, velocity: 0 }
    let settled = false
    let elapsed = 0
    while (!settled) {
      const step = stepMinimapFocus(focus, 3000, 800, 1 / 60)
      focus = step.focus
      settled = step.settled
      elapsed += 1 / 60
      assert.ok(focus.position <= 2600 + 0.5, `overshot to ${focus.position}`)
      assert.ok(elapsed < 2, 'did not settle within two seconds')
    }
    assert.equal(focus.position, 2600)
  })

  it('stays put while held (the window is being dragged)', () => {
    const step = stepMinimapFocus({ position: 1000, velocity: 0 }, 9000, 800, 1 / 60, true)
    assert.equal(step.focus.position, 1000)
  })
})

describe('Minimap levels of detail', () => {
  it('shows text lines at full detail, and never lines and slabs at once', () => {
    assert.equal(minimapLineDetail(MINIMAP_FULL_SCALE), 1, 'the lens shows text lines')
    // Lines turn into bars before bars turn into slabs: wherever any line shows, bars are whole.
    for (let scale = 0.001; scale <= 0.2; scale += 0.001) {
      if (minimapLineDetail(scale) > 0) {
        assert.equal(minimapBlockDetail(scale), 1, `lines and slabs overlap at scale ${scale}`)
      }
    }
  })

  it('blends a shape between two levels', () => {
    const a = { x: 0, w: 10, y0: 0, y1: 2 }
    const b = { x: 4, w: 30, y0: -2, y1: 10 }
    assert.deepEqual(mixRect(a, b, 0), a)
    assert.deepEqual(mixRect(a, b, 1), b)
    assert.deepEqual(mixRect(a, b, 0.5), { x: 2, w: 20, y0: -1, y1: 6 })
  })
})

describe('Minimap section shapes', () => {
  // A 300px section: a 40px marker, then paragraph A (two lines, 60 and 82) and a table row B
  // (two cells on one line at 130). The body runs from 40 + 12 = 52 to 300 - 6 = 294.
  const run = (block: number, color: string, x: number, y: number): MinimapRun => ({
    block,
    kind: 'text',
    color,
    x,
    w: 0.25,
    y,
    h: 18,
  })
  const colours: Record<string, readonly [number, number, number, number]> = {
    red: [255, 0, 0, 1],
    blue: [0, 0, 255, 1],
  }
  const shape = shapeMinimapSection(
    {
      height: 300,
      marker: { fill: 'blue', x: 0.6, w: 0.4, y: 0, h: 40, runs: [] },
      blocks: [
        { x: 0, w: 0.5, y: 60, h: 44 },
        { x: 0, w: 0.5, y: 130, h: 18 },
      ],
      runs: [
        run(0, 'red', 0, 60),
        run(0, 'red', 0.25, 82),
        run(1, 'blue', 0, 130),
        run(1, 'blue', 0.25, 130),
      ],
      decorations: [],
    },
    (color) => colours[color] ?? [0, 0, 0, 1]
  )

  it('tiles the body exactly once, block by block and line by line', () => {
    assert.equal(shape.bodyTop, 52)
    assert.equal(shape.bodyBottom, 294)
    const [a, b] = shape.blocks
    assert.deepEqual([a?.slabTop, a?.slabBottom], [52, 130])
    assert.deepEqual([b?.slabTop, b?.slabBottom], [130, 294])
    // Each leading run's slab tile starts where the previous one ended.
    const tiles = shape.blocks.flatMap((block) =>
      block.runs.filter((r) => r.leads).map((r) => [r.slabTop, r.slabBottom] as const)
    )
    assert.deepEqual(tiles, [
      [52, 82],
      [82, 130],
      [130, 294],
    ])
    // And each line's bar tile runs to the next line, the last to the bottom of its block.
    assert.deepEqual(
      a?.runs.map((r) => [r.tileTop, r.tileBottom]),
      [
        [60, 82],
        [82, 104],
      ]
    )
  })

  it('lets only the first run on a line grow into its tile', () => {
    assert.deepEqual(
      shape.blocks[1]?.runs.map((r) => r.leads),
      [true, false]
    )
  })

  it('colours bars by their runs and the slab by its bars', () => {
    assert.deepEqual(shape.blocks[0]?.color, [255, 0, 0, 1])
    // Weighted by area: A is 0.5 x 44 = 22, B is 0.5 x 18 = 9.
    assert.deepEqual(shape.color, [(255 * 22) / 31, 0, (255 * 9) / 31, 1])
  })
})

describe('Minimap markup', () => {
  const sections = [
    { key: 'a', accessibleLabel: 'Turn 1: First' },
    { key: 'b', accessibleLabel: 'Turn 2: Second' },
    { key: 'c', accessibleLabel: 'Turn 3: Third', dividerBefore: true },
  ]
  const props = {
    sections,
    ariaLabel: 'Turns',
    scrollRef: { current: null },
    contentRef: { current: null },
    sectionSelector: '[data-section]',
    markerSelector: '[data-marker]',
    onSeek: () => undefined,
    onNavigate: () => undefined,
  }

  it('is a labelled navigation list with one tab stop, on the current section', () => {
    const html = renderToStaticMarkup(createElement(Minimap, { ...props, current: 1 }))
    assert.match(html, /<nav[^>]*aria-label="Turns"/)
    assert.equal(html.match(/<li\b/g)?.length, 3)
    assert.match(
      html,
      /<button[^>]*tabindex="0"[^>]*aria-label="Turn 2: Second"[^>]*aria-current="location"/
    )
    assert.equal(html.match(/tabindex="0"/g)?.length, 1, 'only the current section is a tab stop')
    assert.match(
      html,
      /<canvas[^>]*aria-hidden="true"/,
      'the drawing is hidden from assistive technology'
    )
  })
})
