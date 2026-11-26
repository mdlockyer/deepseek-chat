import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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

export const Reveal = ({
  open,
  className,
  onSettle,
  children,
}: {
  open: boolean
  className?: string
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
      setScale(scaleFor(inner.offsetHeight))
    }
    setPhase((current) => (current === 'closed' ? current : 'closing'))
  }, [open])

  useLayoutEffect(() => {
    if (phase !== 'entering') {
      return
    }
    const inner = innerRef.current
    if (inner) {
      setScale(scaleFor(inner.scrollHeight))
    }
    // Force a style flush at the collapsed size so the next state change transitions.
    rootRef.current?.getBoundingClientRect()
    setPhase('opening')
  }, [phase])

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
      style={{ '--reveal-scale': scale } as CSSProperties}
      onTransitionEnd={settleIfIdle}
    >
      <div ref={innerRef} className={styles.inner}>
        {children()}
      </div>
    </div>
  )
}
