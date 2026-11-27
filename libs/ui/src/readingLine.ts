/** Where the reading line sits through most of a scroll, as a fraction of the view from its top. */
export const READING_LINE_AT = 0.3

const smoothstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/**
 * Where reading happens in a scroller, in content px: the line that decides which section is
 * current (the last one starting at or above it).
 *
 * Through most of a scroll it stays at `READING_LINE_AT` of the view, so the current section
 * changes when a section's start passes the same place on screen wherever the reader is. At the
 * ends it eases to the edges: from the top of the view at the very top, so the first section is
 * current there, and to the bottom of the view at the very end, so sections starting in the last
 * screenful still become current. It only ever moves forward as the reader scrolls down, so
 * every section, however short, is current at some scroll position.
 */
export const readingLineY = (scrollTop: number, clientHeight: number, scrollHeight: number) => {
  const max = Math.max(0, scrollHeight - clientHeight)
  if (clientHeight <= 0) {
    return scrollTop
  }
  if (max <= 0) {
    // Nothing scrolls: everything is on screen, and the last section is the one being read.
    return scrollTop + clientHeight
  }
  const at = clientHeight * READING_LINE_AT
  const s = Math.min(max, Math.max(0, scrollTop))
  // The two ramps share the scroll range when it is short, so they never overlap.
  const headRamp = Math.min(at, max / 2)
  const tailRamp = Math.min(clientHeight - at, max / 2)
  const head = at * smoothstep(s / headRamp)
  const tail = (clientHeight - at) * smoothstep((s - (max - tailRamp)) / tailRamp)
  return s + head + tail
}

/** The index of the last section whose top is at or above `y` (0 when none is). */
export const sectionAt = (tops: readonly number[], y: number) => {
  let lo = 0
  let hi = tops.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((tops[mid] ?? 0) <= y) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
