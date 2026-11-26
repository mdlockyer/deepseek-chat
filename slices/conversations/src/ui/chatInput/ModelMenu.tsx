import { IconCheckOutline16, Popover, Switch } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../messages.js'
import { handleMenuRowKey, type ComposerToolSwitch } from './ComposerMenu.js'
import styles from './ModelMenu.module.css'

/** How long the menu stays mounted while it shrinks back into the pill. */
const CLOSE_MS = 240
const FADE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Unit step response of a damped spring, shaped to settle (within 0.3%) at t = 1. */
const spring = (zeta: number) => {
  const w = 5.8 / zeta
  const wd = w * Math.sqrt(1 - zeta * zeta)
  return (t: number) =>
    t >= 1
      ? 1
      : 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t))
}
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount

/**
 * Open: the menu spreads sideways on a firm spring (about 0.6% overshoot, 230ms) slightly ahead
 * of rising on a livelier one (about 2.8%, 340ms), so it unfolds out of the pill rather than
 * scaling. Both are about 90% of the way there by 120ms. Close: height folds first (180ms), then
 * width (220ms), both easing out, so it narrows back into the pill.
 */
const OPEN = { yMs: 340, y: spring(0.75), xMs: 230, x: spring(0.85) }
const CLOSE = { yMs: 180, y: easeOutCubic, xMs: 220, x: easeOutCubic }
const CHECK_POP = spring(0.6)

type Shape = { top: number; left: number; radius: number }
type Motion = typeof OPEN | typeof CLOSE

/** Samples the two axes every ~12ms into linear keyframes, so one clip can follow both. */
const sampleShapes = (from: Shape, to: Shape, motion: Motion) => {
  const total = Math.max(motion.yMs, motion.xMs)
  const steps = Math.max(2, Math.round(total / 12))
  return {
    total,
    shapes: Array.from({ length: steps + 1 }, (_, index): Shape => {
      const time = (index / steps) * total
      const y = motion.y(Math.min(1, time / motion.yMs))
      const x = motion.x(Math.min(1, time / motion.xMs))
      return {
        top: lerp(from.top, to.top, y),
        left: lerp(from.left, to.left, x),
        radius: Math.max(0, lerp(from.radius, to.radius, y)),
      }
    }),
  }
}

/**
 * The menu's background, which grows out of the pill. The menu opens over the pill with their
 * bottom-right corners together, so the pill's box inside the menu is fixed by the two sizes.
 *
 * Opening, the pill's label fades out as the background fades in on top of it (100ms), the
 * background unfolds to the menu (see OPEN), and the rows, revealed as it grows over them, rise
 * 8px into place one after another from the bottom up, nearest the pill first (14ms apart). The
 * model's check mark pops in last on a bouncier spring. Closing, the rows fade out (70ms), the
 * background folds back into the pill (see CLOSE) and fades out over its second half, and the
 * pill's label settles back in from 3px below. Either run starts from wherever the previous one
 * was, so reopening mid-close does not jump.
 */
