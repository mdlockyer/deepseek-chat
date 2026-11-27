import { createScrollGlide, readingLineY } from '@deepseek-chat/lib-ui'
import { measure, type Measure } from './minimapRail.js'
import styles from './MinimapStudy.module.css'

/**
 * Prototype only: a minimap rail that stays readable as the chat grows.
 *
 * Two ideas work together:
 *
 * 1. Level of detail follows scale. The rail draws each part of the transcript at the detail its
 *    scale can carry: text lines while a line still gets about 2px of rail, then one bar per
 *    paragraph, table or code block, then one slab per answer. Each part fades between levels,
 *    so the rail never shows lines too dense to read.
 * 2. Optionally, a lens around the reading position. Without it the whole chat shares the rail at
 *    one scale and only the window moves. With it, once the chat no longer fits at full detail,
 *    the viewport and about a viewport on either side keep full detail and detail eases off over
 *    the next three viewports. The lens holds still for small scrolls and follows larger ones on
 *    a spring, so the map doesn't flow under every scroll tick.
 */

const PAD = 24
const BIN = 4
const MAX_WIDTH = 44
/** Rail px per transcript px at full detail, and inside the lens. */
const NEAR = 0.1
/** Transcript kept at full detail on each side of the lens's centre, in viewports. */
const LENS_CORE = 1
/** Distance over which detail eases from the lens to the rest of the chat, in viewports. */
const LENS_FALLOFF = 3
/** The most of the rail the lens may take, so the rest of the chat keeps some room. */
const LENS_MAX_SHARE = 0.6
/** How far the reading position moves, in viewports, before the lens follows it. */
const LENS_SLACK = 0.5
/** Spring the lens follows with (critically damped; settles in about half a second). */
const LENS_STIFFNESS = 90
const LINE_HEIGHT = 22

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
/** Text lines show while a line gets at least ~1.3px of rail, fully from 2px. */
const lineAlpha = (scale: number) => smooth(1.3, 2, scale * LINE_HEIGHT)
/** Paragraph bars show while the gaps between paragraphs stay visible. */
const blockAlpha = (scale: number) => smooth(0.014, 0.03, scale)

type MapLayout = {
  readonly top: (y: number) => number
  readonly scaleAt: (y: number) => number
  readonly toContent: (railY: number) => number
}

const layoutMap = (
  height: number,
  viewport: number,
  centre: number | null,
  railTop: number,
  railHeight: number
): MapLayout => {
  const uniform = (scale: number): MapLayout => {
    const top0 = railTop + Math.max(0, (railHeight - height * scale) / 2)
    return {
      top: (y) => top0 + y * scale,
      scaleAt: () => scale,
      toContent: (railY) => (railY - top0) / scale,
    }
  }
  if (centre === null || railHeight / height >= NEAR) {
    return uniform(Math.min(NEAR, railHeight / height))
  }

  const core = viewport * LENS_CORE
  const falloff = viewport * LENS_FALLOFF
  const bins = Math.ceil(height / BIN)
  const weight = new Float32Array(bins)
  let weightSum = 0
  for (let i = 0; i < bins; i += 1) {
    const w = 1 - smooth(core, core + falloff, Math.abs((i + 0.5) * BIN - centre))
    weight[i] = w
    weightSum += w
  }
  const lensSpan = weightSum * BIN
  const near = Math.min(NEAR, (LENS_MAX_SHARE * railHeight) / lensSpan)
  const far = (railHeight - near * lensSpan) / Math.max(1, height - lensSpan)
  if (far >= near) {
    return uniform(railHeight / height)
  }

  const cum = new Float32Array(bins + 1)
  cum[0] = railTop
  for (let i = 0; i < bins; i += 1) {
    cum[i + 1] = (cum[i] ?? 0) + BIN * (far + (near - far) * (weight[i] ?? 0))
  }
  const fit = railHeight / ((cum[bins] ?? railTop + 1) - railTop)
  for (let i = 1; i <= bins; i += 1) {
    cum[i] = railTop + ((cum[i] ?? 0) - railTop) * fit
  }
  const top = (y: number) => {
    const f = clamp(y / BIN, 0, bins)
    const i = Math.min(bins - 1, Math.floor(f))
    const a = cum[i] ?? 0
    return a + ((cum[i + 1] ?? a) - a) * (f - i)
  }
  return {
    top,
    scaleAt: (y) =>
      (far + (near - far) * (weight[clamp(Math.floor(y / BIN), 0, bins - 1)] ?? 0)) * fit,
    toContent: (railY) => {
      let lo = 0
      let hi = bins
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((cum[mid + 1] ?? Infinity) < railY) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      const a = cum[lo] ?? 0
      const b = cum[lo + 1] ?? a + 1
      return (lo + clamp((railY - a) / Math.max(1e-6, b - a), 0, 1)) * BIN
    },
  }
}

