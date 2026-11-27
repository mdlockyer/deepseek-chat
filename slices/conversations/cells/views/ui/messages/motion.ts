/**
 * Reads a motion token (`--ui-duration-*`, `--ui-ease-*`) as resolved on an element, so script
 * animations follow the same scale, and the reduced-motion overrides, as CSS transitions.
 */
export const readMotionToken = (el: Element, name: string): string =>
  getComputedStyle(el).getPropertyValue(name).trim()

export const readDurationMs = (el: Element, name: string): number => {
  const value = readMotionToken(el, name)
  const amount = Number.parseFloat(value)
  if (Number.isNaN(amount)) {
    throw new Error(`Motion token ${name} is not a duration: "${value}"`)
  }
  return value.endsWith('ms') ? amount : amount * 1000
}

const CUBIC_BEZIER_RE =
  /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/

/**
 * For a `cubic-bezier()` easing, returns the fraction of the duration at which the eased
 * progress first reaches `progress` (0–1). Used to start an element's entrance at the moment an
 * animated edge reaches it. Assumes y1 and y2 lie in [0, 1], so the curve is monotonic.
 */
export const timeAtProgress = (easing: string, progress: number): number => {
  const match = CUBIC_BEZIER_RE.exec(easing)
  if (!match) {
    throw new Error(`Expected a cubic-bezier() easing, got "${easing}"`)
  }
  const [x1, y1, x2, y2] = match.slice(1).map(Number)
  const bezier = (t: number, p1: number, p2: number) =>
    3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3
  const target = Math.min(1, Math.max(0, progress))
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    if (bezier(mid, y1, y2) < target) {
      low = mid
    } else {
      high = mid
    }
  }
  return bezier((low + high) / 2, x1, x2)
}
