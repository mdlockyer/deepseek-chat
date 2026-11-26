/**
 * Programmatic scrolling that feels like the reader's own: a critically damped spring drives
 * `scrollTop`, so a glide decelerates into place without overshoot, and a new target mid-flight
 * keeps the current velocity instead of restarting. Long jumps would otherwise smear many screens
 * of text past the eye, so beyond `SCROLL_GLIDE_LONG_JUMP` viewports the content fades out, the
 * scroll cuts to just short of the target, and the spring glides the last stretch while the
 * content fades back in.
 *
 * The spring maths is pure and exported for tests; `createScrollGlide` binds it to one element.
 */

export type ScrollSpring = { readonly position: number; readonly velocity: number }

/** Spring stiffness (1/s²). Damping is critical (2√k), so a glide never overshoots its target. */
export const SCROLL_GLIDE_STIFFNESS = 210

/** Jumps longer than this many viewport heights cut and fade instead of scrolling the whole way. */
export const SCROLL_GLIDE_LONG_JUMP = 1.4

/** How far short of the target, in viewport heights, a long jump cuts to before gliding. */
export const SCROLL_GLIDE_LEAD_IN = 0.42

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

/**
 * Where a glide from `from` to `to` starts its spring in a viewport `viewport` px tall: at `from`
 * for ordinary distances, or `SCROLL_GLIDE_LEAD_IN` viewports short of `to` (on the side it came
 * from) for long jumps, which cut there under a fade.
 */
export const planScrollGlide = (
  from: number,
  to: number,
  viewport: number
): { readonly cut: boolean; readonly start: number } => {
  const distance = to - from
  if (Math.abs(distance) <= viewport * SCROLL_GLIDE_LONG_JUMP) {
    return { cut: false, start: from }
  }
  return { cut: true, start: to - Math.sign(distance) * viewport * SCROLL_GLIDE_LEAD_IN }
}

export type ScrollGlideOptions = {
  /** Content to fade during a long jump's cut (usually the scroller's only child). */
  readonly fade?: HTMLElement | null
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
  fadeOut: Animation | null
  onDone: (() => void) | undefined
  dead: boolean
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Reads a motion token as resolved on `el`, so reduced-motion overrides apply to script motion too. */
export const readMotionMs = (el: Element, token: string, fallback: number): number => {
  const raw = getComputedStyle(el).getPropertyValue(token).trim()
  const amount = Number.parseFloat(raw)
  if (Number.isNaN(amount)) {
    return fallback
  }
  return raw.endsWith('ms') ? amount : amount * 1000
}

export const readMotionEasing = (el: Element, token: string, fallback: string): string =>
  getComputedStyle(el).getPropertyValue(token).trim() || fallback

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
    run.fadeOut?.cancel()
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
      fadeOut: null,
      onDone: options.onDone,
      dead: false,
    }
    run = current
    const plan = planScrollGlide(el.scrollTop, target, el.clientHeight)
    const fade = options.fade
    if (!plan.cut) {
      startSpring(current)
      return
    }
    if (!fade || typeof fade.animate !== 'function') {
      el.scrollTop = plan.start
      startSpring(current)
      return
    }
    const fadeOut = fade.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: readMotionMs(fade, '--ui-duration-fast', 120),
      easing: 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'forwards',
    })
    current.fadeOut = fadeOut
    fadeOut.onfinish = () => {
      if (current.dead) {
        return
      }
      el.scrollTop = planScrollGlide(el.scrollTop, current.target, el.clientHeight).start
      fade.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: readMotionMs(fade, '--ui-duration-slow', 300),
        easing: readMotionEasing(fade, '--ui-ease-fade', 'ease-out'),
      })
      fadeOut.cancel()
      current.fadeOut = null
      startSpring(current)
    }
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
