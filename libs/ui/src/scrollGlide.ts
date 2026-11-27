/**
 * Programmatic scrolling that feels like the reader's own: a critically damped spring drives
 * `scrollTop` the whole way to the target, so a glide decelerates into place without overshoot,
 * and a new target mid-flight keeps the current velocity instead of restarting. Longer jumps travel
 * faster rather than taking proportionally longer.
 *
 * The spring maths is pure and exported for tests; `createScrollGlide` binds it to one element.
 */

export type ScrollSpring = { readonly position: number; readonly velocity: number }

/** Spring stiffness (1/s²). Damping is critical (2√k), so a glide never overshoots its target. */
export const SCROLL_GLIDE_STIFFNESS = 210

const SUBSTEP_SECONDS = 0.004
const SETTLE_DISTANCE_PX = 0.5
const SETTLE_SPEED_PX = 10
const MAX_FRAME_SECONDS = 0.034

/** Advances a critically damped spring toward `target` by `seconds` (semi-implicit Euler). */
export const stepScrollSpring = (
  spring: ScrollSpring,
  target: number,
  seconds: number,
  stiffness = SCROLL_GLIDE_STIFFNESS
): ScrollSpring => {
  const damping = 2 * Math.sqrt(stiffness)
  const steps = Math.max(1, Math.ceil(seconds / SUBSTEP_SECONDS))
  const dt = seconds / steps
  let { position, velocity } = spring
  for (let index = 0; index < steps; index += 1) {
    velocity += (-stiffness * (position - target) - damping * velocity) * dt
    position += velocity * dt
  }
  return { position, velocity }
}

/** Whether a spring is close enough to `target`, and slow enough, to snap the last fraction. */
export const scrollSpringSettled = (spring: ScrollSpring, target: number): boolean =>
  Math.abs(spring.position - target) < SETTLE_DISTANCE_PX &&
  Math.abs(spring.velocity) < SETTLE_SPEED_PX

export type ScrollGlideOptions = {
  /** Called once the glide lands; not called when cancelled or retargeted with a new callback. */
  readonly onDone?: () => void
  /** Jump without animating. */
  readonly instant?: boolean
}

export type ScrollGlide = {
  /** Glides to `top` (clamped to the scroll range); retargets a glide already in flight. */
  readonly to: (top: number, options?: ScrollGlideOptions) => void
  /** Stops a glide where it is. */
  readonly cancel: () => void
  readonly isActive: () => boolean
}

type GlideRun = {
  target: number
  spring: ScrollSpring
  last: number
  frame: number
  onDone: (() => void) | undefined
  dead: boolean
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Binds a spring glide to one scroll container. Create one per element and keep it. */
export const createScrollGlide = (el: HTMLElement): ScrollGlide => {
  let run: GlideRun | null = null

  const maxTop = () => Math.max(0, el.scrollHeight - el.clientHeight)
  const clampTop = (top: number) => Math.min(maxTop(), Math.max(0, top))

  const cancel = () => {
    if (!run) {
      return
    }
    run.dead = true
    cancelAnimationFrame(run.frame)
    run = null
  }

  const tick = (current: GlideRun) => (now: number) => {
    if (current.dead) {
      return
    }
    const seconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - current.last) / 1000))
    current.last = now
    current.target = clampTop(current.target)
    current.spring = stepScrollSpring(current.spring, current.target, seconds)
    el.scrollTop = current.spring.position
    if (scrollSpringSettled(current.spring, current.target)) {
      el.scrollTop = current.target
      current.dead = true
      run = null
      current.onDone?.()
      return
    }
    current.frame = requestAnimationFrame(tick(current))
  }

  const startSpring = (current: GlideRun) => {
    current.spring = { position: el.scrollTop, velocity: current.spring.velocity }
    current.last = performance.now()
    current.frame = requestAnimationFrame(tick(current))
  }

  const to = (top: number, options: ScrollGlideOptions = {}) => {
    const target = clampTop(top)
    if (run && !options.instant) {
      run.target = target
      run.onDone = options.onDone
      return
    }
    cancel()
    if (options.instant || prefersReducedMotion() || Math.abs(target - el.scrollTop) < 1) {
      el.scrollTop = target
      options.onDone?.()
      return
    }
    const current: GlideRun = {
      target,
      spring: { position: el.scrollTop, velocity: 0 },
      last: 0,
      frame: 0,
      onDone: options.onDone,
      dead: false,
    }
    run = current
    startSpring(current)
  }

  return { to, cancel, isActive: () => run !== null }
}

const SCROLL_INTENT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Calls `handler` whenever the reader starts scrolling `el` themselves (wheel, touch, pointer on
 * the scrollbar or content, keys). Use it to cancel a glide and to tell the reader's own scrolling
 * apart from programmatic scrolling. Returns an unsubscribe function.
 */
export const onScrollIntent = (el: HTMLElement, handler: () => void): (() => void) => {
  for (const type of SCROLL_INTENT_EVENTS) {
    el.addEventListener(type, handler, { passive: true })
  }
  return () => {
    for (const type of SCROLL_INTENT_EVENTS) {
      el.removeEventListener(type, handler)
    }
  }
}
