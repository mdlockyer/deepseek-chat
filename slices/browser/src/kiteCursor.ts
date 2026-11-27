/**
 * The agent cursor: a small solid kite in the app's accent blue with a white edge, its tip on the
 * point it acts on. It glides along a gentle arc, leaning into sideways moves and arriving a pixel
 * or two past its target before settling back; it presses (shrinks a little) as it clicks, drifts
 * and tilts very slightly while it waits, and carries a faint glow that follows its
 * outline: almost none at rest, more as it moves faster, and a short bloom on each press. Reduced
 * motion makes it jump, with no glow and no drift.
 *
 * One implementation draws it in two places: in the app's own window over the browser's toolbar,
 * and inside web pages, where the driver scripts embed this function's source. So the function
 * must stay self-contained: everything it uses comes from its parameters or from globals every
 * page has (`Math`, `performance`), never from this module's scope or imports. That is also why
 * it carries its own copy of the spring that `@deepseek-chat/lib-ui`'s `createScrollGlide` uses
 * (`stepScrollSpring`): the kit cannot be imported into a web page.
 */

export type KiteCursor = {
  /** Starts a glide to (x, y); returns roughly how long it takes to land, in milliseconds. */
  readonly moveTo: (x: number, y: number) => number
  /** Puts the cursor at (x, y) at once. */
  readonly place: (x: number, y: number) => void
  /** Puts the cursor at (x, y) already moving at (vx, vy) px/s, for the next glide to carry on. */
  readonly launch: (x: number, y: number, vx: number, vy: number) => void
  /**
   * When the current glide's tip first crosses the line `y` (in either direction), and how fast it
   * is moving then; `null` if it does not cross within 0.9 s. Lets a second cursor in another layer
   * take over at the same place, time and speed.
   */
  readonly crossing: (y: number) => {
    readonly ms: number
    readonly x: number
    readonly vx: number
    readonly vy: number
  } | null
  /** Presses at (x, y), first jumping there if the cursor is elsewhere. */
  readonly press: (x: number, y: number) => void
  readonly show: () => void
  readonly hide: () => void
  /** Hides it while a screenshot is taken, without forgetting whether it was shown. */
  readonly setCaptured: (captured: boolean) => void
  /**
   * How many of this document's pixels make one pixel on screen. A page shown scaled down (a wide
   * viewport fitted into the panel) passes more than 1, so the kite, its drift and its arcs keep
   * the same size on screen.
   */
  readonly setUnit: (unit: number) => void
  /** Where it is heading, or `null` before it has been anywhere. */
  readonly position: () => { readonly x: number; readonly y: number } | null
  readonly isShown: () => boolean
  readonly isConnected: () => boolean
  readonly destroy: () => void
}

