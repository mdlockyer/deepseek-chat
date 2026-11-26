import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'

/** Minimum clearance between an anchored floating surface and viewport edges. */
export const VIEWPORT_PADDING = 8

export type Side = 'top' | 'bottom'
export type Align = 'start' | 'center' | 'end'

export type AnchoredPosition = {
  top: number
  left?: number
  right?: number
  maxHeight?: number
  resolvedSide: Side
}

export type AnchoredOptions = {
  side?: Side
  align?: Align
  alignOffset?: number
  offset?: number
  maxHeight?: number
  minSpace?: number
  measureFirstChild?: boolean
  measureKey?: unknown
}

export type RectBox = {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

export type FloatingMeasure = {
  readonly width: number
  readonly height: number
  readonly scrollHeight: number
}

export type ViewportMeasure = {
  readonly width: number
  readonly height: number
}

const clampHorizontal = (left: number, width: number, viewportWidth: number) =>
  Math.max(VIEWPORT_PADDING, Math.min(left, viewportWidth - width - VIEWPORT_PADDING))

const clampVertical = (top: number, height: number, viewportHeight: number) =>
  Math.max(VIEWPORT_PADDING, Math.min(top, viewportHeight - height - VIEWPORT_PADDING))

const resolveSide = (
  spaceAbove: number,
  spaceBelow: number,
  preferred: Side,
  needed: number
): Side => {
  const fitsAbove = spaceAbove >= needed
  const fitsBelow = spaceBelow >= needed
  if (fitsAbove && !fitsBelow) {
    return 'top'
  }
  if (fitsBelow && !fitsAbove) {
    return 'bottom'
  }
  if (fitsAbove) {
    return preferred
  }
  return spaceAbove > spaceBelow ? 'top' : 'bottom'
}

/** Pure anchored positioning computation (hermetic and property-testable). */
export const computeAnchoredPosition = ({
  anchor,
  floating,
  viewport,
  options = {},
}: {
  anchor: RectBox
  floating: FloatingMeasure
  viewport: ViewportMeasure
  options?: Pick<
    AnchoredOptions,
    'side' | 'align' | 'alignOffset' | 'offset' | 'maxHeight' | 'minSpace'
  >
}): AnchoredPosition => {
  const side = options.side ?? 'bottom'
  const align = options.align ?? 'start'
  const alignOffset = options.alignOffset ?? 0
  const offset = options.offset ?? 4
  const minSpace = options.minSpace ?? 160

  const spaceAbove = anchor.top - offset - VIEWPORT_PADDING
  const spaceBelow = viewport.height - anchor.bottom - offset - VIEWPORT_PADDING

  const computeLeft = () => {
    if (align === 'center') {
      return clampHorizontal(
        anchor.left + anchor.width / 2 - floating.width / 2 + alignOffset,
        floating.width,
        viewport.width
      )
    }
    if (align === 'end') {
      return clampHorizontal(
        anchor.right - floating.width + alignOffset,
        floating.width,
        viewport.width
      )
    }
    return clampHorizontal(anchor.left + alignOffset, floating.width, viewport.width)
  }

  if (options.maxHeight === undefined) {
    const resolvedSide = resolveSide(spaceAbove, spaceBelow, side, floating.height)
    const rawTop =
      resolvedSide === 'top' ? anchor.top - offset - floating.height : anchor.bottom + offset
    return {
      top: clampVertical(rawTop, floating.height, viewport.height),
      left: computeLeft(),
      resolvedSide,
    }
  }

  const resolvedSide = resolveSide(spaceAbove, spaceBelow, side, minSpace)
  const available = Math.max(0, resolvedSide === 'top' ? spaceAbove : spaceBelow)
  const height = Math.max(40, Math.min(options.maxHeight, available, floating.scrollHeight + 2))
  const rawTop = resolvedSide === 'top' ? anchor.top - offset - height : anchor.bottom + offset
  const left = computeLeft()
  return {
    top: clampVertical(rawTop, height, viewport.height),
    left,
    maxHeight: height,
    resolvedSide,
  }
}

export const useAnchoredPosition = <T extends HTMLElement, F extends HTMLElement>(
  open: boolean,
  {
    side = 'bottom',
    align = 'start',
    alignOffset = 0,
    offset = 4,
    maxHeight,
    minSpace = 160,
    measureFirstChild = false,
    measureKey,
  }: AnchoredOptions = {}
) => {
  const anchorRef = useRef<T | null>(null) as MutableRefObject<T | null>
  const floatingRef = useRef<F | null>(null) as MutableRefObject<F | null>
  const [position, setPosition] = useState<AnchoredPosition | null>(null)

  const applyPosition = useCallback((next: AnchoredPosition) => {
    setPosition((previous) =>
      previous &&
      previous.top === next.top &&
      previous.left === next.left &&
      previous.right === next.right &&
      previous.maxHeight === next.maxHeight &&
      previous.resolvedSide === next.resolvedSide
        ? previous
        : next
    )
  }, [])

  const getAnchor = useCallback(
    () =>
      measureFirstChild
        ? (anchorRef.current?.firstElementChild as HTMLElement | null)
        : anchorRef.current,
    [anchorRef, measureFirstChild]
  )

  const update = useCallback(() => {
    const anchor = getAnchor()
    const floating = floatingRef.current
    if (!anchor || !floating) {
      return
    }
    const anchorRect = anchor.getBoundingClientRect()
    applyPosition(
      computeAnchoredPosition({
        anchor: anchorRect,
        // Layout size, not getBoundingClientRect(): an entrance animation's scale would otherwise
        // shrink the measured box on the first frame and place the surface off by the difference.
        floating: {
          width: floating.offsetWidth,
          height: floating.offsetHeight,
          scrollHeight: floating.scrollHeight,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        options: { side, align, alignOffset, offset, maxHeight, minSpace },
      })
    )
  }, [align, alignOffset, applyPosition, floatingRef, getAnchor, maxHeight, minSpace, offset, side])

  useLayoutEffect(() => {
    if (open) {
      update()
    }
  }, [measureKey, open, update])

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const floating = floatingRef.current
    if (!floating) {
      return
    }
    const anchor = getAnchor()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => update()) : null
    observer?.observe(floating)
    if (anchor) {
      observer?.observe(anchor)
    }
    window.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', update, { capture: true })
      window.removeEventListener('resize', update)
    }
  }, [floatingRef, getAnchor, open, update])

  useEffect(() => {
    if (!open) {
      setPosition(null)
    }
  }, [open])

  return { anchorRef, floatingRef, position }
}

/** Dismisses an open floating surface on outside pointerdown or Escape. */
export const useDismiss = (
  open: boolean,
  refs: RefObject<HTMLElement | null>[],
  onDismiss: (viaKeyboard: boolean) => void,
  { captureEscape = false }: { captureEscape?: boolean } = {}
) => {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const refsRef = useRef(refs)
  refsRef.current = refs

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const inside = refsRef.current.some((ref) => ref.current?.contains(target))
      if (!inside) {
        onDismissRef.current(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      if (captureEscape) {
        event.stopPropagation()
      }
      event.preventDefault()
      onDismissRef.current(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, captureEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, captureEscape)
    }
  }, [open, captureEscape])
}

/** Manages delayed open/close transitions for hover-triggered surfaces. */
export const useDelayedOpen = () => {
  const [open, setOpen] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const schedule = useCallback((next: boolean, delay: number) => {
    window.clearTimeout(timer.current)
    if (delay <= 0) {
      setOpen(next)
      return
    }
    timer.current = window.setTimeout(() => setOpen(next), delay)
  }, [])
  const cancel = useCallback(() => window.clearTimeout(timer.current), [])
  return { open, setOpen, schedule, cancel }
}