const TOKENS = [
  'text-disabled',
  'text-muted',
  'text-secondary',
  'text-primary',
  'border-subtle',
  'border-default',
  'border-strong',
  'interactive-hover',
  'interactive-active',
] as const
type Palette = Record<(typeof TOKENS)[number], string>

const resolvePalette = (host: HTMLElement): Palette => {
  const probe = document.createElement('span')
  host.appendChild(probe)
  const palette = {} as Palette
  for (const token of TOKENS) {
    probe.style.color = `var(--ui-${token})`
    palette[token] = getComputedStyle(probe).color
  }
  probe.remove()
  return palette
}

export const mountAdaptiveMinimap = (
  area: HTMLElement,
  scroll: HTMLElement,
  column: HTMLElement,
  options: { readonly lens: boolean }
) => {
  const hidden = [...area.children].filter((child) => child !== scroll) as HTMLElement[]
  for (const child of hidden) {
    child.style.visibility = 'hidden'
  }

  const host = document.createElement('div')
  host.className = styles.minimapHost
  const canvas = document.createElement('canvas')
  canvas.className = styles.minimap
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)
  const peek = document.createElement('div')
  peek.className = styles.peek
  host.appendChild(peek)
  area.appendChild(host)

  const ctx = canvas.getContext('2d')
  const glide = createScrollGlide(scroll)
  let m: Measure | null = null
  let palette = resolvePalette(host)
  let answerStarts: number[] = []
  let geo = { x: 0, w: 0, gutter: 0, height: 0 }
  let layout: MapLayout | null = null
  let hovered = -1
  let dragging = false
  let lensCentre = scroll.scrollTop + scroll.clientHeight / 2
  let lensVelocity = 0

  const currentLayout = () =>
    m
      ? layoutMap(
          m.height,
          scroll.clientHeight,
          options.lens ? lensCentre : null,
          PAD,
          Math.max(1, geo.height - PAD * 2)
        )
      : null

  const turnAt = (y: number) => {
    let turn = 0
    m?.anchors.forEach((top, i) => {
      if (top <= y + 1) {
        turn = i
      }
    })
    return turn
  }

  const paint = () => {
    if (!m || !ctx) {
      return
    }
    const L = currentLayout()
    layout = L
    if (!L) {
      return
    }
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, geo.gutter, geo.height)
    const { scrollTop, clientHeight, scrollHeight } = scroll
    const current = turnAt(readingLineY(scrollTop, clientHeight, scrollHeight))
    const lit = (turn: number) => turn === current || turn === hovered
    const { x, w } = geo
    const box = (left: number, y0: number, y1: number, width: number, radius: number) => {
      const h = Math.max(0.75, y1 - y0)
      ctx.beginPath()
      ctx.roundRect(left, y0, Math.max(0.75, width), h, Math.min(radius, h / 2, width / 2))
      ctx.fill()
    }

    // Answers as slabs, where paragraphs would be too dense to tell apart.
    m.anchors.forEach((anchor, turn) => {
      const start = answerStarts[turn] ?? anchor
      const end = (m?.anchors[turn + 1] ?? m?.height ?? 0) - 6
      ctx.fillStyle = lit(turn) ? palette['text-muted'] : palette['text-disabled']
      for (let y = start; y < end; y += 64) {
        const y2 = Math.min(end, y + 64)
        const alpha = 1 - blockAlpha(L.scaleAt((y + y2) / 2))
        if (alpha < 0.01) {
          continue
        }
        ctx.globalAlpha = alpha * (lit(turn) ? 0.5 : 0.32)
        ctx.fillRect(x, L.top(y), w * 0.86, L.top(y2) - L.top(y))
      }
    })

    // Paragraphs, tables and code blocks as bars, where lines would be too dense.
    for (const block of m.blocks) {
      const scale = L.scaleAt(block.y + block.h / 2)
      const alpha = (1 - lineAlpha(scale)) * blockAlpha(scale)
      if (alpha < 0.01) {
        continue
      }
      ctx.globalAlpha = alpha * (lit(block.turn) ? 0.55 : 0.3)
      ctx.fillStyle = lit(block.turn) ? palette['text-muted'] : palette['text-disabled']
      box(x + block.x * w, L.top(block.y), L.top(block.y + block.h), block.w * w, 1)
    }

    // Full detail: code backgrounds, table outlines, quote bars, then every line of text.
    for (const b of m.boxes) {
      if (b.kind === 'bubble') {
        continue
      }
      const alpha = lineAlpha(L.scaleAt(b.y + b.h / 2))
      if (alpha < 0.01) {
        continue
      }
      ctx.globalAlpha = alpha
      const y0 = L.top(b.y)
      const y1 = L.top(b.y + b.h)
      if (b.kind === 'table') {
        ctx.strokeStyle = palette['border-default']
        ctx.lineWidth = 0.75
        ctx.beginPath()
        ctx.roundRect(x + b.x * w, y0, b.w * w, y1 - y0, 1.5)
        ctx.stroke()
      } else {
        ctx.fillStyle = b.kind === 'code' ? palette['border-subtle'] : palette['border-strong']
        box(x + b.x * w, y0, y1, b.kind === 'quote' ? 1.5 : b.w * w, 1.5)
      }
    }
    for (const seg of m.segs) {
      if (seg.kind === 'bubble') {
        continue
      }
      const scale = L.scaleAt(seg.y)
      const alpha = lineAlpha(scale)
      if (alpha < 0.01) {
        continue
      }
      const on = lit(seg.turn)
      ctx.globalAlpha = alpha * (seg.kind === 'heading' ? 0.75 : on ? 0.75 : 0.55)
      ctx.fillStyle =
        seg.kind === 'heading'
          ? on
            ? palette['text-primary']
            : palette['text-muted']
          : on
            ? palette['text-secondary']
            : palette['text-disabled']
      const stroke = clamp(seg.h * scale * 0.6, 0.8, seg.kind === 'heading' ? 2.4 : 1.6)
      const mid = (L.top(seg.y) + L.top(seg.y + seg.h)) / 2
      box(x + seg.x * w, mid - stroke / 2, mid + stroke / 2, seg.w * w, stroke / 2)
    }

    // Prompts at every level of detail: they're how you find a turn.
    for (const b of m.boxes) {
      if (b.kind !== 'bubble') {
        continue
      }
      const on = lit(b.turn)
      const y0 = L.top(b.y)
      const h = Math.max(1.5, L.top(b.y + b.h) - y0)
      const width = Math.max(4, b.w * w)
      // Where turns are only a few px apart, their markers would stripe the rail; they fade
      // and the answers read as one continuous slab (the current and hovered turns stay marked).
      const pitch = L.top(m.anchors[b.turn + 1] ?? m.height) - L.top(m.anchors[b.turn] ?? b.y)
      ctx.globalAlpha = on ? 1 : smooth(2.5, 7, pitch)
      ctx.fillStyle = on ? palette['text-primary'] : palette['text-disabled']
      if (h < 3) {
        box(x + w - width, y0, y0 + h, width, h / 2)
      } else {
        ctx.fillStyle = on ? palette['border-strong'] : palette['border-default']
        box(x + b.x * w - 1, y0, y0 + h, width + 2, 3)
      }
    }
    for (const seg of m.segs) {
      if (seg.kind !== 'bubble') {
        continue
      }
      const scale = L.scaleAt(seg.y)
      if (seg.h * scale < 1.6) {
        continue
      }
      ctx.globalAlpha = lit(seg.turn) ? 1 : 0.8
      ctx.fillStyle = lit(seg.turn) ? palette['text-primary'] : palette['text-muted']
      const mid = (L.top(seg.y) + L.top(seg.y + seg.h)) / 2
      box(x + seg.x * w, mid - 0.7, mid + 0.7, seg.w * w, 0.7)
    }

    // The window: what's on screen.
    // In a long chat at one scale the window would shrink to a sliver; keep it grabbable.
    const middle = (L.top(scrollTop) + L.top(scrollTop + clientHeight)) / 2
    const half = Math.max(8, (L.top(scrollTop + clientHeight) - L.top(scrollTop)) / 2)
    const y0 = middle - half
    const y1 = middle + half
    ctx.globalAlpha = 1
    ctx.fillStyle = dragging ? palette['interactive-active'] : palette['interactive-hover']
    ctx.strokeStyle = palette['border-default']
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x - 4.5, y0 + 0.5, w + 9, Math.max(4, y1 - y0) - 1, 4)
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  const draw = () => {
    m = measure(scroll, column)
    palette = resolvePalette(host)
    const areaRect = area.getBoundingClientRect()
    const gutter = Math.max(0, column.getBoundingClientRect().left - areaRect.left)
    const w = Math.min(MAX_WIDTH, gutter - 20)
    geo = { x: Math.max(8, Math.min(16, (gutter - w) / 2)), w, gutter, height: area.clientHeight }
    host.hidden = gutter < 48 || w < 24
    host.style.width = `${gutter}px`
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(gutter * dpr)
    canvas.height = Math.round(geo.height * dpr)
    const bubbles = m.boxes.filter((b) => b.kind === 'bubble')
    answerStarts = m.anchors.map((anchor, turn) => {
      const bubble = bubbles.find((b) => b.turn === turn)
      return bubble ? bubble.y + bubble.h + 12 : anchor
    })
    paint()
  }

  // The lens stays put while the reading position moves within LENS_SLACK of its centre, so
  // small scrolls only move the window; past that it follows on a spring instead of rigidly.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let lastTick = 0
  const tick = (now: number) => {
    frame = 0
    const dt = lastTick ? Math.min(0.05, (now - lastTick) / 1000) : 1 / 60
    lastTick = now
    const target = scroll.scrollTop + scroll.clientHeight / 2
    const slack = scroll.clientHeight * LENS_SLACK
    const desired = dragging ? lensCentre : clamp(lensCentre, target - slack, target + slack)
    if (reducedMotion.matches) {
      lensCentre = desired
      lensVelocity = 0
    } else {
      lensVelocity +=
        (LENS_STIFFNESS * (desired - lensCentre) - 2 * Math.sqrt(LENS_STIFFNESS) * lensVelocity) *
        dt
      lensCentre += lensVelocity * dt
      if (Math.abs(desired - lensCentre) < 0.5 && Math.abs(lensVelocity) < 5) {
        lensCentre = desired
        lensVelocity = 0
      }
    }
    paint()
    if (lensCentre !== desired || lensVelocity !== 0) {
      frame = requestAnimationFrame(tick)
    } else {
      lastTick = 0
    }
  }
  const schedulePaint = () => {
    if (!frame) {
      frame = requestAnimationFrame(tick)
    }
  }
  scroll.addEventListener('scroll', schedulePaint, { passive: true })
  let redraw = 0
  const scheduleDraw = () => {
    clearTimeout(redraw)
    redraw = window.setTimeout(draw, 80)
  }
  const resize = new ResizeObserver(scheduleDraw)
  resize.observe(column)
  resize.observe(area)
  const mutations = new MutationObserver(scheduleDraw)
  mutations.observe(column, { childList: true, subtree: true, characterData: true })
  const theme = new MutationObserver(scheduleDraw)
  theme.observe(document.documentElement, { attributes: true })

  const localY = (event: PointerEvent) => event.clientY - area.getBoundingClientRect().top

  const setHover = (turn: number, event: PointerEvent | null) => {
    if (turn !== hovered) {
      hovered = turn
      schedulePaint()
    }
    if (turn < 0 || !m || !event) {
      peek.removeAttribute('data-open')
      return
    }
    peek.replaceChildren()
    const number = document.createElement('span')
    number.className = styles.peekNumber
    number.textContent = String(turn + 1)
    const label = document.createElement('span')
    label.textContent = m.excerpts[turn] ?? ''
    peek.append(number, label)
    peek.style.left = `${geo.x + geo.w + 14}px`
    peek.style.top = `${localY(event)}px`
    peek.setAttribute('data-open', '')
  }

  let drag: { offset: number; moved: boolean; y: number } | null = null
  const onDown = (event: PointerEvent) => {
    if (!m || !layout || event.button !== 0) {
      return
    }
    event.preventDefault()
    const railY = localY(event)
    const y = layout.toContent(railY)
    setHover(turnAt(y), event)
    const { scrollTop, clientHeight } = scroll
    const windowTop = layout.top(scrollTop)
    const windowBottom = layout.top(scrollTop + clientHeight)
    if (railY < windowTop - 8 || railY > windowBottom + 8) {
      const target = clamp(y - clientHeight / 2, 0, scroll.scrollHeight - clientHeight)
      glide.to(target, { fade: column })
      drag = { offset: (windowBottom - windowTop) / 2, moved: false, y: event.clientY }
    } else {
      drag = { offset: railY - windowTop, moved: false, y: event.clientY }
    }
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers cannot be captured; the drag still follows moves over the rail.
    }
  }
  const onMove = (event: PointerEvent) => {
    if (drag) {
      if (!drag.moved && Math.abs(event.clientY - drag.y) < 3) {
        return
      }
      if (!drag.moved) {
        glide.cancel()
        drag.moved = true
        dragging = true
      }
      // The lens holds still while dragging, so the rail under the pointer doesn't move.
      if (layout) {
        scroll.scrollTop = layout.toContent(localY(event) - drag.offset)
      }
      if (layout) {
        setHover(turnAt(layout.toContent(localY(event))), event)
      }
      return
    }
    if (layout && m) {
      const y = layout.toContent(localY(event))
      setHover(y >= 0 && y <= m.height ? turnAt(y) : -1, event)
    }
  }
  const onUp = () => {
    drag = null
    dragging = false
    schedulePaint()
  }
  const onLeave = () => {
    if (!drag) {
      setHover(-1, null)
    }
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('pointerleave', onLeave)

  draw()

  return () => {
    clearTimeout(redraw)
    cancelAnimationFrame(frame)
    glide.cancel()
    resize.disconnect()
    mutations.disconnect()
    theme.disconnect()
    scroll.removeEventListener('scroll', schedulePaint)
    host.remove()
    for (const child of hidden) {
      child.style.visibility = ''
    }
  }
}
