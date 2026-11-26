import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import {
  MORPH_CLOSE,
  MORPH_CLOSE_MS,
  MORPH_FADE_EASE,
  MORPH_ICON_CLOSE_EASE,
  MORPH_ICON_SPRING,
  MORPH_OPEN,
  MORPH_POP,
  contentClip,
  menuShape,
  sampleMorph,
  triggerShape,
  type MorphAlign,
  type MorphMotion,
  type MorphShape,
  type MorphSide,
} from './morph.js'
import { Popover, type PopoverProps } from './Popover.js'
import styles from './MorphMenu.module.css'

export type MorphMenuProps = Omit<
  PopoverProps,
  'side' | 'align' | 'alignOffset' | 'offset' | 'exitDurationMs' | 'maxHeight' | 'children'
> & {
  /** The menu extends above (`top`, default) or below (`bottom`) its trigger. */
  side?: MorphSide
  /** The menu's left edge (`start`, default) or right edge (`end`) lines up with the trigger's. */
  align?: MorphAlign
  /** The element holding the menu's rows; arrow-key helpers can read it. */
  contentRef?: RefObject<HTMLDivElement>
  contentClassName?: string
  children: ReactNode
}

/**
 * A menu that grows out of the button that opens it. The menu opens over its trigger, sharing
 * one corner with it (see `side` and `align`), and its background morphs between the two:
 *
 * - Opening, the trigger's contents fade out as the background fades in on top of them (45ms
 *   and 50ms), the background unfolds from the trigger's box and corners to the menu's (see
 *   MORPH_OPEN), and the rows, revealed as the background grows over them, slide 8px into place
 *   one after another, nearest the trigger first (8ms apart, 140ms each). Elements marked
 *   `data-morph-pop` pop in last on a bouncier spring.
 * - Closing, the rows fade out (40ms), the background folds back into the trigger (see
 *   MORPH_CLOSE) and fades out over its second half, and the trigger's contents settle back in.
 *
 * - Shared icons: a trigger element marked `data-morph-from="<key>"` and a menu element marked
 *   `data-morph-to="<key>"` are the same icon in two places. Opening, a copy of the trigger's
 *   icon flies to the menu's on the open spring (180ms) while the real one stays hidden until it
 *   lands; closing, the menu's icon flies back into the trigger (120ms). Size and colour travel
 *   with it. Unmatched icons fade with their row or trigger as above.
 *
 * Either run starts from wherever the previous one was, so reopening mid-close does not jump.
 * The trigger should not scale on press: the menu is placed from the trigger's measured box.
 * Size the menu with `className` (width, padding); its background, shadow and corner radius
 * come from this component.
 */
export const MorphMenu = ({
  side = 'top',
  align = 'start',
  contentRef,
  contentClassName,
  className,
  children,
  ...popover
}: MorphMenuProps) => {
  const ownContentRef = useRef<HTMLDivElement>(null)
  const content = contentRef ?? ownContentRef

  return (
    <Popover
      {...popover}
      side={side}
      align={align}
      // Negative offset: the menu's edge lands on the trigger's far edge, so it opens over it.
      offset={-(popover.anchorRef.current?.offsetHeight ?? 0)}
      exitDurationMs={MORPH_CLOSE_MS}
      className={clsx(styles.surface, className)}
    >
      <div ref={content} className={contentClassName}>
        {children}
      </div>
      {/* After the content, so the content's ref is attached when the morph's effect runs. */}
      <MorphBackground
        open={popover.open}
        side={side}
        align={align}
        triggerRef={popover.anchorRef}
        contentRef={content}
      />
    </Popover>
  )
}

type IconPair = { from: Element; to: Element }

/** Each trigger icon marked `data-morph-from` with the menu icon marked with the same key. */
const pairIcons = (trigger: HTMLElement, content: HTMLElement): IconPair[] =>
  Array.from(trigger.querySelectorAll<HTMLElement>('[data-morph-from]')).flatMap((source) => {
    const key = source.dataset.morphFrom ?? ''
    const target = content.querySelector(`[data-morph-to="${CSS.escape(key)}"]`)
    // Fly the glyphs themselves, so chip and row padding do not shift the landing point.
    const from = source.querySelector('svg') ?? source
    const to = target?.querySelector('svg') ?? target
    return to ? [{ from, to }] : []
  })

/** The open spring as keyframes for a move from `dx, dy` and `scale` to rest. */
const springFrames = (dx: number, dy: number, scale: number): Keyframe[] =>
  Array.from({ length: 21 }, (_, index) => {
    const amount = MORPH_ICON_SPRING(index / 20)
    return {
      translate: `${dx * (1 - amount)}px ${dy * (1 - amount)}px`,
      scale: `${scale + (1 - scale) * amount}`,
    }
  })

/**
 * Flies a copy of each shared icon between the trigger and the menu, above both: the menu's
 * content is clipped to its growing background, which would cut a real icon off mid-flight, and
 * the menu is removed as it closes, so the copy is placed on the page in screen coordinates.
 * The real icon at the destination stays hidden until the copy lands on it.
 */
