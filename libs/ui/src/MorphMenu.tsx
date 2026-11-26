import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import {
  MORPH_CLOSE,
  MORPH_CLOSE_MS,
  MORPH_FADE_EASE,
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
 * - Opening, the trigger's contents fade out as the background fades in on top of them (60ms
 *   and 70ms), the background unfolds from the trigger's box and corners to the menu's (see
 *   MORPH_OPEN), and the rows, revealed as the background grows over them, slide 8px into place
 *   one after another, nearest the trigger first (10ms apart, 180ms each). Elements marked
 *   `data-morph-pop` pop in last on a bouncier spring.
 * - Closing, the rows fade out (50ms), the background folds back into the trigger (see
 *   MORPH_CLOSE) and fades out over its second half, and the trigger's contents settle back in.
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

    if (open) {
      const animations = [
        ...morph(current?.shape ?? start, full, MORPH_OPEN),
        shell.animate([{ opacity: current?.opacity ?? 0 }, { opacity: 1 }], {
          duration: 70,
          easing: MORPH_FADE_EASE,
          fill: 'both',
        }),
        ...triggerParts.map((part) =>
          part.animate([{ opacity: current?.triggerOpacity ?? 1 }, { opacity: 0 }], {
            duration: 60,
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
                duration: 180,
                delay: 12 + fromTrigger * 10,
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
          animations.push(element.animate(pop, { duration: 280, delay: 90, fill: 'backwards' }))
        }
      } else {
        animations.push(
          content.animate([{ opacity: current?.contentOpacity ?? 0 }, { opacity: 1 }], {
            duration: 120,
            easing: MORPH_FADE_EASE,
            fill: 'both',
          })
        )
      }
      runningRef.current = animations
      return
    }

    runningRef.current = [
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
        duration: 50,
        easing: 'linear',
        fill: 'both',
      }),
      ...triggerParts.map((part) =>
        part.animate(
          [
            { opacity: 0, translate: `0 ${3 * away}px` },
            { opacity: 1, translate: '0 0' },
          ],
          { duration: 110, delay: 60, easing: MORPH_FADE_EASE, fill: 'backwards' }
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
    },
    []
  )

  return <div ref={shellRef} className={styles.background} aria-hidden="true" />
}
