import { IconCheckOutline16, Popover, Switch } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../messages.js'
import { handleMenuRowKey, type ComposerToolSwitch } from './ComposerMenu.js'
import styles from './ModelMenu.module.css'

/** How long the menu stays mounted while it shrinks back into the pill. */
const CLOSE_MS = 260
const CLOSE_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
const FADE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** A CSS time token in ms. The build minifies `440ms` to `.44s`, so both units occur. */
const toMs = (value: string, fallback: number) => {
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount)) {
    return fallback
  }
  return value.trim().endsWith('ms') ? amount : amount * 1000
}

const readMotion = () => {
  const root = getComputedStyle(document.documentElement)
  const spring = root.getPropertyValue('--ui-ease-spring').trim()
  return {
    reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    spring: spring && CSS.supports('animation-timing-function', spring) ? spring : FADE_EASE,
    duration: toMs(root.getPropertyValue('--ui-duration-spring'), 440),
  }
}

/**
 * The menu's background, which grows out of the pill. The menu opens over the pill with their
 * bottom-right corners together, so the pill's box inside the menu is fixed by the two sizes.
 * Opening, the background starts as the pill (same box, fully rounded) and springs out to the
 * menu while it fades in, and the rows are revealed as it grows over them. Closing runs it back
 * into the pill and fades it out, so the pill's own label shows again underneath. Either run
 * starts from wherever the previous one was, so reopening mid-close does not jump.
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
    const { reduce, spring, duration } = readMotion()
    const midFlight = runningRef.current.some((animation) => animation.playState === 'running')
    const current = midFlight
      ? {
          top: getComputedStyle(shell).top,
          left: getComputedStyle(shell).left,
          radius: getComputedStyle(shell).borderRadius,
          opacity: getComputedStyle(shell).opacity,
          clip: getComputedStyle(list).clipPath,
          listOpacity: getComputedStyle(list).opacity,
        }
      : null
    for (const animation of runningRef.current) {
      animation.cancel()
    }

    // The shell sits on the menu's border box (inset -1px), so its own top/left are -1px.
    const edge = -1
    const pillTop = edge + Math.max(0, surface.offsetHeight - pill.offsetHeight)
    const pillLeft = edge + Math.max(0, surface.offsetWidth - pill.offsetWidth)
    const pillRadius = `${pill.offsetHeight / 2}px`
    const finalRadius = getComputedStyle(shell).borderRadius
    const listRadius = Math.max(0, Number.parseFloat(finalRadius) - list.offsetTop)
    const clipAt = (top: number, left: number, radius: number) =>
      `inset(${Math.max(0, top)}px 0px 0px ${Math.max(0, left)}px round ${radius}px)`
    const pillClip = clipAt(
      pillTop - edge - list.offsetTop,
      pillLeft - edge - list.offsetLeft,
      pill.offsetHeight / 2
    )
    const fullClip = clipAt(0, 0, listRadius)
    const pillShape = { top: `${pillTop}px`, left: `${pillLeft}px`, borderRadius: pillRadius }
    const menuShape = { top: `${edge}px`, left: `${edge}px`, borderRadius: finalRadius }
    const shapeOf = (state: { top: string; left: string; radius: string }) => ({
      top: state.top,
      left: state.left,
      borderRadius: state.radius,
    })

    if (open) {
      const from = current ?? {
        top: pillShape.top,
        left: pillShape.left,
        radius: pillRadius,
        opacity: '0',
        clip: pillClip,
        listOpacity: '0',
      }
      runningRef.current = [
        shell.animate([reduce ? menuShape : shapeOf(from), menuShape], {
          duration,
          easing: spring,
          fill: 'both',
        }),
        shell.animate([{ opacity: from.opacity }, { opacity: 1 }], {
          duration: 150,
          easing: FADE_EASE,
          fill: 'both',
        }),
        list.animate([{ clipPath: reduce ? fullClip : from.clip }, { clipPath: fullClip }], {
          duration,
          easing: spring,
          fill: 'both',
        }),
        list.animate([{ opacity: from.listOpacity }, { opacity: 1 }], {
          duration: 220,
          delay: current ? 0 : 60,
          easing: FADE_EASE,
          fill: 'both',
        }),
      ]
      return
    }

    const from = current ?? {
      top: menuShape.top,
      left: menuShape.left,
      radius: finalRadius,
      opacity: '1',
      clip: fullClip,
      listOpacity: '1',
    }
    runningRef.current = [
      shell.animate([shapeOf(from), pillShape], {
        duration: CLOSE_MS - 20,
        easing: CLOSE_EASE,
        fill: 'both',
      }),
      shell.animate(
        [{ opacity: from.opacity }, { opacity: from.opacity, offset: 0.45 }, { opacity: 0 }],
        { duration: CLOSE_MS - 20, easing: 'linear', fill: 'both' }
      ),
      list.animate([{ clipPath: from.clip }, { clipPath: pillClip }], {
        duration: CLOSE_MS - 20,
        easing: CLOSE_EASE,
        fill: 'both',
      }),
      list.animate([{ opacity: from.listOpacity }, { opacity: 0 }], {
        duration: 100,
        easing: 'linear',
        fill: 'both',
      }),
    ]
  }, [open, listRef, pillRef])

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
            <span className={styles.check} aria-hidden="true">
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
