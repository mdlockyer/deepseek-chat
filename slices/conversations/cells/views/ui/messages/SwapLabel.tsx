import clsx from 'clsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { readDurationMs, readMotionToken } from './motion.js'
import styles from './SwapLabel.module.css'

type Outgoing = { text: string; className: string; id: number }

/**
 * A one-line label that crossfades when it changes meaning (`swapKey`), and eases its width so
 * the surrounding button grows or shrinks instead of jumping. Text updates under the same key,
 * such as a ticking timer, replace in place.
 */
export const SwapLabel = ({
  swapKey,
  className,
  children,
}: {
  swapKey: string
  className: string
  children: string
}) => {
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const outgoingRef = useRef<HTMLSpanElement | null>(null)
  const [shown, setShown] = useState({ key: swapKey, text: children, className })
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null)
  // Derive the outgoing copy during render, from the label that was showing before this change.
  if (shown.key !== swapKey || shown.text !== children || shown.className !== className) {
    if (shown.key !== swapKey) {
      setOutgoing({ text: shown.text, className: shown.className, id: (outgoing?.id ?? 0) + 1 })
    }
    setShown({ key: swapKey, text: children, className })
  }

  useLayoutEffect(() => {
    const root = rootRef.current
    const leaving = outgoingRef.current
    if (!outgoing || !root || !leaving) {
      return
    }
    // The outgoing copy is absolutely positioned, so it still has the old label's natural width.
    const from = leaving.getBoundingClientRect().width
    const to = root.getBoundingClientRect().width
    if (Math.abs(from - to) < 0.5) {
      return
    }
    const resize = root.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: readDurationMs(root, '--ui-duration-slow'),
      easing: readMotionToken(root, '--ui-ease-panel'),
    })
    return () => resize.cancel()
  }, [outgoing])

  return (
    <span ref={rootRef} className={styles.root}>
      <span
        key={swapKey}
        className={clsx(className, outgoing && styles.incoming)}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) {
            setOutgoing(null)
          }
        }}
      >
        {children}
      </span>
      {outgoing ? (
        <span
          key={outgoing.id}
          ref={outgoingRef}
          className={clsx(outgoing.className, styles.outgoing)}
          aria-hidden="true"
        >
          {outgoing.text}
        </span>
      ) : null}
    </span>
  )
}
