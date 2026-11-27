import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { readDurationMs, readMotionToken } from '../messages/motion.js'

const measure = (container: HTMLElement | null): Map<string, number> => {
  const tops = new Map<string, number>()
  for (const el of container?.querySelectorAll<HTMLElement>('[data-flip-key]') ?? []) {
    tops.set(el.dataset.flipKey ?? '', el.getBoundingClientRect().top)
  }
  return tops
}

/**
 * When the list's order or membership changes (`layoutKey`), rows that moved glide from where
 * they were instead of jumping: a new chat pushes the rows below it down, a deleted one lets
 * them close up. Rows are the elements under `containerRef` that carry `data-flip-key`; rows
 * that just appeared keep their own entrance animation.
 */
export const useListFlip = (containerRef: RefObject<HTMLElement | null>, layoutKey: string) => {
  const [shownKey, setShownKey] = useState(layoutKey)
  const before = useRef<Map<string, number> | null>(null)

  // The old layout is still on screen during this render, so this is where it can be read.
  if (shownKey !== layoutKey) {
    before.current = measure(containerRef.current)
    setShownKey(layoutKey)
  }

  useLayoutEffect(() => {
    const previous = before.current
    const container = containerRef.current
    before.current = null
    if (!previous || !container) {
      return
    }
    const duration = readDurationMs(container, '--ui-duration-panel')
    const easing = readMotionToken(container, '--ui-ease-panel')
    for (const el of container.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      const old = previous.get(el.dataset.flipKey ?? '')
      if (old === undefined) {
        continue
      }
      const dy = old - el.getBoundingClientRect().top
      if (Math.abs(dy) > 0.5) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
          duration,
          easing,
        })
      }
    }
  }, [shownKey, containerRef])
}
