import { usePresence } from '@deepseek-chat/lib-ui'
import { PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type TransitionEvent,
} from 'react'
import { useAppRuntime } from '../RuntimeContext.js'
import { useTranslate } from '../i18n/index.js'
import styles from './RightPanel.module.css'
import {
  DEFAULT_SIDE_PANEL_WIDTH,
  MIN_SIDE_PANEL_WIDTH,
  clampSidePanelResizeWidth,
} from './state.js'

/**
 * 共享右侧面板壳层：常驻 DOM，与左侧边栏共用同一套 CSS transition 物理模型
 * （280ms cubic-bezier(0.32, 0.72, 0, 1)），支持任意状态下无缝打断反向、
 * 面板间宽幅平滑过渡、开合刚性防挤压裁切、拖拽零延迟与移动端全屏抽屉。
 */
export const SidePanel = ({
  open,
  contentKey,
  width,
  minWidth = MIN_SIDE_PANEL_WIDTH,
  defaultWidth = DEFAULT_SIDE_PANEL_WIDTH,
  onWidthChange,
  onResizeHoverStart,
  children,
}: {
  open: boolean
  contentKey?: string | null
  width?: number
  minWidth?: number
  defaultWidth?: number
  onWidthChange?: (width: number) => void
  onResizeHoverStart?: () => void
  children: ReactNode
}) => {
  const t = useTranslate()
  const { rightPanel, layout } = useAppRuntime()
  const storedWidth = rightPanel.useStore((state) => state.width)
  const panelAnimating = rightPanel.useStore((state) => state.panelAnimating)
  const resolvedWidth = width ?? storedWidth
  const commitWidth = onWidthChange ?? rightPanel.setWidth
  const { mounted: contentMounted, exiting } = usePresence(open, PANEL_DURATION_MS)
  const panelRef = useRef<HTMLElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const releaseFramesRef = useRef<number[]>([])
  const prevOpenRef = useRef(open)
  const prevContentKeyRef = useRef(contentKey ?? null)
  const lastTargetWidthRef = useRef(resolvedWidth)
  const [opening, setOpening] = useState(false)
  const [swappingKind, setSwappingKind] = useState(false)
  const [resizingWidth, setResizingWidth] = useState<number | null>(null)

  const cancelReleaseFrames = () => {
    for (const id of releaseFramesRef.current) {
      cancelAnimationFrame(id)
    }
    releaseFramesRef.current = []
  }

  if (open) {
    lastTargetWidthRef.current = resolvedWidth
  }

  if (open !== prevOpenRef.current) {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    setOpening(!wasOpen && open)
    if (!open || !wasOpen) {
      setSwappingKind(false)
    }
  }

  const nextContentKey = contentKey ?? null
  if (nextContentKey !== prevContentKeyRef.current) {
    const hadKind = prevContentKeyRef.current !== null
    prevContentKeyRef.current = nextContentKey
    if (open && !opening && hadKind && nextContentKey !== null) {
      setSwappingKind(true)
    } else if (!open) {
      setSwappingKind(false)
    }
  }

  const targetWidth = open ? resolvedWidth : lastTargetWidthRef.current
  const panelWidth = resizingWidth ?? targetWidth

  useEffect(() => {
    if (!open) {
      return
    }
    if (layout.getState().mode === 'expanded' && window.innerWidth - resolvedWidth - 261 < 420) {
      layout.setSiderCollapsed(true)
    }
  }, [layout, open, resolvedWidth])

  // Unified settlement fallback so `panelAnimating` & `opening` can never stall if transitionend is skipped.
  useEffect(() => {
    if (!panelAnimating && !opening) {
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => {
        setOpening(false)
        rightPanel.setAnimating(false)
      },
      reduced ? 30 : PANEL_DURATION_MS + 60
    )
    return () => window.clearTimeout(timer)
  }, [panelAnimating, opening, open, resolvedWidth, rightPanel])

  useEffect(() => {
    if (!swappingKind) {
      return
    }
    const timer = window.setTimeout(() => setSwappingKind(false), 180)
    return () => window.clearTimeout(timer)
  }, [swappingKind, nextContentKey])

  useEffect(
    () => () => {
      cancelReleaseFrames()
      dragCleanupRef.current?.()
    },
    []
  )

  useEffect(() => {
    if (!contentMounted) {
      setOpening(false)
      setSwappingKind(false)
      rightPanel.setAnimating(false)
      rightPanel.setResizing(false)
    }
  }, [contentMounted, rightPanel])

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !open || exiting) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    cancelReleaseFrames()
    dragCleanupRef.current?.()
    if (opening) {
      setOpening(false)
    }
    rightPanel.setAnimating(false)
    rightPanel.setResizing(true)

    const target = event.currentTarget
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // Fallback to window capture listeners if pointer capture is unavailable
    }
    const startX = event.clientX
    const startWidth = Math.round(panelRef.current?.getBoundingClientRect().width ?? panelWidth)
    let latestWidth = startWidth
    let ended = false
    setResizingWidth(startWidth)

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const cleanup = () => {
      if (ended) {
        return
      }
      ended = true
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onEnd, true)
      window.removeEventListener('pointercancel', onEnd, true)
      window.removeEventListener('blur', onEnd)
      try {
        if (target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId)
        }
      } catch {
        // Ignore if capture was already released
      }
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      if (dragCleanupRef.current === forceCancel) {
        dragCleanupRef.current = null
      }
    }

    const forceCancel = () => {
      cleanup()
      setResizingWidth(null)
      rightPanel.setResizing(false)
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        onEnd()
        return
      }
      latestWidth = clampSidePanelResizeWidth(
        startWidth + (startX - moveEvent.clientX),
        window.innerWidth,
        minWidth
      )
      setResizingWidth(latestWidth)
    }

    const onEnd = () => {
      cleanup()
      commitWidth(latestWidth)
      setResizingWidth(null)
      cancelReleaseFrames()
      const f1 = requestAnimationFrame(() => {
        const f2 = requestAnimationFrame(() => {
          releaseFramesRef.current = []
          if (dragCleanupRef.current === null && rightPanel.useStore.getState().panelResizing) {
            rightPanel.setResizing(false)
          }
        })
        releaseFramesRef.current = [f2]
      })
      releaseFramesRef.current = [f1]
    }

    dragCleanupRef.current = forceCancel
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onEnd, true)
    window.addEventListener('pointercancel', onEnd, true)
    window.addEventListener('blur', onEnd)
  }

  const handleResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || exiting) {
      return
    }
    const step = event.shiftKey ? 96 : 32
    const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitWidth(clampSidePanelResizeWidth(panelWidth + step, windowWidth, minWidth))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitWidth(clampSidePanelResizeWidth(panelWidth - step, windowWidth, minWidth))
    } else if (event.key === 'Home') {
      event.preventDefault()
      commitWidth(clampSidePanelResizeWidth(minWidth, windowWidth, minWidth))
    } else if (event.key === 'End') {
      event.preventDefault()
      commitWidth(clampSidePanelResizeWidth(windowWidth, windowWidth, minWidth))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      commitWidth(defaultWidth)
    }
  }

  const handleTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      return
    }
    if (event.propertyName === 'width' || event.propertyName === 'transform') {
      setOpening(false)
      rightPanel.setAnimating(false)
    }
  }

  const maxResizerWidth =
    typeof window !== 'undefined'
      ? clampSidePanelResizeWidth(window.innerWidth, window.innerWidth, minWidth)
      : 920

  const rigidInner = opening || !open

  return (
    <aside
      ref={panelRef}
      aria-hidden={!open || undefined}
      className={clsx(
        styles.panel,
        !open && styles.panelClosed,
        opening && styles.panelOpening,
        resizingWidth !== null && styles.panelResizing
      )}
      style={
        {
          '--side-panel-width': `${panelWidth}px`,
          '--side-panel-target-width': `${targetWidth}px`,
        } as CSSProperties
      }
      onTransitionEnd={handleTransitionEnd}
    >
      {open ? (
        <div
          role="separator"
          tabIndex={0}
          aria-label={t('resizeSidePanel')}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxResizerWidth}
          aria-valuenow={panelWidth}
          className={clsx(styles.resizer, resizingWidth !== null && styles.resizing)}
          onPointerEnter={() => {
            if (resizingWidth === null) {
              onResizeHoverStart?.()
            }
          }}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={startResize}
          onKeyDown={handleResizerKeyDown}
          onDoubleClick={() => commitWidth(defaultWidth)}
        />
      ) : null}
      <div className={styles.panelViewport}>
        <div className={clsx(styles.panelInner, rigidInner && styles.panelInnerRigid)}>
          {contentMounted ? (
            <div
              key={nextContentKey ?? 'panel'}
              className={clsx(styles.panelContent, swappingKind && styles.panelContentSwap)}
            >
              {children}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
