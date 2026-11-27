/**
 * The agent cursor: a small solid kite in the app's accent blue with a white edge, its tip on the
 * point it acts on. It glides on a critically damped spring, presses (shrinks a little) as it
 * clicks, and carries a faint glow that follows its outline: almost none at rest, more as it moves
 * faster, and a short bloom on each press. Reduced motion makes it jump, with no glow.
 *
 * One implementation draws it in two places: in the app's own window over the browser's toolbar,
 * and inside web pages, where the driver scripts embed this function's source. So the function
 * must stay self-contained: everything it uses comes from its parameters or from globals every
 * page has (`Math`, `performance`), never from this module's scope or imports.
 */

export type KiteCursor = {
  /** Starts a glide to (x, y); returns roughly how long it takes to land, in milliseconds. */
  readonly moveTo: (x: number, y: number) => number
  /** Puts the cursor at (x, y) at once. */
  readonly place: (x: number, y: number) => void
  /** Presses at (x, y), first jumping there if the cursor is elsewhere. */
  readonly press: (x: number, y: number) => void
  readonly show: () => void
  readonly hide: () => void
  /** Hides it while a screenshot is taken, without forgetting whether it was shown. */
  readonly setCaptured: (captured: boolean) => void
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
  // A kite with its tip at (HOT, HOT), widest about two thirds of the way back.
  kite.setAttribute('points', '2,2 16.9,9.1 17.75,17.75 9.1,16.9')
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
  let x = Number.NaN
  let y = Number.NaN
  let tx = Number.NaN
  let ty = Number.NaN
  let vx = 0
  let vy = 0
  let scale = 1
  let pressUntil = 0
  let pulse = 0
  let glow = 0
  let frame = 0
  let last = 0
  let shown = false
  let captured = false

  const paint = () => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return
    }
    const speed = Math.min(1, Math.hypot(vx, vy) / 900)
    const radius = 2.5 + 3 * speed + 3 * pulse
    wrap.style.transform =
      'translate(' +
      (x - HOT).toFixed(2) +
      'px,' +
      (y - HOT).toFixed(2) +
      'px) scale(' +
      scale.toFixed(3) +
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
      x = tx
      y = ty
      vx = 0
      vy = 0
    } else {
      const damping = 2 * Math.sqrt(SPRING)
      for (let i = 0; i < 4; i += 1) {
        const h = dt / 4
        vx += (-SPRING * (x - tx) - damping * vx) * h
        vy += (-SPRING * (y - ty) - damping * vy) * h
        x += vx * h
        y += vy * h
      }
    }
    pulse = Math.max(0, pulse - dt / 0.45)
    const speed = Math.min(1, Math.hypot(vx, vy) / 900)
    const glowGoal = reduce ? 0 : Math.min(0.6, 0.08 + 0.34 * speed + 0.4 * pulse)
    glow += (glowGoal - glow) * Math.min(1, dt * 12)
    scale += ((now < pressUntil ? 0.84 : 1) - scale) * Math.min(1, dt * 30)
    paint()
    const settled =
      Math.abs(x - tx) < 0.3 &&
      Math.abs(y - ty) < 0.3 &&
      Math.hypot(vx, vy) < 5 &&
      pulse === 0 &&
      Math.abs(scale - 1) < 0.002 &&
      Math.abs(glow - glowGoal) < 0.005
    if (settled) {
      x = tx
      y = ty
      vx = 0
      vy = 0
      scale = 1
      paint()
      last = 0
      return
    }
    frame = win.requestAnimationFrame(tick)
  }

  const wake = () => {
    if (!frame) {
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
  }
  const place = (px: number, py: number) => {
    x = px
    y = py
    tx = px
    ty = py
    vx = 0
    vy = 0
    paint()
  }

  const moveTo = (px: number, py: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      place(px, py)
    }
    tx = px
    ty = py
    show()
    wake()
    if (reduce) {
      return 0
    }
    // Run the same spring ahead of time to see when it lands.
    let ox = x - px
    let oy = y - py
    let ux = vx
    let uy = vy
    let ms = 0
    const damping = 2 * Math.sqrt(SPRING)
    const h = 1 / 240
    while (ms < 900 && (Math.hypot(ox, oy) > 1.5 || Math.hypot(ux, uy) > 30)) {
      ux += (-SPRING * ox - damping * ux) * h
      uy += (-SPRING * oy - damping * uy) * h
      ox += ux * h
      oy += uy * h
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
    press,
    show,
    hide,
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
