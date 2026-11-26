import clsx from 'clsx'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useDelayedOpen } from './anchored.js'
import {
  chapterPositionY,
  layoutChapterRail,
  nearestChapter,
  revealChapterRow,
} from './chapterRailLayout.js'
import { IconReturnOutline14 } from './icons.js'
import { useBrowserLayoutEffect } from './layoutEffect.js'
import styles from './ChapterRail.module.css'

export type ChapterRailItem = {
  readonly key: string
  /** Short label shown on the chapter's row in the open card (truncated with an ellipsis). */
  readonly label: string
  /** Accessible name of the chapter's button, e.g. "Chapter 3: Sizing". */
  readonly accessibleLabel: string
  /** Label of a divider shown before this chapter in the open card (a wider gap at rest). */
  readonly dividerBefore?: string
  /** Marks a chapter that is still being written. */
  readonly live?: boolean
  /** Optional trailing control on the chapter's row, shown while the card is open. */
  readonly action?: ReactNode
}

/** A place the reader jumped away from, offered as a way back. */
export type ChapterRailReturn = {
  readonly index: number
  readonly label: string
  readonly onReturn: () => void
}

export type ChapterRailProps = {
  readonly items: readonly ChapterRailItem[]
  /** The chapter being read. */
  readonly current: number
  readonly ariaLabel: string
  /**
   * Called with `'jump'` for a click or Enter on a chapter, and with `'scrub'` for each new chapter
   * under the pointer while it drags along the rail (jump without animating).
   */
  readonly onNavigate: (index: number, how: 'jump' | 'scrub') => void
  /** Called when a drag along the rail ends, with where it ended and where it started. */
  readonly onScrubEnd?: (index: number, from: number) => void
  readonly returnTo?: ChapterRailReturn | null
  readonly className?: string
}

export type ChapterRailHandle = {
  /**
   * Shows how much of the content is on screen, in chapter units: `start` and `end` are reading
   * positions where `k + f` is a fraction `f` of the way through chapter `k`. Call it on every
   * scroll frame; it writes straight to the DOM without re-rendering.
   */
  readonly setViewport: (start: number, end: number) => void
}

const OPEN_DELAY_MS = 90
const CLOSE_DELAY_MS = 180
const WAKE_MS = 1400
const SCRUB_SLOP_PX = 4
const RIPPLE_CAP = 8
const TICK_HEIGHT = 12
const REST_PADDING = 12
const RETURN_GAP = 12

const clampIndex = (index: number, count: number) => Math.min(Math.max(index, 0), count - 1)

/**
 * A vertical rail of chapter ticks for a long scrolling document. At rest it is a column of short
 * ticks with the current chapter's tick longest and a thin bar marking what is on screen. On hover
 * or keyboard focus the ticks spring apart into the rows of a card that names every chapter;
 * dragging along it scrubs through chapters. The consumer positions the rail's box (usually a
 * page gutter) and owns scrolling: the rail reports navigation and receives the viewport.
 */
