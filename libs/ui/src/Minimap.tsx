import clsx from 'clsx'
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useBrowserLayoutEffect } from './layoutEffect.js'
import {
  layoutMinimapMap,
  stepMinimapFocus,
  type MinimapMap,
  type Rgba,
} from './minimapGeometry.js'
import { createMinimapReader, cssToRgba, type MinimapDocument } from './minimapMeasure.js'
import { paintMinimap, type MinimapPalette } from './minimapPaint.js'
import { sectionAt } from './readingLine.js'
import type { ScrollSpring } from './scrollGlide.js'
import styles from './Minimap.module.css'

export type MinimapSection = {
  readonly key: string
  /** Accessible name of the section's button, e.g. "Chapter 3: Sizing". */
  readonly accessibleLabel: string
  /** Marks a break before this section (drawn as a dashed line across the rail). */
  readonly dividerBefore?: boolean
}

export type MinimapProps = {
  readonly sections: readonly MinimapSection[]
  /** The section being read; it is drawn highlighted. */
  readonly current: number
  readonly ariaLabel: string
  /** The scroller, and the content column inside it whose children the rail draws. */
  readonly scrollRef: RefObject<HTMLElement | null>
  readonly contentRef: RefObject<HTMLElement | null>
  /** Matches the content's direct children that start each section (one per `sections` entry). */
  readonly sectionSelector: string
  /** Matches the element that opens a section (drawn as its marker). */
  readonly markerSelector: string
  /**
   * Asks the consumer to scroll so content px `top` is at the top of the view: `'glide'` for a
   * click on the rail, `'drag'` for every move while the window is dragged (set it directly).
   */
  readonly onSeek: (top: number, how: 'glide' | 'drag') => void
  /** A drag of the window ended; `fromTop` is where the view was when it started. */
  readonly onDragEnd?: (fromTop: number) => void
  /** Enter (or a click without a pointer) on a section's button. */
  readonly onNavigate: (index: number) => void
  /**
   * Which edge of the content the rail sits beside. On the right it keeps clear of the scroller's
   * scrollbar.
   */
  readonly side?: 'left' | 'right'
  /**
   * Called when the rail appears or hides (its box too narrow), and with `false` when it unmounts,
   * so the consumer can, say, hide a scrollbar the rail stands in for.
   */
  readonly onShownChange?: (shown: boolean) => void
  readonly className?: string
}

const RAIL_PAD = 24
const MAX_RAIL_WIDTH = 44
const MIN_GUTTER = 48
/** Room left for an overlay scrollbar beside a right-hand rail, when the scroller reserves none. */
const SCROLLBAR_CLEARANCE = 12
/** How far either side of the rail column the pointer still reaches it. */
const HIT_SLOP = 8
const DRAG_SLOP_PX = 3
/** How long a section's highlight takes to ease in or out, as a time constant in seconds. */
const EMPHASIS_TAU = 0.12

const PALETTE_TOKENS = {
  window: '--ui-interactive-hover',
  windowActive: '--ui-interactive-active',
  windowBorder: '--ui-border-default',
  windowBorderStrong: '--ui-border-strong',
  veil: '--ui-surface-canvas',
  focusRing: '--ui-focus-ring',
  divider: '--ui-text-muted',
  marker: '--ui-marker-solid',
} as const

