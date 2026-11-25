import clsx from 'clsx'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  INITIAL_HOVER_GLIDE_STATE,
  enterGlideTarget,
  expireGlideCooldown,
  leaveGlideTarget,
  measureGlideRect,
  syncGlideRect,
  type GlideRect,
  type HoverGlideEffect,
  type HoverGlideState,
} from './hoverGlideState.js'
import styles from './HoverGlide.module.css'

export const HOVER_GLIDE_ITEM_ATTR = 'data-hover-glide-item'
const DEFAULT_ITEM_SELECTOR = `[${HOVER_GLIDE_ITEM_ATTR}]`
const DEFAULT_COOLDOWN_MS = 120

/**
 * Mark an element inside a `useHoverGlide` container as a glide target.
 * Pass `muted = true` for items with their own active surface so the glider tracks
 * their position invisibly and emerges smoothly from them when the pointer moves on.
 */
export const hoverGlideItem = (muted = false) => ({
  [HOVER_GLIDE_ITEM_ATTR]: muted ? 'muted' : '',
})

export type HoverGlideOptions = {
  itemSelector?: string
  cooldownMs?: number
  disabled?: boolean
}

export type HoverGlideResult<T extends HTMLElement> = {
  containerRef: RefObject<T>
  indicatorRef: RefObject<HTMLDivElement>
  containerProps: {
    ref: RefObject<T>
    onPointerOver: (event: ReactPointerEvent<T>) => void
    onPointerMove: (event: ReactPointerEvent<T>) => void
    onPointerLeave: (event: ReactPointerEvent<T>) => void
  }
  indicatorProps: {
    ref: RefObject<HTMLDivElement>
    'aria-hidden': true
    className: string
  }
  reset: () => void
}

const isMutedItem = (element: HTMLElement) =>
  element.getAttribute(HOVER_GLIDE_ITEM_ATTR) === 'muted'

/**
 * Single-surface gliding hover indicator driven imperatively via refs (zero React re-renders
 * on pointer movement) and animated on the compositor with `transform` + `opacity`.
 */