const MenuMorph = ({
  open,
  pillRef,
  listRef,
}: {
  open: boolean
  pillRef: RefObject<HTMLElement | null>
  listRef: RefObject<HTMLElement | null>
}) => {
  const shellRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef<Animation[]>([])

  useLayoutEffect(() => {
    const shell = shellRef.current
    const list = listRef.current
    const pill = pillRef.current
    const surface = shell?.parentElement
    if (!shell || !list || !pill || !surface || typeof shell.animate !== 'function') {
      return
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const midFlight = runningRef.current.some((animation) => animation.playState === 'running')
    const shellStyle = getComputedStyle(shell)
    const current = midFlight
      ? {
          shape: {
            top: Number.parseFloat(shellStyle.top),
            left: Number.parseFloat(shellStyle.left),
            radius: Number.parseFloat(shellStyle.borderRadius),
          },
          opacity: shellStyle.opacity,
          listOpacity: getComputedStyle(list).opacity,
          pillOpacity: getComputedStyle(pill.firstElementChild ?? pill).opacity,
        }
      : null
    for (const animation of runningRef.current) {
      animation.cancel()
    }

    // The shell sits on the menu's border box (inset -1px), so its own top/left are -1px.
    const edge = -1
    const pillShape: Shape = {
      top: edge + Math.max(0, surface.offsetHeight - pill.offsetHeight),
      left: edge + Math.max(0, surface.offsetWidth - pill.offsetWidth),
      radius: pill.offsetHeight / 2,
    }
    const menuShape: Shape = {
      top: edge,
      left: edge,
      radius: Number.parseFloat(getComputedStyle(shell).borderRadius),
    }
    // The list sits inside the shell by the border and padding; its clip follows the shell.
    const inset = list.offsetTop - edge
    const shellFrame = (shape: Shape): Keyframe => ({
      top: `${shape.top}px`,
      left: `${shape.left}px`,
      borderRadius: `${shape.radius}px`,
    })
    const clipFrame = (shape: Shape): Keyframe => ({
      clipPath: `inset(${Math.max(0, shape.top - edge - list.offsetTop)}px 0px 0px ${Math.max(
        0,
        shape.left - edge - list.offsetLeft
      )}px round ${Math.max(0, shape.radius - inset)}px)`,
    })
    const pillParts = Array.from(pill.children)
    const rows = Array.from(list.children)
    const morph = (from: Shape, to: Shape, motion: Motion) => {
      const { total, shapes } = reduce
        ? { total: 1, shapes: [to, to] }
        : sampleShapes(from, to, motion)
      return [
        shell.animate(shapes.map(shellFrame), { duration: total, fill: 'both' }),
        list.animate(shapes.map(clipFrame), { duration: total, fill: 'both' }),
      ]
    }

    if (open) {
      const fresh = current === null
      const animations = [
        ...morph(current?.shape ?? pillShape, menuShape, OPEN),
        shell.animate([{ opacity: current?.opacity ?? 0 }, { opacity: 1 }], {
          duration: 100,
          easing: FADE_EASE,
          fill: 'both',
        }),
        ...pillParts.map((part) =>
          part.animate([{ opacity: current?.pillOpacity ?? 1 }, { opacity: 0 }], {
            duration: 90,
            easing: 'linear',
            fill: 'forwards',
          })
        ),
      ]
      if (fresh && !reduce) {
        rows.forEach((row, index) => {
          animations.push(
            row.animate(
              [
                { opacity: 0, transform: 'translateY(8px)' },
                { opacity: 1, transform: 'none' },
              ],
              {
                duration: 240,
                delay: 24 + (rows.length - 1 - index) * 14,
                easing: FADE_EASE,
                fill: 'backwards',
              }
            )
          )
        })
        const check = list.querySelector('[data-model-check]')
        if (check) {
          const pop = Array.from({ length: 21 }, (_, index) => {
            const amount = CHECK_POP(index / 20)
            return { opacity: Math.min(1, amount * 1.6), transform: `scale(${0.4 + 0.6 * amount})` }
          })
          animations.push(check.animate(pop, { duration: 360, delay: 130, fill: 'backwards' }))
        }
      } else {
        animations.push(
          list.animate([{ opacity: current?.listOpacity ?? 0 }, { opacity: 1 }], {
            duration: 120,
            easing: FADE_EASE,
            fill: 'both',
          })
        )
      }
      runningRef.current = animations
      return
    }

    runningRef.current = [
      ...morph(current?.shape ?? menuShape, pillShape, CLOSE),
      shell.animate(
        [
          { opacity: current?.opacity ?? 1 },
          { opacity: current?.opacity ?? 1, offset: 0.5 },
          { opacity: 0 },
        ],
        { duration: CLOSE.xMs, easing: 'linear', fill: 'both' }
      ),
      list.animate([{ opacity: current?.listOpacity ?? 1 }, { opacity: 0 }], {
        duration: 70,
        easing: 'linear',
        fill: 'both',
      }),
      ...pillParts.map((part) =>
        part.animate(
          [
            { opacity: 0, transform: 'translateY(3px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 140, delay: 90, easing: FADE_EASE, fill: 'backwards' }
        )
      ),
    ]
  }, [open, listRef, pillRef])

  // The pill's label is held hidden while the menu is open; never leave it hidden on unmount.
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

  return <div ref={shellRef} className={styles.shell} aria-hidden="true" />
}

/**
 * Pill under the composer's right edge: the model name plus one icon per switch that is on
 * (DeepThink and the mounted tools). It grows into a menu with the model and every switch.
 */
export const ModelMenu = ({
  modelLabel,
  tools,
  disabled = false,
}: {
  modelLabel: string
  tools: ComposerToolSwitch[]
  disabled?: boolean
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const active = tools.filter((tool) => tool.checked)
  // Icons already shown (or present on first render) appear without the pop-in animation.
  const seenIconsRef = useRef<Set<string> | null>(null)
  if (seenIconsRef.current === null) {
    seenIconsRef.current = new Set(active.map((tool) => tool.key))
  }
  const seenIcons = seenIconsRef.current
  useEffect(() => {
    seenIcons.clear()
    for (const tool of active) {
      seenIcons.add(tool.key)
    }
  })
  const summary =
    active.length > 0
      ? t('modelMenuSummary', {
          model: modelLabel,
          tools: active.map((tool) => tool.label).join(', '),
        })
      : modelLabel

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.pill, open && styles.pillOpen)}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.model}>{modelLabel}</span>
        {active.length > 0 ? (
          <span className={styles.icons} aria-hidden="true">
            {active.map((tool) => (
              <span
                key={tool.key}
                className={clsx(styles.icon, !seenIcons.has(tool.key) && styles.iconEntering)}
              >
                {tool.icon}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        side="top"
        align="end"
        // Negative offset: the menu's bottom edge lands on the pill's, so it opens over the pill.
        offset={-(anchorRef.current?.offsetHeight ?? 0)}
        measureKey={tools.length}
        exitDurationMs={CLOSE_MS}
        autoFocusSurface
        role="dialog"
        ariaLabel={t('modelMenuLabel')}
        className={styles.menu}
        onKeyDown={(event) => {
          if (handleMenuRowKey(listRef.current, event.key)) {
            event.preventDefault()
          }
        }}
      >
        <div ref={listRef} className={styles.list}>
          <p className={styles.section}>{t('modelMenuModel')}</p>
          <div className={styles.modelRow}>
            <span className={styles.modelRowLabel}>{modelLabel}</span>
            <span className={styles.check} aria-hidden="true" data-model-check="">
              <IconCheckOutline16 />
            </span>
          </div>
          <div className={styles.divider} role="separator" />
          <p className={styles.section}>{t('modelMenuTools')}</p>
          {tools.map((tool) => (
            <Switch
              key={tool.key}
              block
              data-composer-row=""
              icon={tool.icon}
              label={tool.label}
              checked={tool.checked}
              onChange={tool.onToggle}
            />
          ))}
        </div>
        {/* After the list, so the list's ref is attached when the morph's layout effect runs. */}
        <MenuMorph open={open} pillRef={anchorRef} listRef={listRef} />
      </Popover>
    </>
  )
}
