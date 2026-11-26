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
