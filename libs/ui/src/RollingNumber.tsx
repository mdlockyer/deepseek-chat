import clsx from 'clsx'
import { useRef } from 'react'
import { readMotionEasing, readMotionMs } from './scrollGlide.js'
import { useBrowserLayoutEffect } from './layoutEffect.js'
import styles from './RollingNumber.module.css'

export type RollingNumberProps = {
  readonly value: number
  readonly className?: string
}

/**
 * A number that rolls to its new value like an odometer: up when it grows, down when it shrinks.
 * The outgoing value is a decorative copy, so assistive technology only ever reads the current one.
 * Follows the motion tokens, so it changes in place under reduced motion.
 */
export const RollingNumber = ({ value, className }: RollingNumberProps) => {
  const rootRef = useRef<HTMLSpanElement>(null)
  const valueRef = useRef<HTMLSpanElement>(null)
  const previous = useRef(value)

  useBrowserLayoutEffect(() => {
    const before = previous.current
    previous.current = value
    const root = rootRef.current
    const current = valueRef.current
    if (before === value || !root || !current || typeof current.animate !== 'function') {
      return
    }
    const direction = value > before ? 1 : -1
    const timing = {
      duration: readMotionMs(root, '--ui-duration-panel', 280),
      easing: readMotionEasing(root, '--ui-ease-panel', 'ease-out'),
    }
    const outgoing = document.createElement('span')
    outgoing.className = styles.outgoing
    outgoing.setAttribute('aria-hidden', 'true')
    outgoing.textContent = String(before)
    root.append(outgoing)
    const exit = outgoing.animate(
      [
        { transform: 'translateY(0)', opacity: 1 },
        { transform: `translateY(${-direction * 100}%)`, opacity: 0 },
      ],
      { ...timing, fill: 'forwards' }
    )
    exit.onfinish = () => outgoing.remove()
    exit.oncancel = () => outgoing.remove()
    current.animate(
      [
        { transform: `translateY(${direction * 100}%)`, opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      timing
    )
  }, [value])

  return (
    <span ref={rootRef} className={clsx(styles.root, className)}>
      <span ref={valueRef} className={styles.value}>
        {value}
      </span>
    </span>
  )
}
