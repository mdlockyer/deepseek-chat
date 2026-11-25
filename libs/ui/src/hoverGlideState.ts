export type GlideRect = {
  x: number
  y: number
  width: number
  height: number
  radius?: string | null
}

export type BoxRect = {
  left: number
  top: number
  width: number
  height: number
}

export type HoverGlideState<T = unknown> =
  | { kind: 'cold' }
  | { kind: 'active'; target: T; rect: GlideRect; muted: boolean }
  | { kind: 'cooling'; rect: GlideRect }

export type HoverGlideEffect = {
  changed: boolean
  rect: GlideRect | null
  visible: boolean
  animatePosition: boolean
  scheduleCooldown: boolean
  cancelCooldown: boolean
  resetGeometry: boolean
}

export type HoverGlideTransition<T = unknown> = {
  state: HoverGlideState<T>
  effect: HoverGlideEffect
}

const NO_OP_EFFECT: HoverGlideEffect = {
  changed: false,
  rect: null,
  visible: false,
  animatePosition: false,
  scheduleCooldown: false,
  cancelCooldown: false,
  resetGeometry: false,
}

export const INITIAL_HOVER_GLIDE_STATE: HoverGlideState<never> = { kind: 'cold' }

/** Compute an item's box inside a container's scroll-content coordinate space. */
export const measureGlideRect = (
  targetRect: BoxRect,
  containerRect: BoxRect,
  scrollLeft: number,
  scrollTop: number,
  clientLeft = 0,
  clientTop = 0
): GlideRect => ({
  x: targetRect.left - containerRect.left + scrollLeft - clientLeft,
  y: targetRect.top - containerRect.top + scrollTop - clientTop,
  width: targetRect.width,
  height: targetRect.height,
})

export const glideRectsEqual = (a: GlideRect, b: GlideRect): boolean =>
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  (a.radius ?? null) === (b.radius ?? null)

const RADIUS_TOKEN_RE = /^(?:0|(\d+(?:\.\d+)?|\.\d+)(px|%))$/

const formatRadiusPx = (value: number): string => `${Math.round(value * 100) / 100}px`

/**
 * Normalize a target element's computed CSS `border-radius` for smooth gliding transitions.
 * Clamps each corner to half the smaller box dimension so capsule radii (e.g. `9999px`)
 * interpolate smoothly to and from standard rounded rectangles instead of snapping.
 */
export const normalizeGlideRadius = (
  rawRadius: string | null | undefined,
  width: number,
  height: number
): string | null => {
  if (!rawRadius || width <= 0 || height <= 0) {
    return null
  }
  const trimmed = rawRadius.trim()
  if (!trimmed || trimmed.includes('/')) {
    return null
  }
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 1 || tokens.length > 4) {
    return null
  }
  const minDim = Math.min(width, height)
  const maxRadius = minDim / 2
  const resolved: string[] = []
  for (const token of tokens) {
    const match = RADIUS_TOKEN_RE.exec(token)
    if (!match) {
      return null
    }
    if (token === '0') {
      resolved.push('0px')
      continue
    }
    const amount = Number(match[1])
    const unit = match[2]
    const px = unit === '%' ? (amount / 100) * minDim : amount
    resolved.push(formatRadiusPx(Math.min(Math.max(0, px), maxRadius)))
  }
  return resolved.every((value) => value === resolved[0]) ? resolved[0] : resolved.join(' ')
}

/**
 * Move the hover glide indicator onto a target item:
 * cold entry snaps immediately, warm transitions glide smoothly, and muted items
 * track invisibly so moving off them emerges directly from the active item.
 */
export const enterGlideTarget = <T>(
  state: HoverGlideState<T>,
  target: T,
  rect: GlideRect,
  muted: boolean,
  options: { snap?: boolean } = {}
): HoverGlideTransition<T> => {
  if (
    state.kind === 'active' &&
    state.target === target &&
    state.muted === muted &&
    glideRectsEqual(state.rect, rect)
  ) {
    return { state, effect: NO_OP_EFFECT }
  }

  const animatePosition = !options.snap && state.kind !== 'cold'
  return {
    state: { kind: 'active', target, rect, muted },
    effect: {
      changed: true,
      rect,
      visible: !muted,
      animatePosition,
      scheduleCooldown: false,
      cancelCooldown: state.kind === 'cooling',
      resetGeometry: false,
    },
  }
}

/** Resync the active item's box after container resize or layout shift without gliding. */
export const syncGlideRect = <T>(
  state: HoverGlideState<T>,
  rect: GlideRect
): HoverGlideTransition<T> => {
  if (state.kind !== 'active' || glideRectsEqual(state.rect, rect)) {
    return { state, effect: NO_OP_EFFECT }
  }
  return {
    state: { ...state, rect },
    effect: {
      changed: true,
      rect,
      visible: !state.muted,
      animatePosition: false,
      scheduleCooldown: false,
      cancelCooldown: false,
      resetGeometry: false,
    },
  }
}

/** Leave the current item into a brief warm cooldown so crossing section gaps stays fluid. */
export const leaveGlideTarget = <T>(state: HoverGlideState<T>): HoverGlideTransition<T> => {
  if (state.kind !== 'active') {
    return { state, effect: NO_OP_EFFECT }
  }
  return {
    state: { kind: 'cooling', rect: state.rect },
    effect: {
      changed: true,
      rect: state.rect,
      visible: false,
      animatePosition: true,
      scheduleCooldown: true,
      cancelCooldown: false,
      resetGeometry: false,
    },
  }
}

/** Expire the warm cooldown and collapse the hidden indicator so it never pads scrollHeight. */
export const expireGlideCooldown = <T>(state: HoverGlideState<T>): HoverGlideTransition<T> => {
  if (state.kind !== 'cooling') {
    return { state, effect: NO_OP_EFFECT }
  }
  return {
    state: { kind: 'cold' },
    effect: {
      changed: true,
      rect: null,
      visible: false,
      animatePosition: false,
      scheduleCooldown: false,
      cancelCooldown: false,
      resetGeometry: true,
    },
  }
}
