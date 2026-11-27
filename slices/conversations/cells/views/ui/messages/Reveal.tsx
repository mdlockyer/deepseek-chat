import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { readDurationMs, readMotionToken, timeAtProgress } from './motion.js'
import styles from './Reveal.module.css'

/**
 * Lifecycle of a height-animated disclosure.
 * - `closed`: nothing mounted.
 * - `entering`: mounted at zero height for one layout pass, so the browser has a start value.
 * - `opening`: growing to its natural height, content clipped.
 * - `open`: settled; content no longer clipped, so focus rings and hover glides show.
 * - `closing`: shrinking to zero height, content clipped; unmounts when its transitions end.
 */
type RevealPhase = 'closed' | 'entering' | 'opening' | 'open' | 'closing'

/** Travel time grows with distance: 200 ms for short content, +25 ms per 100 px, 400 ms at most. */
const MIN_MS = 200
const MAX_MS = 400
const MS_PER_PX = 0.25
/** `--ui-duration-panel`, the token the CSS multiplies by `--reveal-scale`. */
const PANEL_MS = 280

const scaleFor = (height: number) =>
  Math.min(MAX_MS, Math.max(MIN_MS, MIN_MS + height * MS_PER_PX)) / PANEL_MS

/**
 * Flow reveals unfold 25% slower, on an easing that starts gently, so the edge visibly travels
 * down the content and items arrive one after another rather than all at once.
 */
const FLOW_STRETCH = 1.25

/** An item starts entering once the unfolding edge has uncovered this much of it. */
const FLOW_UNCOVERED_PX = 12

/**
 * Times each flow item's entrance to the moment the unfolding bottom edge reaches it, by inverting
 * the panel easing. Items below the reveal's height (for example inside an inner scroll box) enter
 * as the reveal finishes.
 */
const scheduleFlow = (root: HTMLElement, inner: HTMLElement, selector: string, scale: number) => {
  const items = inner.querySelectorAll<HTMLElement>(selector)
  if (items.length === 0) {
    return
  }
  const total = readDurationMs(root, '--ui-duration-panel') * scale
  const easing = readMotionToken(root, '--reveal-ease')
  const height = inner.scrollHeight
  const origin = inner.getBoundingClientRect().top
  for (const item of items) {
    const top = item.getBoundingClientRect().top - origin
    const reach = Math.min(top + FLOW_UNCOVERED_PX, height)
    const delay = Math.round(timeAtProgress(easing, height > 0 ? reach / height : 1) * total)
    item.dataset.revealFlow = ''
    item.style.setProperty('--reveal-flow-delay', `${delay}ms`)
  }
}

export const Reveal = ({
  open,
  className,
  onSettle,
  flow,
  children,
}: {
  open: boolean
  className?: string
  /**
   * CSS selector for items inside the content that should fade and settle into place one by one
   * as the unfolding edge reaches them. Without it, the content fades in as one piece.
   */
  flow?: string
  /** Called once the reveal has finished opening or closing. */
  onSettle?: (state: 'open' | 'closed') => void
  /** Called only while the reveal is mounted, so callers can build content lazily. */
  children: () => ReactNode
}) => {
  const [phase, setPhase] = useState<RevealPhase>(open ? 'open' : 'closed')
  const [scale, setScale] = useState(1)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const onSettleRef = useRef(onSettle)
  onSettleRef.current = onSettle

  useLayoutEffect(() => {
    if (open) {
      setPhase((current) =>
        current === 'closed' ? 'entering' : current === 'closing' ? 'opening' : current
      )
      return
    }
    const inner = innerRef.current
    if (inner) {
      setScale(scaleFor(inner.offsetHeight) * (flow ? FLOW_STRETCH : 1))
    }
    setPhase((current) => (current === 'closed' ? current : 'closing'))
  }, [open, flow])

  useLayoutEffect(() => {
    if (phase !== 'entering') {
      return
    }
    const inner = innerRef.current
    const root = rootRef.current
    if (inner) {
      const nextScale = scaleFor(inner.scrollHeight) * (flow ? FLOW_STRETCH : 1)
      setScale(nextScale)
      if (flow && root) {
        scheduleFlow(root, inner, flow, nextScale)
      }
    }
    // Force a style flush at the collapsed size so the next state change transitions.
    rootRef.current?.getBoundingClientRect()
    setPhase('opening')
  }, [phase, flow])

  if (phase === 'closed') {
    return null
  }

  const settleIfIdle = (event: React.TransitionEvent<HTMLDivElement>) => {
    const root = event.currentTarget
    if (
      event.target !== root ||
      root.getAnimations().some((animation) => animation.playState === 'running')
    ) {
      return
    }
    if (phase === 'opening') {
      setPhase('open')
      onSettleRef.current?.('open')
    } else if (phase === 'closing') {
      setPhase('closed')
      onSettleRef.current?.('closed')
    }
  }

  return (
    <div
      ref={rootRef}
      className={clsx(styles.reveal, className)}
      data-phase={phase}
      data-flow={flow ? '' : undefined}
      style={{ '--reveal-scale': scale } as CSSProperties}
      onTransitionEnd={settleIfIdle}
    >
      <div ref={innerRef} className={styles.inner}>
        {children()}
      </div>
    </div>
  )
}