export const useHoverGlide = <T extends HTMLElement = HTMLElement>({
  itemSelector = DEFAULT_ITEM_SELECTOR,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  disabled = false,
}: HoverGlideOptions = {}): HoverGlideResult<T> => {
  const containerRef = useRef<T | null>(null)
  const indicatorRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<HoverGlideState<HTMLElement>>(INITIAL_HOVER_GLIDE_STATE)
  const cooldownTimerRef = useRef<number | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const pointerInsideRef = useRef(false)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const appliedSizeRef = useRef<{ width: number; height: number } | null>(null)

  const clearCooldown = useCallback(() => {
    if (cooldownTimerRef.current !== null) {
      window.clearTimeout(cooldownTimerRef.current)
      cooldownTimerRef.current = null
    }
  }, [])

  const applyRect = useCallback((indicator: HTMLDivElement, rect: GlideRect) => {
    indicator.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
    const prevSize = appliedSizeRef.current
    if (!prevSize || prevSize.width !== rect.width) {
      indicator.style.width = `${rect.width}px`
    }
    if (!prevSize || prevSize.height !== rect.height) {
      indicator.style.height = `${rect.height}px`
    }
    appliedSizeRef.current = { width: rect.width, height: rect.height }
  }, [])

  const resetIndicatorGeometry = useCallback((indicator: HTMLDivElement) => {
    indicator.dataset.glideVisible = 'false'
    indicator.dataset.glideMoving = 'false'
    indicator.style.transform = 'translate3d(0px, 0px, 0)'
    indicator.style.width = '0px'
    indicator.style.height = '0px'
    appliedSizeRef.current = { width: 0, height: 0 }
  }, [])

  const commitEffect = useCallback(
    (effect: HoverGlideEffect) => {
      if (!effect.changed) {
        return
      }
      if (effect.cancelCooldown) {
        clearCooldown()
      }
      const indicator = indicatorRef.current
      if (!indicator) {
        return
      }
      if (effect.resetGeometry) {
        resetIndicatorGeometry(indicator)
        return
      }
      if (effect.rect) {
        if (!effect.animatePosition) {
          indicator.dataset.glideMoving = 'false'
          applyRect(indicator, effect.rect)
          void indicator.offsetWidth
          indicator.dataset.glideMoving = 'true'
        } else {
          indicator.dataset.glideMoving = 'true'
          applyRect(indicator, effect.rect)
        }
      }
      indicator.dataset.glideVisible = effect.visible ? 'true' : 'false'
      if (effect.scheduleCooldown) {
        clearCooldown()
        cooldownTimerRef.current = window.setTimeout(() => {
          cooldownTimerRef.current = null
          const next = expireGlideCooldown(stateRef.current)
          stateRef.current = next.state
          commitEffect(next.effect)
        }, cooldownMs)
      }
    },
    [applyRect, clearCooldown, cooldownMs, resetIndicatorGeometry]
  )

  const findItem = useCallback(
    (node: EventTarget | null): HTMLElement | null => {
      const container = containerRef.current
      if (!container || !(node instanceof Element)) {
        return null
      }
      const item = node.closest<HTMLElement>(itemSelector)
      if (!item || !container.contains(item) || item === container) {
        return null
      }
      return item
    },
    [itemSelector]
  )

  const measureItem = useCallback((item: HTMLElement): GlideRect | null => {
    const container = containerRef.current
    if (!container) {
      return null
    }
    return measureGlideRect(
      item.getBoundingClientRect(),
      container.getBoundingClientRect(),
      container.scrollLeft,
      container.scrollTop,
      container.clientLeft,
      container.clientTop
    )
  }, [])

  const moveToTarget = useCallback(
    (target: EventTarget | null, options?: { snap?: boolean }) => {
      const item = findItem(target)
      if (!item) {
        const next = leaveGlideTarget(stateRef.current)
        stateRef.current = next.state
        commitEffect(next.effect)
        return
      }
      const rect = measureItem(item)
      if (!rect) {
        return
      }
      const next = enterGlideTarget(stateRef.current, item, rect, isMutedItem(item), options)
      stateRef.current = next.state
      commitEffect(next.effect)
    },
    [commitEffect, findItem, measureItem]
  )

  const reset = useCallback(() => {
    clearCooldown()
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
    pointerInsideRef.current = false
    lastPointerRef.current = null
    stateRef.current = INITIAL_HOVER_GLIDE_STATE
    const indicator = indicatorRef.current
    if (indicator) {
      resetIndicatorGeometry(indicator)
    }
  }, [clearCooldown, resetIndicatorGeometry])

  useEffect(() => {
    if (disabled) {
      reset()
    }
  }, [disabled, reset])

  useEffect(() => {
    const container = containerRef.current
    if (!container || disabled) {
      return
    }

    const onScroll = () => {
      if (!pointerInsideRef.current || !lastPointerRef.current || scrollFrameRef.current !== null) {
        return
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null
        const pointer = lastPointerRef.current
        if (!pointerInsideRef.current || !pointer) {
          return
        }
        const hit = document.elementFromPoint(pointer.x, pointer.y)
        moveToTarget(hit, { snap: true })
      })
    }

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const current = stateRef.current
            if (current.kind !== 'active') {
              return
            }
            if (
              !current.target.isConnected ||
              !container.contains(current.target) ||
              !current.target.matches(itemSelector)
            ) {
              const next = leaveGlideTarget(current)
              stateRef.current = next.state
              commitEffect(next.effect)
              return
            }
            const rect = measureItem(current.target)
            if (!rect) {
              return
            }
            const next = syncGlideRect(current, rect)
            stateRef.current = next.state
            commitEffect(next.effect)
          })
        : null

    container.addEventListener('scroll', onScroll, { passive: true })
    observer?.observe(container)

    return () => {
      container.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      clearCooldown()
    }
  }, [clearCooldown, commitEffect, disabled, itemSelector, measureItem, moveToTarget])

  const onPointerOver = useCallback(
    (event: ReactPointerEvent<T>) => {
      if (disabled || event.pointerType === 'touch') {
        return
      }
      pointerInsideRef.current = true
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      moveToTarget(event.target)
    },
    [disabled, moveToTarget]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<T>) => {
      if (disabled || event.pointerType === 'touch') {
        return
      }
      pointerInsideRef.current = true
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      const current = stateRef.current
      if (
        current.kind === 'cold' ||
        (current.kind === 'active' && isMutedItem(current.target) !== current.muted)
      ) {
        moveToTarget(event.target)
      }
    },
    [disabled, moveToTarget]
  )

  const onPointerLeave = useCallback(
    (event: ReactPointerEvent<T>) => {
      if (event.pointerType === 'touch') {
        return
      }
      pointerInsideRef.current = false
      const next = leaveGlideTarget(stateRef.current)
      stateRef.current = next.state
      commitEffect(next.effect)
    },
    [commitEffect]
  )

  const containerProps = useMemo(
    () => ({
      ref: containerRef,
      onPointerOver,
      onPointerMove,
      onPointerLeave,
    }),
    [onPointerLeave, onPointerMove, onPointerOver]
  )

  const indicatorProps = useMemo(
    () => ({
      ref: indicatorRef,
      'aria-hidden': true as const,
      className: styles.indicator,
    }),
    []
  )

  return { containerRef, indicatorRef, containerProps, indicatorProps, reset }
}

/** Optional wrapper when passing custom classes or inline styles onto the gliding surface. */
export const HoverGlideIndicator = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  function HoverGlideIndicator({ className, ...rest }, ref) {
    return (
      <div ref={ref} aria-hidden="true" className={clsx(styles.indicator, className)} {...rest} />
    )
  }
)