const resolvePalette = (host: HTMLElement): MinimapPalette => {
  const probe = document.createElement('span')
  host.appendChild(probe)
  const read = (token: string): Rgba => {
    probe.style.color = `var(${token})`
    return cssToRgba(getComputedStyle(probe).color)
  }
  const palette = Object.fromEntries(
    Object.entries(PALETTE_TOKENS).map(([key, token]) => [key, read(token)])
  ) as MinimapPalette
  probe.remove()
  return palette
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

type Live = {
  sections: readonly MinimapSection[]
  current: number
  focused: number | null
  onSeek: MinimapProps['onSeek']
  onDragEnd: MinimapProps['onDragEnd']
  onShownChange: MinimapProps['onShownChange']
}

/**
 * A minimap of a long scrolling document, drawn on a canvas in the gutter beside it: every line
 * of text at its real position, length and colour, simplifying to paragraph bars and then one
 * slab per section as the document outgrows the rail. Around the reader a lens keeps full detail,
 * holding still for small scrolls and following larger ones on a spring. The window shows what's
 * on screen; drag it to scroll, or click anywhere to glide there. Hovering names the section under
 * the pointer.
 *
 * The consumer owns scrolling (`onSeek`) and decides which section is current. Keyboard and
 * assistive technology reach the sections through a list of buttons (one tab stop; arrows, Home,
 * End), with focus drawn as a ring on the rail.
 */
export const Minimap = ({
  sections,
  current,
  ariaLabel,
  scrollRef,
  contentRef,
  sectionSelector,
  markerSelector,
  onSeek,
  onDragEnd,
  onNavigate,
  side = 'left',
  onShownChange,
  className,
}: MinimapProps) => {
  const rootRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const repaintRef = useRef<() => void>(() => undefined)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const count = sections.length

  const live = useRef<Live>({
    sections,
    current,
    focused: null,
    onSeek,
    onDragEnd,
    onShownChange,
  })
  live.current = {
    sections,
    current,
    focused: focusIndex,
    onSeek,
    onDragEnd,
    onShownChange,
  }

  useBrowserLayoutEffect(() => {
    repaintRef.current()
  })

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const hit = hitRef.current
    const scroll = scrollRef.current
    const content = contentRef.current
    const ctx = canvas?.getContext('2d')
    if (!root || !canvas || !hit || !scroll || !content || !ctx) {
      return
    }

    let doc: MinimapDocument = { height: 1, tops: [], shapes: [] }
    let map: MinimapMap | null = null
    let palette = resolvePalette(root)
    let size = { width: 0, height: 0, x: 0, w: 0 }
    let focus: ScrollSpring = { position: scroll.scrollTop + scroll.clientHeight / 2, velocity: 0 }
    let emphasis = new Float32Array(0)
    let hovered = -1
    let dragging = false
    let pointerInside = false
    let attention = 0
    let frame = 0
    let lastTick = 0
    let readPending = true
    let shown: boolean | null = null
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    const currentMap = () =>
      layoutMinimapMap({
        height: doc.height,
        viewport: scroll.clientHeight,
        focus: focus.position,
        railTop: RAIL_PAD,
        railHeight: Math.max(1, size.height - RAIL_PAD * 2),
      })

    const readDocument = () => {
      readPending = false
      doc = reader.read()
      if (emphasis.length !== doc.tops.length) {
        const next = new Float32Array(doc.tops.length)
        next.set(emphasis.subarray(0, next.length))
        emphasis = next
      }
    }

    const paint = () => {
      map = currentMap()
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintMinimap({
        ctx,
        width: size.width,
        height: size.height,
        map,
        doc,
        x: size.x,
        w: size.w,
        emphasis,
        scrollTop: scroll.scrollTop,
        viewport: scroll.clientHeight,
        dragging,
        attention,
        focused: live.current.focused,
        dividers: new Set(
          live.current.sections.flatMap((section, i) => (section.dividerBefore ? [i] : []))
        ),
        palette,
        toRgba: cssToRgba,
      })
    }

    // One frame of motion: the lens follows the reader, highlights ease, then everything paints.
    const tick = (now: number) => {
      frame = 0
      if (readPending) {
        readDocument()
      }
      const seconds = lastTick ? Math.min(0.05, (now - lastTick) / 1000) : 1 / 60
      lastTick = now
      const centre = scroll.scrollTop + scroll.clientHeight / 2
      let moving = false
      if (reducedMotion.matches) {
        // Reduced motion: the lens jumps to where it would settle.
        focus = stepMinimapFocus(focus, centre, scroll.clientHeight, 1, dragging).focus
      } else {
        const step = stepMinimapFocus(focus, centre, scroll.clientHeight, seconds, dragging)
        focus = step.focus
        moving = !step.settled
      }
      const ease = reducedMotion.matches ? 1 : 1 - Math.exp(-seconds / EMPHASIS_TAU)
      const { current: reading, focused } = live.current
      for (let i = 0; i < emphasis.length; i += 1) {
        const goal = i === reading || i === hovered || i === focused ? 1 : 0
        const value = emphasis[i] ?? 0
        const next = Math.abs(goal - value) < 0.01 ? goal : value + (goal - value) * ease
        emphasis[i] = next
        moving ||= next !== goal
      }
      const engaged = pointerInside || dragging ? 1 : 0
      attention =
        Math.abs(engaged - attention) < 0.01 ? engaged : attention + (engaged - attention) * ease
      moving ||= attention !== engaged
      paint()
      if (moving) {
        frame = requestAnimationFrame(tick)
      } else {
        lastTick = 0
      }
    }
    const schedule = () => {
      frame ||= requestAnimationFrame(tick)
    }
    repaintRef.current = schedule

    const reader = createMinimapReader({
      scroll,
      content,
      sectionSelector,
      markerSelector,
      // A resize means layout is fresh: read and paint now, in step with the content (a
      // disclosure animating its height moves the rail on the same frame). DOM changes are read
      // on the next frame.
      onChange: (kind) => {
        readPending = true
        if (kind === 'layout' && size.width > 0) {
          readDocument()
          paint()
        }
        schedule()
      },
    })

    const resize = () => {
      const width = root.clientWidth
      const height = root.clientHeight
      const w = Math.min(MAX_RAIL_WIDTH, width - 20)
      let x = clamp((width - w) / 2, 8, 16)
      let hitRight = Math.min(width, x + w + HIT_SLOP)
      if (side === 'right') {
        // Keep clear of the scrollbar: the space the scroller reserves for it on each edge, or room
        // for an overlay scrollbar when it reserves none.
        const scrollbar = Math.max(
          SCROLLBAR_CLEARANCE,
          (scroll.offsetWidth - scroll.clientWidth) / 2
        )
        x = Math.max(4, width - w - Math.max(scrollbar + 4, clamp((width - w) / 2, 8, 16)))
        hitRight = Math.min(x + w + HIT_SLOP, width - scrollbar)
      }
      size = { width, height, w, x }
      // Only the rail's column takes the pointer, so whatever is beside it (the scrollbar) still works.
      const hitLeft = Math.max(0, x - HIT_SLOP)
      hit.style.left = `${hitLeft}px`
      hit.style.width = `${Math.max(0, hitRight - hitLeft)}px`
      const hidden = width < MIN_GUTTER || w < 24
      if (hidden !== root.hasAttribute('data-hidden') || shown === null) {
        root.toggleAttribute('data-hidden', hidden)
        shown = !hidden
        live.current.onShownChange?.(shown)
      }
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      readPending = true
      schedule()
    }
    const rootObserver = new ResizeObserver(resize)
    rootObserver.observe(root)
    resize()

    // A theme change repaints content and chrome in their new colours.
    const theme = new MutationObserver(() => {
      palette = resolvePalette(root)
      reader.invalidate()
      readPending = true
      schedule()
    })
    theme.observe(document.documentElement, { attributes: true })

    scroll.addEventListener('scroll', schedule, { passive: true })

    const localY = (event: PointerEvent) => event.clientY - root.getBoundingClientRect().top
    const sectionAtRail = (railY: number) => {
      if (!map) {
        return -1
      }
      const y = map.toContent(railY)
      return y < 0 || y > doc.height ? -1 : sectionAt(doc.tops, y)
    }
    // The section under the pointer is highlighted on the rail.
    const setHover = (index: number) => {
      if (index !== hovered) {
        hovered = index
        schedule()
      }
    }

    let drag: { offset: number; fromTop: number; y: number; moved: boolean } | null = null
    const onPointerDown = (event: PointerEvent) => {
      if (!map || event.button !== 0) {
        return
      }
      event.preventDefault()
      const railY = localY(event)
      const y = map.toContent(railY)
      setHover(sectionAtRail(railY))
      const { scrollTop, clientHeight } = scroll
      const windowTop = map.top(scrollTop)
      const windowBottom = map.top(scrollTop + clientHeight)
      let offset = railY - windowTop
      if (railY < windowTop - 8 || railY > windowBottom + 8) {
        live.current.onSeek(
          clamp(y - clientHeight / 2, 0, Math.max(0, scroll.scrollHeight - clientHeight)),
          'glide'
        )
        offset = (windowBottom - windowTop) / 2
      }
      drag = { offset, fromTop: scrollTop, y: event.clientY, moved: false }
      try {
        hit.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers can't be captured; the drag still follows moves over the rail.
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      const railY = localY(event)
      if (drag && map) {
        if (!drag.moved && Math.abs(event.clientY - drag.y) < DRAG_SLOP_PX) {
          return
        }
        if (!drag.moved) {
          drag.moved = true
          dragging = true
        }
        // The lens holds still while dragging, so the map under the pointer doesn't move.
        live.current.onSeek(Math.max(0, map.toContent(railY - drag.offset)), 'drag')
        setHover(sectionAtRail(railY))
        return
      }
      setHover(sectionAtRail(railY))
    }
    const onPointerUp = () => {
      if (drag?.moved) {
        live.current.onDragEnd?.(drag.fromTop)
      }
      drag = null
      dragging = false
      schedule()
    }
    const onPointerLeave = () => {
      pointerInside = false
      if (!drag) {
        setHover(-1)
      }
      schedule()
    }
    const onPointerEnter = () => {
      pointerInside = true
      schedule()
    }
    hit.addEventListener('pointerdown', onPointerDown)
    hit.addEventListener('pointermove', onPointerMove)
    hit.addEventListener('pointerup', onPointerUp)
    hit.addEventListener('pointercancel', onPointerUp)
    hit.addEventListener('pointerleave', onPointerLeave)
    hit.addEventListener('pointerenter', onPointerEnter)

    return () => {
      cancelAnimationFrame(frame)
      repaintRef.current = () => undefined
      if (shown) {
        live.current.onShownChange?.(false)
      }
      reader.dispose()
      rootObserver.disconnect()
      theme.disconnect()
      scroll.removeEventListener('scroll', schedule)
      hit.removeEventListener('pointerdown', onPointerDown)
      hit.removeEventListener('pointermove', onPointerMove)
      hit.removeEventListener('pointerup', onPointerUp)
      hit.removeEventListener('pointercancel', onPointerUp)
      hit.removeEventListener('pointerleave', onPointerLeave)
      hit.removeEventListener('pointerenter', onPointerEnter)
    }
  }, [scrollRef, contentRef, sectionSelector, markerSelector, side])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.metaKey || event.ctrlKey) {
      return
    }
    const next =
      event.key === 'ArrowUp'
        ? index - 1
        : event.key === 'ArrowDown'
          ? index + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : null
    if (next === null) {
      return
    }
    event.preventDefault()
    const target = clamp(next, 0, count - 1)
    setFocusIndex(target)
    buttonRefs.current[target]?.focus()
  }

  const rovingIndex = focusIndex ?? current

  return (
    <nav
      ref={rootRef}
      aria-label={ariaLabel}
      className={clsx(styles.root, className)}
      data-side={side}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div ref={hitRef} className={styles.hit} aria-hidden="true" />
      <ol className={styles.list}>
        {sections.map((section, index) => (
          <li key={section.key}>
            <button
              ref={(el) => {
                buttonRefs.current[index] = el
              }}
              type="button"
              tabIndex={index === rovingIndex ? 0 : -1}
              aria-label={section.accessibleLabel}
              aria-current={index === current ? 'location' : undefined}
              onFocus={(event) => {
                if (event.currentTarget.matches(':focus-visible')) {
                  setFocusIndex(index)
                }
              }}
              onBlur={(event) => {
                if (
                  !event.currentTarget.closest('ol')?.contains(event.relatedTarget as Node | null)
                ) {
                  setFocusIndex(null)
                }
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onNavigate(index)}
            />
          </li>
        ))}
      </ol>
    </nav>
  )
}