export const ChapterRail = forwardRef<ChapterRailHandle, ChapterRailProps>(function ChapterRail(
  { items, current, ariaLabel, onNavigate, onScrubEnd, returnTo = null, className },
  ref
) {
  const rootRef = useRef<HTMLElement>(null)
  const bracketRef = useRef<HTMLDivElement>(null)
  const tickRefs = useRef<(HTMLButtonElement | null)[]>([])
  const viewportRef = useRef<readonly [number, number] | null>(null)
  const wakeTimer = useRef(0)
  const scrubRef = useRef<{
    pointerId: number
    y: number
    from: number
    index: number
    moved: boolean
  } | null>(null)
  const [height, setHeight] = useState(0)
  const [focusOpen, setFocusOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [offset, setOffset] = useState(0)
  const hover = useDelayedOpen()
  const count = items.length
  const open = count > 0 && (hover.open || focusOpen || scrubbing)

  const dividerKey = items.map((item) => (item.dividerBefore ? '1' : '0')).join('')
  const dividers = useMemo(
    () => new Set([...dividerKey].flatMap((flag, index) => (flag === '1' ? [index] : []))),
    [dividerKey]
  )
  const layout = useMemo(
    () => layoutChapterRail(count, dividers, height),
    [count, dividers, height]
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const openRef = useRef(open)
  openRef.current = open
  const scrollable = layout.card.contentHeight > layout.card.height
  const scrollOffset = open && scrollable ? offset : 0
  const offsetRef = useRef(scrollOffset)
  offsetRef.current = scrollOffset

  // Keep the current (or keyboard-focused) chapter's row inside a card that scrolls.
  const revealIndex = focusIndex ?? current
  useBrowserLayoutEffect(() => {
    if (open && scrollable) {
      setOffset((value) => revealChapterRow(layout, revealIndex, value))
    }
  }, [open, scrollable, layout, revealIndex])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !open || !scrollable) {
      return
    }
    const maxOffset = layout.card.contentHeight - layout.card.height
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setOffset((value) => Math.min(maxOffset, Math.max(0, value + event.deltaY)))
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [open, scrollable, layout])

  useBrowserLayoutEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    setHeight(root.clientHeight)
    const observer = new ResizeObserver(() => setHeight(root.clientHeight))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => window.clearTimeout(wakeTimer.current), [])

  const paintViewport = useCallback(() => {
    const range = viewportRef.current
    if (!range) {
      return
    }
    const [start, end] = range
    const { ticks } = layoutRef.current
    const bracket = bracketRef.current
    if (bracket) {
      const top = chapterPositionY(ticks, start)
      const bottom = chapterPositionY(ticks, end)
      bracket.style.transform = `translateY(${top}px) scaleY(${Math.max(2, bottom - top) / 100})`
    }
    tickRefs.current.forEach((tick, index) => {
      tick?.toggleAttribute('data-in-view', index + 1 > start && index < end)
    })
  }, [])

  useBrowserLayoutEffect(paintViewport, [layout, count, paintViewport])

  useImperativeHandle(
    ref,
    () => ({
      setViewport: (start, end) => {
        viewportRef.current = [start, end]
        paintViewport()
        const root = rootRef.current
        if (!root) {
          return
        }
        root.setAttribute('data-awake', '')
        window.clearTimeout(wakeTimer.current)
        wakeTimer.current = window.setTimeout(() => root.removeAttribute('data-awake'), WAKE_MS)
      },
    }),
    [paintViewport]
  )

  const indexAt = (clientY: number) => {
    const root = rootRef.current
    if (!root) {
      return -1
    }
    const rect = root.getBoundingClientRect()
    const scale = root.offsetHeight > 0 ? rect.height / root.offsetHeight : 1
    const y = (clientY - rect.top) / (scale || 1)
    return openRef.current
      ? nearestChapter(layoutRef.current.rows, y + offsetRef.current)
      : nearestChapter(layoutRef.current.ticks, y)
  }

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const target = event.target as Element
    if (event.button !== 0 || target.closest('[data-chapter-rail-action]')) {
      return
    }
    const index = indexAt(event.clientY)
    if (index < 0) {
      return
    }
    event.preventDefault()
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // Capture is a nicety for drags that leave the rail; a pointer the browser no longer tracks
      // (or a synthetic one) still scrubs while it stays over the rail.
    }
    scrubRef.current = {
      pointerId: event.pointerId,
      y: event.clientY,
      from: current,
      index,
      moved: false,
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const scrub = scrubRef.current
    if (!scrub || scrub.pointerId !== event.pointerId) {
      return
    }
    if (!scrub.moved) {
      if (Math.abs(event.clientY - scrub.y) < SCRUB_SLOP_PX) {
        return
      }
      scrub.moved = true
      scrub.index = -1
      setScrubbing(true)
    }
    const index = indexAt(event.clientY)
    if (index >= 0 && index !== scrub.index) {
      scrub.index = index
      onNavigate(index, 'scrub')
    }
  }

  const endScrub = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const scrub = scrubRef.current
    if (!scrub || scrub.pointerId !== event.pointerId) {
      return
    }
    scrubRef.current = null
    setScrubbing(false)
    if (!scrub.moved) {
      if (!cancelled) {
        onNavigate(scrub.index, 'jump')
      }
    } else if (scrub.index >= 0) {
      onScrubEnd?.(scrub.index, scrub.from)
    }
    if (cancelled || !rootRef.current?.matches(':hover')) {
      hover.schedule(false, CLOSE_DELAY_MS)
    }
  }

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).matches(':focus-visible')) {
      setFocusOpen(true)
    }
  }

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusOpen(false)
      setFocusIndex(null)
    }
  }

  const onTickKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.metaKey || event.ctrlKey) {
      return
    }
    if (event.key === 'Escape') {
      setFocusOpen(false)
      hover.schedule(false, 0)
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
    const target = clampIndex(next, count)
    setFocusIndex(target)
    setFocusOpen(true)
    tickRefs.current[target]?.focus()
  }

  const lastReturnLabel = useRef('')
  if (returnTo) {
    lastReturnLabel.current = returnTo.label
  }

  const firstTick = layout.ticks[0] ?? 0
  const lastTick = layout.ticks.at(-1) ?? 0
  const restTop = firstTick - REST_PADDING
  const restBottom = lastTick + REST_PADDING
  const centres = open ? layout.rows : layout.ticks
  const rovingIndex = focusIndex ?? current

  return (
    <nav
      ref={rootRef}
      aria-label={ariaLabel}
      className={clsx(styles.rail, open && styles.open, scrubbing && styles.scrubbing, className)}
      onPointerEnter={() => hover.schedule(true, OPEN_DELAY_MS)}
      onPointerLeave={() => {
        if (!scrubRef.current) {
          hover.schedule(false, CLOSE_DELAY_MS)
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endScrub(event, false)}
      onPointerCancel={(event) => endScrub(event, true)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div
        className={styles.hit}
        style={{ top: restTop - REST_PADDING, height: restBottom - restTop + REST_PADDING * 2 }}
        aria-hidden="true"
      />
      <div
        className={styles.plate}
        style={
          open
            ? { top: layout.card.top, height: layout.card.height }
            : { top: restTop, height: Math.max(0, restBottom - restTop) }
        }
        aria-hidden="true"
      />
      <div ref={bracketRef} className={styles.bracket} aria-hidden="true" />
      <div
        className={styles.clip}
        style={
          open && scrollable
            ? {
                clipPath: `inset(${layout.card.top}px -100vw ${Math.max(0, height - layout.card.top - layout.card.height)}px -100vw)`,
              }
            : undefined
        }
      >
        <div
          className={styles.scroller}
          style={scrollOffset ? { transform: `translateY(${-scrollOffset}px)` } : undefined}
        >
          {[...layout.dividers].map(([index, top]) => (
            <div
              key={`divider-${index}`}
              className={styles.divider}
              style={{ top }}
              aria-hidden="true"
            >
              <span className={styles.dividerLabel}>{items[index]?.dividerBefore}</span>
            </div>
          ))}
          <ol className={styles.list}>
            {items.map((item, index) => {
              const isCurrent = index === current
              const itemHeight = open ? layout.rowHeight : TICK_HEIGHT
              const style = {
                top: (centres[index] ?? 0) - itemHeight / 2,
                height: itemHeight,
                '--chapter-rank': open ? Math.min(Math.abs(index - current), RIPPLE_CAP) : 0,
              } as CSSProperties
              return (
                <li
                  key={item.key}
                  className={clsx(
                    styles.item,
                    isCurrent && styles.current,
                    item.live && styles.live,
                    item.action !== undefined && item.action !== null && styles.withAction,
                    returnTo?.index === index && styles.origin
                  )}
                  style={style}
                >
                  <button
                    ref={(el) => {
                      tickRefs.current[index] = el
                    }}
                    type="button"
                    className={styles.tick}
                    tabIndex={index === rovingIndex ? 0 : -1}
                    aria-label={item.accessibleLabel}
                    aria-current={isCurrent ? 'location' : undefined}
                    onClick={(event) => {
                      if (event.detail === 0) {
                        onNavigate(index, 'jump')
                      }
                    }}
                    onKeyDown={(event) => onTickKeyDown(event, index)}
                  >
                    <span className={styles.mark} aria-hidden="true" />
                    <span className={styles.number} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className={styles.label} aria-hidden="true">
                      {item.label}
                    </span>
                  </button>
                  {item.action !== undefined && item.action !== null ? (
                    <span className={styles.action} data-chapter-rail-action="">
                      {item.action}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      </div>
      <button
        type="button"
        className={clsx(styles.returnButton, returnTo && styles.returnShown)}
        style={{ top: (open ? layout.card.top + layout.card.height : restBottom) + RETURN_GAP }}
        tabIndex={returnTo ? 0 : -1}
        aria-hidden={returnTo ? undefined : true}
        data-chapter-rail-action=""
        onClick={() => returnTo?.onReturn()}
      >
        <IconReturnOutline14 />
        <span>{returnTo?.label ?? lastReturnLabel.current}</span>
      </button>
    </nav>
  )
})