export function createKiteCursor(doc: Document, win: Window & typeof globalThis): KiteCursor {
  const SPRING = 170
  const SIZE = 22
  const HOT = 2
  const BLUE = 'oklch(0.57 0.233 267)'
  const SVG = 'http://www.w3.org/2000/svg'

  const host = doc.createElement('ds-agent-cursor')
  host.setAttribute('aria-hidden', 'true')
  host.setAttribute('data-ds-cursor', '1')
  host.style.cssText =
    'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
  const root: ShadowRoot | HTMLElement =
    typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host
  const wrap = doc.createElement('div')
  wrap.style.cssText =
    'position:absolute;left:0;top:0;width:' +
    SIZE +
    'px;height:' +
    SIZE +
    'px;pointer-events:none;transform-origin:' +
    HOT +
    'px ' +
    HOT +
    'px;opacity:0;transition:opacity 180ms cubic-bezier(0.4,0,0.2,1);will-change:transform,filter;'
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('width', String(SIZE))
  svg.setAttribute('height', String(SIZE))
  svg.setAttribute('viewBox', '0 0 ' + SIZE + ' ' + SIZE)
  svg.style.cssText = 'display:block;overflow:visible;'
  const kite = doc.createElementNS(SVG, 'polygon')
  // A kite with its tip at (HOT, HOT): a 50° tip, widest about 60% of the way back.
  kite.setAttribute('points', '2,2 14.65,6.61 16.5,16.5 6.61,14.65')
  kite.setAttribute('stroke', '#ffffff')
  kite.setAttribute('stroke-width', '1.5')
  kite.setAttribute('stroke-linejoin', 'round')
  kite.style.fill = '#4364f7'
  kite.style.fill = BLUE
  svg.appendChild(kite)
  wrap.appendChild(svg)
  root.appendChild(wrap)
  ;(doc.documentElement || doc.body).appendChild(host)

  const reduce =
    typeof win.matchMedia === 'function' &&
    win.matchMedia('(prefers-reduced-motion: reduce)').matches

  // A glide follows a gentle arc from where it starts to the target: a quadratic curve whose middle
  // bulges to one side by 7% of the distance, at most 32 px (its control point sits twice as far). A slightly underdamped spring drives progress
  // along it, so the cursor arrives a little past the target and settles back: 2% of the distance
  // on short moves, never more than 2.5 px.
  // Document pixels per screen pixel (see `setUnit`).
  let unit = 1
  const BOW = 0.14
  const MAX_BOW = 64
  const OVERSHOOT = 0.02
  const MAX_OVERSHOOT_PX = 2.5
  /** Spring damping for a glide of `distance` px that overshoots by the allowed amount. */
  const dampingFor = (distance: number) => {
    const fraction = Math.min(OVERSHOOT, (MAX_OVERSHOOT_PX * unit) / Math.max(1, distance))
    const log = Math.log(fraction)
    const ratio = -log / Math.sqrt(Math.PI * Math.PI + log * log)
    return 2 * ratio * Math.sqrt(SPRING)
  }
  let damping = dampingFor(0)
  let fx = Number.NaN
  let fy = Number.NaN
  let cx = Number.NaN
  let cy = Number.NaN
  let tx = Number.NaN
  let ty = Number.NaN
  let s = 1
  let sv = 0
  // Where it is drawn, and how fast that is moving (px/s).
  let x = Number.NaN
  let y = Number.NaN
  let vx = 0
  let vy = 0
  let lean = 0
  let scale = 1
  let pressUntil = 0
  let pulse = 0
  let glow = 0
  let frame = 0
  let last = 0
  let shown = false
  let captured = false
  // While it waits, it drifts a pixel or so and tilts a couple of degrees, like a kite holding in
  // the air, so it reads as alive rather than frozen. `idle` blends that in once it has settled.
  let idle = 0
  let clock = 0

  /** The point at progress `t` along the arc; past the end it carries on along the arc's tangent. */
  const along = (t: number) => {
    if (t <= 1) {
      const u = 1 - t
      return {
        px: u * u * fx + 2 * u * t * cx + t * t * tx,
        py: u * u * fy + 2 * u * t * cy + t * t * ty,
      }
    }
    return { px: tx + 2 * (tx - cx) * (t - 1), py: ty + 2 * (ty - cy) * (t - 1) }
  }

  const paint = () => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return
    }
    const speed = Math.min(1, Math.hypot(vx, vy) / unit / 900)
    const radius = 2.5 + 3 * speed + 3 * pulse
    const turn = Math.PI * 2
    const sway = idle * unit
    const dx =
      sway * (1.1 * Math.sin((turn * clock) / 3.7) + 0.5 * Math.sin((turn * clock) / 1.9 + 1))
    const dy =
      sway * (0.9 * Math.sin((turn * clock) / 4.3 + 2) + 0.4 * Math.sin((turn * clock) / 2.3))
    const tilt = lean + idle * 2.5 * Math.sin((turn * clock) / 5.1 + 0.5)
    wrap.style.transform =
      'translate(' +
      (x - HOT + dx).toFixed(2) +
      'px,' +
      (y - HOT + dy).toFixed(2) +
      'px) rotate(' +
      tilt.toFixed(2) +
      'deg) scale(' +
      (scale * unit).toFixed(3) +
      ')'
    wrap.style.filter =
      glow > 0.01
        ? 'drop-shadow(0 0 ' +
          radius.toFixed(1) +
          'px oklch(0.57 0.233 267 / ' +
          glow.toFixed(3) +
          '))'
        : 'none'
  }

  const tick = (now: number) => {
    frame = 0
    const dt = last ? Math.min(0.034, Math.max(0, (now - last) / 1000)) : 0.016
    last = now
    if (reduce) {
      s = 1
      sv = 0
    } else {
      for (let i = 0; i < 4; i += 1) {
        const h = dt / 4
        sv += (-SPRING * (s - 1) - damping * sv) * h
        s += sv * h
      }
    }
    if (Math.abs(s - 1) < 0.0015 && Math.abs(sv) < 0.02) {
      s = 1
      sv = 0
    }
    const at = along(s)
    vx = dt > 0 ? (at.px - x) / dt : 0
    vy = dt > 0 ? (at.py - y) / dt : 0
    x = at.px
    y = at.py
    // Lean up to 10° into sideways movement, and straighten as it slows.
    const leanGoal = reduce ? 0 : Math.max(-10, Math.min(10, (vx / unit) * 0.011))
    lean += (leanGoal - lean) * Math.min(1, dt * 9)
    pulse = Math.max(0, pulse - dt / 0.45)
    const speed = Math.min(1, Math.hypot(vx, vy) / unit / 900)
    const glowGoal = reduce ? 0 : Math.min(0.6, 0.08 + 0.34 * speed + 0.4 * pulse)
    glow += (glowGoal - glow) * Math.min(1, dt * 12)
    scale += ((now < pressUntil ? 0.84 : 1) - scale) * Math.min(1, dt * 30)
    const resting = s === 1 && Math.abs(lean) < 0.05 && pulse === 0 && Math.abs(scale - 1) < 0.002
    // Ease into the drift over a second or so; drop it quickly as soon as it moves or presses.
    const idleGoal = resting && shown && !reduce ? 1 : 0
    idle += (idleGoal - idle) * Math.min(1, dt * (idleGoal ? 1.2 : 10))
    clock += dt
    paint()
    if (resting && idleGoal === 0 && idle < 0.002 && Math.abs(glow - glowGoal) < 0.005) {
      vx = 0
      vy = 0
      lean = 0
      scale = 1
      idle = 0
      paint()
      last = 0
      return
    }
    frame = win.requestAnimationFrame(tick)
  }

  const wake = () => {
    if (!frame && Number.isFinite(x) && Number.isFinite(y)) {
      frame = win.requestAnimationFrame(tick)
    }
  }

  const show = () => {
    shown = true
    if (!captured) {
      wrap.style.opacity = '1'
    }
  }
  const hide = () => {
    shown = false
    wrap.style.opacity = '0'
    wake()
  }
  const place = (px: number, py: number) => {
    fx = px
    fy = py
    cx = px
    cy = py
    tx = px
    ty = py
    x = px
    y = py
    s = 1
    sv = 0
    vx = 0
    vy = 0
    paint()
  }

  const launch = (px: number, py: number, ux: number, uy: number) => {
    place(px, py)
    vx = Number.isFinite(ux) ? ux : 0
    vy = Number.isFinite(uy) ? uy : 0
    // It takes over from a cursor in another layer mid-move: appear at once, not fade in.
    const fade = wrap.style.transition
    wrap.style.transition = 'none'
    shown = true
    wrap.style.opacity = captured ? '0' : '1'
    void wrap.offsetWidth
    wrap.style.transition = fade
  }

  const crossing = (line: number) => {
    if (s >= 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null
    }
    let ps = s
    let pv = sv
    let ms = 0
    let before = along(ps)
    const h = 1 / 240
    while (ms < 900) {
      pv += (-SPRING * (ps - 1) - damping * pv) * h
      ps += pv * h
      ms += 1000 * h
      const after = along(ps)
      if ((before.py - line) * (after.py - line) <= 0) {
        return {
          ms: Math.round(ms),
          x: after.px,
          vx: (after.px - before.px) / h,
          vy: (after.py - before.py) / h,
        }
      }
      before = after
    }
    return null
  }

  const moveTo = (px: number, py: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      place(px, py)
    }
    const dx = px - x
    const dy = py - y
    const distance = Math.hypot(dx, dy)
    show()
    if (distance < 0.5) {
      place(px, py)
      wake()
      return 0
    }
    // Bow to the same side for the same direction of travel, so paths look deliberate.
    const side = dx * 0.3 + dy > 0 ? 1 : -1
    const bow = Math.min(MAX_BOW * unit, distance * BOW) * side
    fx = x
    fy = y
    tx = px
    ty = py
    cx = (fx + tx) / 2 - (dy / distance) * bow
    cy = (fy + ty) / 2 + (dx / distance) * bow
    // Keep its current speed: start progress moving at the part of its velocity along the arc.
    const startX = 2 * (cx - fx)
    const startY = 2 * (cy - fy)
    const startLength = startX * startX + startY * startY
    damping = dampingFor(distance)
    s = 0
    sv = startLength > 0 ? Math.max(0, (vx * startX + vy * startY) / startLength) : 0
    wake()
    if (reduce) {
      return 0
    }
    // Run the same spring ahead of time to see when it lands (within 1.5 px, nearly still).
    let ps = 0
    let pv = sv
    let ms = 0
    const h = 1 / 240
    while (
      ms < 900 &&
      (Math.abs(1 - ps) * distance > 1.5 * unit || Math.abs(pv) * distance > 30 * unit)
    ) {
      pv += (-SPRING * (ps - 1) - damping * pv) * h
      ps += pv * h
      ms += 1000 * h
    }
    return Math.round(ms)
  }

  const press = (px: number, py: number) => {
    if (!Number.isFinite(tx) || Math.hypot(tx - px, ty - py) > 2) {
      place(px, py)
    }
    pressUntil = win.performance.now() + 120
    pulse = 1
    show()
    wake()
  }

  // The reader's own pointer, keys or wheel take the page back: the cursor steps aside.
  const onReaderInput = (event: Event) => {
    if (event.isTrusted) {
      hide()
    }
  }
  const readerEvents = ['pointerdown', 'keydown', 'wheel']
  for (const type of readerEvents) {
    doc.addEventListener(type, onReaderInput, { capture: true, passive: true })
  }

  return {
    moveTo,
    place,
    launch,
    crossing,
    press,
    show,
    hide,
    setUnit: (next: number) => {
      if (Number.isFinite(next) && next > 0 && Math.abs(next - unit) > 0.001) {
        unit = next
        paint()
      }
    },
    setCaptured: (next: boolean) => {
      captured = next
      wrap.style.visibility = next ? 'hidden' : 'visible'
      if (!next && shown) {
        wrap.style.opacity = '1'
      }
    },
    position: () => (Number.isFinite(tx) && Number.isFinite(ty) ? { x: tx, y: ty } : null),
    isShown: () => shown,
    isConnected: () => host.isConnected,
    destroy: () => {
      if (frame) {
        win.cancelAnimationFrame(frame)
      }
      for (const type of readerEvents) {
        doc.removeEventListener(type, onReaderInput, { capture: true })
      }
      host.remove()
    },
  }
}
