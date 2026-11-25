import clsx from 'clsx'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  INITIAL_HOVER_GLIDE_STATE,
  enterGlideTarget,
  expireGlideCooldown,
  leaveGlideTarget,
  measureGlideRect,
  normalizeGlideRadius,
  syncGlideRect,
  type GlideRect,
  type HoverGlideEffect,
  type HoverGlideState,
} from './hoverGlideState.js'
import styles from './HoverGlide.module.css'

export const HOVER_GLIDE_ITEM_ATTR = 'data-hover-glide-item'
export const HOVER_GLIDE_SURFACE_ATTR = 'data-hover-glide-surface'
const DEFAULT_ITEM_SELECTOR = `[${HOVER_GLIDE_ITEM_ATTR}]`
const DEFAULT_COOLDOWN_MS = 120

/**
 * Mark an element inside a `<HoverGlide>` or `useHoverGlide` surface as a glide target.
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
  surfaceClassName: string
  containerProps: {
    ref: RefObject<T>
    [HOVER_GLIDE_SURFACE_ATTR]: 'active' | 'disabled'
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

const isDisabledItem = (element: HTMLElement) =>
  element.getAttribute('aria-disabled') === 'true' ||
  element.hasAttribute('disabled') ||
  (typeof element.matches === 'function' && element.matches(':disabled'))

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
  const appliedGeometryRef = useRef<{ width: number; height: number; radius: string } | null>(null)

  const clearCooldown = useCallback(() => {
    if (cooldownTimerRef.current !== null) {
      window.clearTimeout(cooldownTimerRef.current)
      cooldownTimerRef.current = null
    }
  }, [])

  const applyRect = useCallback((indicator: HTMLDivElement, rect: GlideRect) => {
    indicator.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
    const prev = appliedGeometryRef.current
    if (!prev || prev.width !== rect.width) {
      indicator.style.width = `${rect.width}px`
    }
    if (!prev || prev.height !== rect.height) {
      indicator.style.height = `${rect.height}px`
    }
    const nextRadius = rect.radius ?? ''
    if (!prev || prev.radius !== nextRadius) {
      indicator.style.borderRadius = nextRadius
    }
    appliedGeometryRef.current = { width: rect.width, height: rect.height, radius: nextRadius }
  }, [])

  const resetIndicatorGeometry = useCallback((indicator: HTMLDivElement) => {
    indicator.dataset.glideVisible = 'false'
    indicator.dataset.glideMoving = 'false'
    indicator.style.transform = 'translate3d(0px, 0px, 0)'
    indicator.style.width = '0px'
    indicator.style.height = '0px'
    indicator.style.borderRadius = ''
    appliedGeometryRef.current = { width: 0, height: 0, radius: '' }
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
      if (!item || !container.contains(item) || item === container || isDisabledItem(item)) {
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
    const rect = measureGlideRect(
      item.getBoundingClientRect(),
      container.getBoundingClientRect(),
      container.scrollLeft,
      container.scrollTop,
      container.clientLeft,
      container.clientTop
    )
    const computedRadius =
      typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(item).borderRadius
        : null
    const radius = normalizeGlideRadius(computedRadius, rect.width, rect.height)
    return radius !== null ? { ...rect, radius } : rect
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

    const syncAfterLayoutOrScroll = () => {
      const pointer = lastPointerRef.current
      if (
        pointerInsideRef.current &&
        pointer &&
        typeof document !== 'undefined' &&
        typeof document.elementFromPoint === 'function'
      ) {
        moveToTarget(document.elementFromPoint(pointer.x, pointer.y), { snap: true })
        return
      }
      const current = stateRef.current
      if (current.kind !== 'active') {
        return
      }
      if (
        !current.target.isConnected ||
        !container.contains(current.target) ||
        !current.target.matches(itemSelector) ||
        isDisabledItem(current.target)
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
    }

    const onScroll = (event: Event) => {
      if (!pointerInsideRef.current || !lastPointerRef.current || scrollFrameRef.current !== null) {
        return
      }
      const target = event.target
      const affectsContainer =
        target === container ||
        target === document ||
        target === window ||
        (typeof Node !== 'undefined' && target instanceof Node && target.contains(container))
      if (!affectsContainer) {
        return
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null
        syncAfterLayoutOrScroll()
      })
    }

    const onWindowBlur = () => {
      if (!pointerInsideRef.current) {
        return
      }
      pointerInsideRef.current = false
      const next = leaveGlideTarget(stateRef.current)
      stateRef.current = next.state
      commitEffect(next.effect)
    }

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            syncAfterLayoutOrScroll()
          })
        : null

    const mutationObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver((records) => {
            const current = stateRef.current
            if (current.kind !== 'active') {
              return
            }
            if (records.some((record) => record.target === current.target)) {
              moveToTarget(current.target, { snap: true })
            }
          })
        : null

    container.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    window.addEventListener('blur', onWindowBlur)
    resizeObserver?.observe(container)
    mutationObserver?.observe(container, {
      subtree: true,
      attributes: true,
      attributeFilter: [HOVER_GLIDE_ITEM_ATTR, 'disabled', 'aria-disabled'],
    })

    return () => {
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onWindowBlur)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
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
      [HOVER_GLIDE_SURFACE_ATTR]: (disabled ? 'disabled' : 'active') as 'active' | 'disabled',
      onPointerOver,
      onPointerMove,
      onPointerLeave,
    }),
    [disabled, onPointerLeave, onPointerMove, onPointerOver]
  )

  const indicatorProps = useMemo(
    () => ({
      ref: indicatorRef,
      'aria-hidden': true as const,
      className: styles.indicator,
    }),
    []
  )

  return {
    containerRef,
    indicatorRef,
    surfaceClassName: styles.surface,
    containerProps,
    indicatorProps,
    reset,
  }
}

export type HoverGlideProps = ComponentPropsWithoutRef<'div'> &
  HoverGlideOptions & {
    /** Optional extra className for the gliding background indicator element. */
    indicatorClassName?: string
  }

