/**
 * Geometry and motion for MorphMenu, the menu surface that grows out of its trigger. Everything
 * here is pure so it can be tested without a browser.
 *
 * Coordinates are CSS insets (top, right, bottom, left) of the menu's background layer, measured
 * from the menu's padding box. The menu has a 1px border, so the full menu is an inset of -1px on
 * every side, and the trigger's box is the full menu pulled in on the two sides away from the
 * corner the menu shares with the trigger.
 */

export type MorphSide = 'top' | 'bottom'
export type MorphAlign = 'start' | 'end'

export type MorphShape = {
  top: number
  right: number
  bottom: number
  left: number
  radius: number
}

export type MorphMotion = {
  /** Duration of the vertical (top, bottom) motion in ms. */
  yMs: number
  y: (t: number) => number
  /** Duration of the horizontal (left, right) motion in ms. */
  xMs: number
  x: (t: number) => number
}

/** The background layer's inset when it covers the whole menu, border included. */
export const MORPH_EDGE = -1

/** How long a closing MorphMenu stays mounted while it folds back into its trigger. */
export const MORPH_CLOSE_MS = 180

export const MORPH_FADE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Unit step response of a damped spring, shaped to settle (within 0.3%) at t = 1. */
export const spring = (zeta: number) => {
  const w = 5.8 / zeta
  const wd = w * Math.sqrt(1 - zeta * zeta)
  return (t: number) =>
    t >= 1
      ? 1
      : 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t))
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/**
 * Open: the menu spreads sideways on a firm spring (about 0.6% overshoot, 170ms) slightly ahead
 * of growing vertically on a slightly livelier one (about 1.5%, 250ms), so it unfolds out of the trigger
 * rather than scaling. Both are about 90% of the way there by 90ms. Close: height folds first
 * (130ms), then width (160ms), both easing out, so it narrows back into the trigger.
 */
export const MORPH_OPEN: MorphMotion = { yMs: 250, y: spring(0.8), xMs: 170, x: spring(0.85) }
export const MORPH_CLOSE: MorphMotion = { yMs: 130, y: easeOutCubic, xMs: 160, x: easeOutCubic }

/**
 * Shared icons (see MorphMenu): opening, they fly over the open's 250ms on a near-critical
 * spring (damping 0.9: 78% of the way by 100ms, 99% by 200ms, overshoot under 0.01%), so they
 * settle onto their row without the bounce the menu's livelier unfold spring would give a small
 * glyph; closing, they ease out over the close's width fold (160ms).
 */
export const MORPH_ICON_SPRING = spring(0.9)
export const MORPH_ICON_CLOSE_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)'

/** Spring for elements marked `data-morph-pop`, which pop in once the menu has formed. */
export const MORPH_POP = spring(0.6)

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount

/** The full menu: the background covers the border box with the menu's own corner radius. */
export const menuShape = (radius: number): MorphShape => ({
  top: MORPH_EDGE,
  right: MORPH_EDGE,
  bottom: MORPH_EDGE,
  left: MORPH_EDGE,
  radius,
})

/**
 * The trigger's box inside the menu. The menu opens over the trigger with one corner shared:
 * `side` says whether the menu extends above (`top`) or below (`bottom`) the trigger, and
 * `align` says which edges line up, the left ones (`start`) or the right ones (`end`).
 * Sizes are border-box sizes.
 */
export const triggerShape = (
  menu: { width: number; height: number },
  trigger: { width: number; height: number; radius: number },
  side: MorphSide,
  align: MorphAlign
): MorphShape => {
  const spareX = Math.max(0, menu.width - trigger.width)
  const spareY = Math.max(0, menu.height - trigger.height)
  return {
    top: MORPH_EDGE + (side === 'top' ? spareY : 0),
    bottom: MORPH_EDGE + (side === 'top' ? 0 : spareY),
    left: MORPH_EDGE + (align === 'end' ? spareX : 0),
    right: MORPH_EDGE + (align === 'end' ? 0 : spareX),
    radius: Math.min(trigger.radius, trigger.width / 2, trigger.height / 2),
  }
}

/**
 * The clip for the menu's content, so content shows only where the background already is.
 * `content` is the content element's box in the menu's padding box; `padding` is the padding
 * box's size. Returns insets from the content's own edges, never negative.
 */
export const contentClip = (
  shape: MorphShape,
  content: { top: number; left: number; width: number; height: number },
  padding: { width: number; height: number }
) => {
  const top = Math.max(0, shape.top - content.top)
  const left = Math.max(0, shape.left - content.left)
  const right = Math.max(0, content.left + content.width - (padding.width - shape.right))
  const bottom = Math.max(0, content.top + content.height - (padding.height - shape.bottom))
  const radius = Math.max(0, shape.radius - Math.min(content.top, content.left) + MORPH_EDGE)
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`
}

/**
 * Samples a morph from one shape to another every ~12ms, each axis on its own curve, into
 * evenly spaced shapes for linear keyframes. One sampled list can then drive both the
 * background and the content's clip, which a single CSS easing could not.
 */
export const sampleMorph = (from: MorphShape, to: MorphShape, motion: MorphMotion) => {
  const total = Math.max(motion.yMs, motion.xMs)
  const steps = Math.max(2, Math.round(total / 12))
  return {
    total,
    shapes: Array.from({ length: steps + 1 }, (_, index): MorphShape => {
      const time = (index / steps) * total
      const y = motion.y(Math.min(1, time / motion.yMs))
      const x = motion.x(Math.min(1, time / motion.xMs))
      return {
        top: lerp(from.top, to.top, y),
        bottom: lerp(from.bottom, to.bottom, y),
        left: lerp(from.left, to.left, x),
        right: lerp(from.right, to.right, x),
        radius: Math.max(0, lerp(from.radius, to.radius, y)),
      }
    }),
  }
}
