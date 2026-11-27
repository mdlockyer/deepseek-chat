import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ChapterRail,
  chapterPositionY,
  layoutChapterRail,
  nearestChapter,
  planScrollGlide,
  readingLineY,
  revealChapterRow,
  scrollSpringSettled,
  stepScrollSpring,
} from '@deepseek-chat/lib-ui'

describe('ChapterRail geometry', () => {
  it('centres the resting ticks and the open card in the box', () => {
    // 3 ticks 12px apart span 24px; centred in 200px they start at 100 - 12 = 88.
    // The card is 6 + 3 x 32 + 6 = 108px tall, so it starts at 100 - 54 = 46 and its rows'
    // centres sit 6 + 16 = 22px below that, then every 32px.
    const layout = layoutChapterRail(3, new Set(), 200)
    assert.deepEqual(layout.ticks, [88, 100, 112])
    assert.deepEqual(layout.card, { top: 46, height: 108, contentHeight: 108 })
    assert.deepEqual(layout.rows, [68, 100, 132])
    assert.equal(layout.dividers.size, 0)
  })

  it('opens a wider gap at rest and a divider row in the card before a marked chapter', () => {
    // Rest: 0, 12, 12 + 12 + 10 = 34, centred in 200px -> starts at 100 - 17 = 83.
    // Card: rows at 6..38 and 38..70, divider 70..98, row 98..130, plus 6 -> 136 tall at 32.
    const layout = layoutChapterRail(3, new Set([2]), 200)
    assert.deepEqual(layout.ticks, [83, 95, 117])
    assert.deepEqual(layout.card, { top: 32, height: 136, contentHeight: 136 })
    assert.deepEqual(layout.rows, [54, 86, 146])
    assert.deepEqual([...layout.dividers], [[2, 102]])
  })

  it('keeps the open card inside the box, shortening rows to fit', () => {
    // In a 130px box the 108px card fits: centred at 65 - 54 = 11, clear of the 8px inset.
    assert.equal(layoutChapterRail(3, new Set(), 130).card.top, 11)
    // In 100px only 84px is free: rows shrink to (84 - 12) / 3 = 24px and the card fills it.
    const tight = layoutChapterRail(3, new Set(), 100)
    assert.equal(tight.rowHeight, 24)
    assert.deepEqual(tight.card, { top: 8, height: 84, contentHeight: 84 })
  })

  it('scrolls a card whose rows cannot shrink further, keeping the current row in view', () => {
    // 10 rows at the 24px minimum need 6 + 240 + 6 = 252px; a 200px box has 184px to show.
    const layout = layoutChapterRail(10, new Set(), 200)
    assert.equal(layout.rowHeight, 24)
    assert.deepEqual(layout.card, { top: 8, height: 184, contentHeight: 252 })
    // The last row sits 6 + 9 x 24 = 222px into the content; with a row of margin it needs the
    // card scrolled to 222 + 24 + 30 - 184 = 92, which clamps to the 252 - 184 = 68 maximum.
    assert.equal(revealChapterRow(layout, 9, 0), 68)
    assert.equal(revealChapterRow(layout, 0, 68), 0)
    // Row 8 sits 6 + 7 x 24 = 174px in: scrolled just enough to show it plus a row of margin.
    assert.equal(revealChapterRow(layout, 7, 0), 174 + 24 + 30 - 184)
    assert.equal(revealChapterRow(layout, 4, 20), 20, 'a row already in view does not move it')
    assert.equal(revealChapterRow(layoutChapterRail(3, new Set(), 200), 2, 0), 0)
  })

  it('draws resting ticks closer together when many chapters share a short box', () => {
    // 40 ticks would span 39 x 12 = 468px; squeezed into the 184px between the insets.
    const { ticks } = layoutChapterRail(40, new Set(), 200)
    assert.ok(Math.abs((ticks[0] ?? 0) - 8) < 1e-9)
    assert.ok(Math.abs((ticks.at(-1) ?? 0) - 192) < 1e-9)
  })

  it('maps a reading position onto the rail continuously, half a gap past the end ticks', () => {
    const ticks = [88, 100, 112]
    assert.equal(chapterPositionY(ticks, 0), 82)
    assert.equal(chapterPositionY(ticks, 1), 94)
    assert.equal(chapterPositionY(ticks, 0.999_999) > 93.99, true)
    assert.equal(chapterPositionY(ticks, 1.5), 100)
    assert.equal(chapterPositionY(ticks, 3), 118)
    assert.equal(chapterPositionY(ticks, 7), 118, 'positions past the end clamp to the end')
    assert.equal(chapterPositionY([], 1), 0)
  })

  it('moves the reading line with scroll progress so every chapter can be current', () => {
    // A 600px view over 1000px of content scrolls 400px; the line runs from the top of the view
    // (0) to its bottom (1000), so content offset c is on the line at scrollTop c x 400 / 1000.
    assert.equal(readingLineY(0, 600, 1000), 0)
    assert.equal(readingLineY(200, 600, 1000), 500)
    assert.equal(readingLineY(400, 600, 1000), 1000)
    // A short chapter from 820 to 900, already on screen at the start, is current from
    // scrollTop 328 to 360: in between, the line sits inside it.
    const line = readingLineY(340, 600, 1000)
    assert.ok(line >= 820 && line < 900, `line at ${line}`)
    // Content that does not scroll reads at its end, so its last chapter is current.
    assert.equal(readingLineY(0, 600, 500), 600)
  })

  it('finds the chapter nearest a pointer', () => {
    assert.equal(nearestChapter([88, 100, 112], 97), 1)
    assert.equal(nearestChapter([88, 100, 112], -40), 0)
    assert.equal(nearestChapter([], 10), -1)
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

describe('ChapterRail markup', () => {
  const items = [
    { key: 'a', label: 'First', accessibleLabel: 'Chapter 1: First' },
    { key: 'b', label: 'Second', accessibleLabel: 'Chapter 2: Second' },
    { key: 'c', label: 'Third', accessibleLabel: 'Chapter 3: Third', dividerBefore: 'Summary' },
  ]

  it('is a labelled navigation list with one tab stop on the current chapter', () => {
    const html = renderToStaticMarkup(
      createElement(ChapterRail, {
        items,
        current: 1,
        ariaLabel: 'Chapters',
        onNavigate: () => undefined,
      })
    )
    assert.match(html, /<nav[^>]*aria-label="Chapters"/)
    assert.equal(html.match(/<li\b/g)?.length, 3)
    assert.match(
      html,
      /<button[^>]*tabindex="0"[^>]*aria-label="Chapter 2: Second"[^>]*aria-current="location"/
    )
    assert.equal(html.match(/tabindex="0"/g)?.length, 1, 'only the current chapter is a tab stop')
    assert.equal(html.match(/aria-current=/g)?.length, 1)
    assert.match(
      html,
      /tabindex="-1"[^>]*aria-hidden="true"[^>]*data-chapter-rail-action/,
      'the return button is hidden and unfocusable without a return target'
    )
  })

  it('offers a compact, named way back to the chapter the reader jumped from', () => {
    const html = renderToStaticMarkup(
      createElement(ChapterRail, {
        items,
        current: 0,
        ariaLabel: 'Chapters',
        onNavigate: () => undefined,
        returnTo: { index: 2, label: 'Back to chapter 3', onReturn: () => undefined },
      })
    )
    const button =
      /<button[^>]*data-chapter-rail-action[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? ''
    assert.match(button, /tabindex="0"/, 'reachable by keyboard while offered')
    assert.match(button, /aria-label="Back to chapter 3"/, 'named by its label')
    assert.match(button, />3<\/span><\/button>$/, 'shows only the origin chapter number')
    assert.match(
      html,
      /class="item origin"[^>]*><button[^>]*aria-label="Chapter 3: Third"/,
      'rings the origin'
    )
  })
})
