/**
 * Where reading happens in a scroller, in content px: the line that decides which section is
 * current. It travels with scroll progress, from the top of the view when scrolled to the top to
 * the bottom of the view when scrolled to the bottom. Every section, however short, therefore
 * crosses it at some scroll position (one starting at content offset `c` becomes current at
 * scrollTop `c × max / scrollHeight`), and the first and last sections are current at the ends.
 * A line fixed near the top would skip short sections that never reach it before the end.
 */
export const readingLineY = (scrollTop: number, clientHeight: number, scrollHeight: number) => {
  const max = Math.max(0, scrollHeight - clientHeight)
  const progress = max > 0 ? Math.min(1, Math.max(0, scrollTop / max)) : 1
  return scrollTop + clientHeight * progress
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
