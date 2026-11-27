/**
 * Geometry for ChapterRail: where each chapter's tick sits at rest, where its row sits when the
 * rail opens into a card, and how a continuous reading position maps onto the rail. Pure, so it
 * can be tested without a browser. All values are CSS px from the top of the rail's box.
 */

/** Vertical distance between ticks at rest, before compressing to fit. */
export const CHAPTER_TICK_GAP = 12
/** The closest ticks get when many chapters share a short box. */
export const CHAPTER_TICK_MIN_GAP = 4
/** Extra space at rest where a divider sits between two ticks, before compressing to fit. */
export const CHAPTER_DIVIDER_GAP = 10
/** Height of one chapter row in the open card, before compressing to fit. */
export const CHAPTER_ROW_HEIGHT = 32
/** The shortest a row gets (the minimum pointer target); beyond that the card scrolls. */
export const CHAPTER_ROW_MIN_HEIGHT = 24
/** Height of a divider row in the open card. */
export const CHAPTER_DIVIDER_ROW = 28
/** Padding between the card's edge and its first and last rows. */
export const CHAPTER_CARD_PADDING = 6
/** Minimum distance kept between the rail and the top and bottom of its box. */
export const CHAPTER_CARD_INSET = 8

export type ChapterRailLayout = {
  /** Centre of each tick at rest. */
  readonly ticks: readonly number[]
  /** Centre of each chapter row in the open card, before the card scrolls. */
  readonly rows: readonly number[]
  readonly rowHeight: number
  /** Top of each divider row in the open card (before scrolling), keyed by the chapter it precedes. */
  readonly dividers: ReadonlyMap<number, number>
  /** The open card's visible box, and the height of everything in it (taller when it scrolls). */
  readonly card: { readonly top: number; readonly height: number; readonly contentHeight: number }
}

/**
 * Lays out `count` chapters in a box `height` px tall, both at rest and open. Each is centred on
 * the box and kept `CHAPTER_CARD_INSET` from its edges: resting ticks draw closer together (down to
 * `CHAPTER_TICK_MIN_GAP`) and card rows get shorter (down to `CHAPTER_ROW_MIN_HEIGHT`) to fit; a
 * card that still does not fit fills the box and scrolls.
 */
export const layoutChapterRail = (
  count: number,
  dividersBefore: ReadonlySet<number>,
  height: number
): ChapterRailLayout => {
  const middle = height / 2
  const available = Math.max(0, height - CHAPTER_CARD_INSET * 2)
  const dividerCount = [...dividersBefore].filter((index) => index > 0 && index < count).length

  const naturalSpan = Math.max(0, count - 1) * CHAPTER_TICK_GAP + dividerCount * CHAPTER_DIVIDER_GAP
  const squeeze =
    naturalSpan > available && naturalSpan > 0
      ? Math.max(CHAPTER_TICK_MIN_GAP / CHAPTER_TICK_GAP, available / naturalSpan)
      : 1
  const restOffsets: number[] = []
  let rest = 0
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      rest += (CHAPTER_TICK_GAP + (dividersBefore.has(index) ? CHAPTER_DIVIDER_GAP : 0)) * squeeze
    }
    restOffsets.push(rest)
  }
  const restTop = middle - rest / 2
  const ticks = restOffsets.map((offset) => restTop + offset)

  const fixed = CHAPTER_CARD_PADDING * 2 + dividerCount * CHAPTER_DIVIDER_ROW
  const fitted = count > 0 ? (available - fixed) / count : CHAPTER_ROW_HEIGHT
  const rowHeight = Math.min(CHAPTER_ROW_HEIGHT, Math.max(CHAPTER_ROW_MIN_HEIGHT, fitted))

  const rowOffsets: number[] = []
  const dividerOffsets = new Map<number, number>()
  let open = CHAPTER_CARD_PADDING
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && dividersBefore.has(index)) {
      dividerOffsets.set(index, open)
      open += CHAPTER_DIVIDER_ROW
    }
    rowOffsets.push(open + rowHeight / 2)
    open += rowHeight
  }
  const contentHeight = count > 0 ? open + CHAPTER_CARD_PADDING : 0
  const cardHeight = Math.min(contentHeight, available)
  const cardTop = Math.min(
    Math.max(middle - cardHeight / 2, CHAPTER_CARD_INSET),
    Math.max(CHAPTER_CARD_INSET, height - CHAPTER_CARD_INSET - cardHeight)
  )

  return {
    ticks,
    rows: rowOffsets.map((offset) => cardTop + offset),
    rowHeight,
    dividers: new Map([...dividerOffsets].map(([index, offset]) => [index, cardTop + offset])),
    card: { top: cardTop, height: cardHeight, contentHeight },
  }
}

/** The scroll offset that keeps row `index` inside a card scrolled to `offset` (unchanged if it is). */
export const revealChapterRow = (
  layout: ChapterRailLayout,
  index: number,
  offset: number
): number => {
  const centre = layout.rows[index]
  const maxOffset = Math.max(0, layout.card.contentHeight - layout.card.height)
  if (centre === undefined || maxOffset === 0) {
    return 0
  }
  const top = centre - layout.rowHeight / 2 - layout.card.top
  const bottom = top + layout.rowHeight
  const margin = CHAPTER_CARD_PADDING + layout.rowHeight
  const next =
    top - margin < offset
      ? top - margin
      : bottom + margin > offset + layout.card.height
        ? bottom + margin - layout.card.height
        : offset
  return Math.min(maxOffset, Math.max(0, next))
}

/**
 * Maps a continuous reading position onto the resting rail. Position `k + f` means a fraction `f`
 * of the way through chapter `k`; chapter `k` owns the band between the midpoints to its
 * neighbours (half a gap beyond the first and last ticks), so the mapping is continuous.
 */
export const chapterPositionY = (ticks: readonly number[], position: number): number => {
  const count = ticks.length
  if (count === 0) {
    return 0
  }
  const at = (i: number) => ticks[i] ?? 0
  const halfGap = count > 1 ? (at(1) - at(0)) / 2 : CHAPTER_TICK_GAP / 2
  const clamped = Math.min(Math.max(position, 0), count)
  const index = Math.min(count - 1, Math.floor(clamped))
  const fraction = clamped - index
  const low = index === 0 ? at(0) - halfGap : (at(index - 1) + at(index)) / 2
  const high = index === count - 1 ? at(count - 1) + halfGap : (at(index) + at(index + 1)) / 2
  return low + fraction * (high - low)
}

/**
 * Where reading happens in a scroller, in content px: the line that decides which chapter is
 * current. It travels with scroll progress, from the top of the view when scrolled to the top to
 * the bottom of the view when scrolled to the bottom. Every chapter, however short, therefore
 * crosses it at some scroll position (one starting at content offset `c` becomes current at
 * scrollTop `c × max / scrollHeight`), and the first and last chapters are current at the ends.
 * A line fixed near the top would skip short chapters that never reach it before the end.
 */
export const readingLineY = (scrollTop: number, clientHeight: number, scrollHeight: number) => {
  const max = Math.max(0, scrollHeight - clientHeight)
  const progress = max > 0 ? Math.min(1, Math.max(0, scrollTop / max)) : 1
  return scrollTop + clientHeight * progress
}

/** The chapter whose centre (tick or row) is nearest to `y`; -1 when there are none. */
export const nearestChapter = (centres: readonly number[], y: number): number => {
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  centres.forEach((centre, index) => {
    const distance = Math.abs(centre - y)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}