/**
 * Declarative single-surface gliding hover container.
 * Wraps any list, button row, or mixed control group so items marked with `hoverGlideItem()`
 * share one smoothly gliding background that adapts to each item's size and corner radius.
 */
export const HoverGlide = forwardRef<HTMLDivElement, HoverGlideProps>(function HoverGlide(
  {
    itemSelector,
    cooldownMs,
    disabled,
    indicatorClassName,
    className,
    onPointerOver,
    onPointerMove,
    onPointerLeave,
    children,
    ...rest
  },
  forwardedRef
) {
  const glide = useHoverGlide<HTMLDivElement>({ itemSelector, cooldownMs, disabled })

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      ;(glide.containerRef as MutableRefObject<HTMLDivElement | null>).current = node
      if (typeof forwardedRef === 'function') {
        forwardedRef(node)
      } else if (forwardedRef) {
        forwardedRef.current = node
      }
    },
    [forwardedRef, glide.containerRef]
  )

  const handlePointerOver = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      glide.containerProps.onPointerOver(event)
      onPointerOver?.(event)
    },
    [glide.containerProps, onPointerOver]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      glide.containerProps.onPointerMove(event)
      onPointerMove?.(event)
    },
    [glide.containerProps, onPointerMove]
  )

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      glide.containerProps.onPointerLeave(event)
      onPointerLeave?.(event)
    },
    [glide.containerProps, onPointerLeave]
  )

  return (
    <div
      {...rest}
      ref={setRef}
      className={clsx(glide.surfaceClassName, className)}
      data-hover-glide-surface={glide.containerProps[HOVER_GLIDE_SURFACE_ATTR]}
      onPointerOver={handlePointerOver}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <div
        {...glide.indicatorProps}
        className={clsx(glide.indicatorProps.className, indicatorClassName)}
      />
      {children}
    </div>
  )
})

/** Optional wrapper when passing custom classes or inline styles onto the gliding surface. */
export const HoverGlideIndicator = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  function HoverGlideIndicator({ className, ...rest }, ref) {
    return (
      <div ref={ref} aria-hidden="true" className={clsx(styles.indicator, className)} {...rest} />
    )
  }
)
