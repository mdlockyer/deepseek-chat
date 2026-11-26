import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import styles from './Reveal.module.css'

/**
 * Lifecycle of a height-animated disclosure.
 * - `closed`: nothing mounted.
 * - `entering`: mounted at zero height for one layout pass, so the browser has a start value.
 * - `opening`: growing to its natural height, content clipped.
 * - `open`: settled; content no longer clipped, so focus rings and hover glides show.
 * - `closing`: shrinking to zero height, content clipped; unmounts when the transition ends.
 */
type RevealPhase = 'closed' | 'entering' | 'opening' | 'open' | 'closing'

export const Reveal = ({
  open,
  className,
  children,
}: {
  open: boolean
  className?: string
  /** Called only while the reveal is mounted, so callers can build content lazily. */
  children: () => ReactNode
}) => {
  const [phase, setPhase] = useState<RevealPhase>(open ? 'open' : 'closed')
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    setPhase((current) => {
      if (open) {
        return current === 'closed' ? 'entering' : current === 'closing' ? 'opening' : current
      }
      return current === 'closed' ? current : 'closing'
    })
  }, [open])

  useLayoutEffect(() => {
    if (phase !== 'entering') {
      return
    }
    // Force a style flush at the collapsed size so the next state change transitions.
    ref.current?.getBoundingClientRect()
    setPhase('opening')
  }, [phase])

  if (phase === 'closed') {
    return null
  }

  return (
    <div
      ref={ref}
      className={clsx(styles.reveal, className)}
      data-phase={phase}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') {
          return
        }
        setPhase((current) =>
          current === 'opening' ? 'open' : current === 'closing' ? 'closed' : current
        )
      }}
    >
      <div className={styles.inner}>{children()}</div>
    </div>
  )
}