const flyIcons = ({
  surface,
  trigger,
  side,
  align,
  pairs,
  direction,
}: {
  surface: HTMLElement
  trigger: HTMLElement
  side: MorphSide
  align: MorphAlign
  pairs: IconPair[]
  direction: 'open' | 'close'
}): { animations: Animation[]; flyers: HTMLElement[] } => {
  // On opening this runs before the Popover has placed the menu, so the menu's icons are
  // measured against wherever the menu sits now and shifted to where it will be placed: the
  // corner it shares with the trigger (as the morph assumes). The trigger's icons are already
  // where they are.
  const measured = surface.getBoundingClientRect()
  const anchor = trigger.getBoundingClientRect()
  const placed = {
    left: align === 'end' ? anchor.right - surface.offsetWidth : anchor.left,
    top: side === 'top' ? anchor.bottom - surface.offsetHeight : anchor.top,
  }
  const inMenu = (rect: DOMRect) => ({
    left: rect.left - measured.left + placed.left,
    top: rect.top - measured.top + placed.top,
    width: rect.width,
    height: rect.height,
  })
  const onScreen = (rect: DOMRect) => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  })
  const animations: Animation[] = []
  const flyers: HTMLElement[] = []
  const duration = direction === 'open' ? MORPH_OPEN.yMs : MORPH_CLOSE.xMs
  for (const pair of pairs) {
    const [source, target] = direction === 'open' ? [pair.from, pair.to] : [pair.to, pair.from]
    // Both ends in screen coordinates. The copy lives on the page, not in the menu, which is
    // torn down as it closes.
    const from =
      direction === 'open'
        ? onScreen(source.getBoundingClientRect())
        : inMenu(source.getBoundingClientRect())
    const to =
      direction === 'open'
        ? inMenu(target.getBoundingClientRect())
        : onScreen(target.getBoundingClientRect())
    if (from.width === 0 || to.width === 0) {
      continue
    }
    const flyer = document.createElement('div')
    flyer.className = styles.flyer
    flyer.setAttribute('aria-hidden', 'true')
    flyer.append(target.cloneNode(true))
    Object.assign(flyer.style, {
      left: `${to.left}px`,
      top: `${to.top}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
    })
    document.body.append(flyer)
    flyers.push(flyer)
    // Lands on the destination glyph: drawn at its size and place, started from the source's.
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    const scale = from.width / to.width
    const move =
      direction === 'open'
        ? flyer.animate(springFrames(dx, dy, scale), { duration, fill: 'both' })
        : flyer.animate(
            [
              { translate: `${dx}px ${dy}px`, scale: `${scale}` },
              { translate: '0 0', scale: '1' },
            ],
            { duration, easing: MORPH_ICON_CLOSE_EASE, fill: 'both' }
          )
    const tint = flyer.animate(
      [{ color: getComputedStyle(source).color }, { color: getComputedStyle(target).color }],
      { duration, easing: MORPH_FADE_EASE, fill: 'both' }
    )
    // The real icon appears the moment the copy lands on it.
    const hold = target.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: 'backwards' })
    move.onfinish = () => flyer.remove()
    animations.push(move, tint, hold)
  }
  return { animations, flyers }
}

const MorphBackground = ({
  open,
  side,
  align,
  triggerRef,
  contentRef,
}: {
  open: boolean
  side: MorphSide
  align: MorphAlign
  triggerRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
}) => {
  const shellRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef<Animation[]>([])
  const flyersRef = useRef<HTMLElement[]>([])

  useLayoutEffect(() => {
    const shell = shellRef.current
    const content = contentRef.current
    const trigger = triggerRef.current
    const surface = shell?.parentElement
    if (!shell || !content || !trigger || !surface || typeof shell.animate !== 'function') {
      return
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const midFlight = runningRef.current.some((animation) => animation.playState === 'running')
    const shellStyle = getComputedStyle(shell)
    const current = midFlight
      ? {
          shape: {
            top: Number.parseFloat(shellStyle.top),
            right: Number.parseFloat(shellStyle.right),
            bottom: Number.parseFloat(shellStyle.bottom),
            left: Number.parseFloat(shellStyle.left),
            radius: Number.parseFloat(shellStyle.borderRadius),
          },
          opacity: shellStyle.opacity,
          contentOpacity: getComputedStyle(content).opacity,
          triggerOpacity: getComputedStyle(trigger.firstElementChild ?? trigger).opacity,
        }
      : null
    for (const animation of runningRef.current) {
      animation.cancel()
    }
    for (const flyer of flyersRef.current) {
      flyer.remove()
    }
    flyersRef.current = []

    const full = menuShape(Number.parseFloat(getComputedStyle(shell).borderRadius))
    const start = triggerShape(
      { width: surface.offsetWidth, height: surface.offsetHeight },
      {
        width: trigger.offsetWidth,
        height: trigger.offsetHeight,
        radius: Number.parseFloat(getComputedStyle(trigger).borderTopLeftRadius) || 0,
      },
      side,
      align
    )
    const contentBox = {
      top: content.offsetTop,
      left: content.offsetLeft,
      width: content.offsetWidth,
      height: content.offsetHeight,
    }
    const paddingBox = { width: surface.clientWidth, height: surface.clientHeight }
    const shellFrame = (shape: MorphShape): Keyframe => ({
      top: `${shape.top}px`,
      right: `${shape.right}px`,
      bottom: `${shape.bottom}px`,
      left: `${shape.left}px`,
      borderRadius: `${shape.radius}px`,
    })
    const clipFrame = (shape: MorphShape): Keyframe => ({
      clipPath: contentClip(shape, contentBox, paddingBox),
    })
    const morph = (from: MorphShape, to: MorphShape, motion: MorphMotion) => {
      const { total, shapes } = reduce
        ? { total: 1, shapes: [to, to] }
        : sampleMorph(from, to, motion)
      return [
        shell.animate(shapes.map(shellFrame), { duration: total, fill: 'both' }),
        content.animate(shapes.map(clipFrame), { duration: total, fill: 'both' }),
      ]
    }
    const triggerParts = Array.from(trigger.children)
    // Rows slide in from the trigger's side (up when the menu is above it, down when below), and
    // the trigger's contents settle back the same way. These animate the individual `translate`
    // and `scale` properties, so they combine with any transform the elements already have.
    const away = side === 'top' ? 1 : -1

    // Shared icons fly only on a fresh open or close, not when a run reverses mid-flight.
    const flights =
      current === null && !reduce
        ? flyIcons({
            surface,
            trigger,
            side,
            align,
            pairs: pairIcons(trigger, content),
            direction: open ? 'open' : 'close',
          })
        : { animations: [], flyers: [] }
    flyersRef.current = flights.flyers

    if (open) {
      const animations = [
        ...flights.animations,
        ...morph(current?.shape ?? start, full, MORPH_OPEN),
        shell.animate([{ opacity: current?.opacity ?? 0 }, { opacity: 1 }], {
          duration: 50,
          easing: MORPH_FADE_EASE,
          fill: 'both',
        }),
        ...triggerParts.map((part) =>
          part.animate([{ opacity: current?.triggerOpacity ?? 1 }, { opacity: 0 }], {
            duration: 45,
            easing: 'linear',
            fill: 'forwards',
          })
        ),
      ]
      if (current === null && !reduce) {
        const rows = Array.from(content.children)
        rows.forEach((row, index) => {
          const fromTrigger = side === 'top' ? rows.length - 1 - index : index
          animations.push(
            row.animate(
              [
                { opacity: 0, translate: `0 ${8 * away}px` },
                { opacity: 1, translate: '0 0' },
              ],
              {
                duration: 140,
                delay: 8 + fromTrigger * 8,
                easing: MORPH_FADE_EASE,
                fill: 'backwards',
              }
            )
          )
        })
        const pop = Array.from({ length: 21 }, (_, index) => {
          const amount = MORPH_POP(index / 20)
          return { opacity: Math.min(1, amount * 1.6), scale: `${0.4 + 0.6 * amount}` }
        })
        for (const element of content.querySelectorAll('[data-morph-pop]')) {
          animations.push(element.animate(pop, { duration: 220, delay: 65, fill: 'backwards' }))
        }
      } else {
        animations.push(
          content.animate([{ opacity: current?.contentOpacity ?? 0 }, { opacity: 1 }], {
            duration: 90,
            easing: MORPH_FADE_EASE,
            fill: 'both',
          })
        )
      }
      runningRef.current = animations
      return
    }

    runningRef.current = [
      ...flights.animations,
      ...morph(current?.shape ?? full, start, MORPH_CLOSE),
      shell.animate(
        [
          { opacity: current?.opacity ?? 1 },
          { opacity: current?.opacity ?? 1, offset: 0.5 },
          { opacity: 0 },
        ],
        { duration: MORPH_CLOSE.xMs, easing: 'linear', fill: 'both' }
      ),
      content.animate([{ opacity: current?.contentOpacity ?? 1 }, { opacity: 0 }], {
        duration: 40,
        easing: 'linear',
        fill: 'both',
      }),
      ...triggerParts.map((part) =>
        part.animate(
          [
            { opacity: 0, translate: `0 ${3 * away}px` },
            { opacity: 1, translate: '0 0' },
          ],
          { duration: 90, delay: 45, easing: MORPH_FADE_EASE, fill: 'backwards' }
        )
      ),
    ]
  }, [open, side, align, contentRef, triggerRef])

  // The trigger's contents are held hidden while the menu is open; never leave them hidden.
  useEffect(
    () => () => {
      for (const animation of runningRef.current) {
        if (animation.effect?.getTiming().fill === 'forwards') {
          animation.cancel()
        }
      }
      for (const flyer of flyersRef.current) {
        flyer.remove()
      }
    },
    []
  )

  return <div ref={shellRef} className={styles.background} aria-hidden="true" />
}
