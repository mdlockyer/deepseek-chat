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
} from 'react'
import { useAppRuntime } from '../RuntimeContext.js'
import { useTranslate } from '../i18n/index.js'
import styles from './RightPanel.module.css'
import {
  DEFAULT_SIDE_PANEL_WIDTH,
  MIN_SIDE_PANEL_WIDTH,
  clampSidePanelResizeWidth,
} from './state.js'

/** 共享右侧面板壳层：开合动画、左侧拖拽调宽、窄屏自动收起侧边栏、移动端全屏抽屉 */
export const SidePanel = ({
  open,
  width,
  minWidth = MIN_SIDE_PANEL_WIDTH,
  defaultWidth = DEFAULT_SIDE_PANEL_WIDTH,
  onWidthChange,
  onResizeHoverStart,
  children,
}: {
  open: boolean
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
  const resolvedWidth = width ?? storedWidth
  const commitWidth = onWidthChange ?? rightPanel.setWidth
  const { mounted, exiting } = usePresence(open, PANEL_DURATION_MS)
  const panelRef = useRef<HTMLElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const releaseFramesRef = useRef<number[]>([])
  const prevOpenRef = useRef(open)
  const [entering, setEntering] = useState(open)
  const [resizingWidth, setResizingWidth] = useState<number | null>(null)

  const cancelReleaseFrames = () => {
    for (const id of releaseFramesRef.current) {
      cancelAnimationFrame(id)
    }
    releaseFramesRef.current = []
  }

  if (open !== prevOpenRef.current) {
    prevOpenRef.current = open
    setEntering(open)
  }

  const panelWidth = resizingWidth ?? resolvedWidth

  useEffect(() => {
    if (!open) {
      return
    }
    if (layout.getState().mode === 'expanded' && window.innerWidth - resolvedWidth - 261 < 420) {
      layout.setSiderCollapsed(true)
    }
  }, [layout, open, resolvedWidth])

  useEffect(() => {
    if (!entering) {
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => {
        setEntering(false)
        rightPanel.setAnimating(false)
      },
      reduced ? 30 : PANEL_DURATION_MS + 60
    )
    return () => window.clearTimeout(timer)
  }, [entering, rightPanel])

  useEffect(
    () => () => {
      cancelReleaseFrames()
      dragCleanupRef.current?.()
    },
    []
  )

  useEffect(() => {
    if (exiting) {
      rightPanel.setAnimating(true)
    }
  }, [exiting, rightPanel])

  useEffect(() => {
    if (!mounted) {
      rightPanel.setAnimating(false)
      rightPanel.setResizing(false)
    }
  }, [mounted, rightPanel])

  if (!mounted) {
    return null
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || exiting) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    cancelReleaseFrames()
    dragCleanupRef.current?.()
    if (entering) {
      setEntering(false)
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
    if (exiting) {
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

  const maxResizerWidth =
    typeof window !== 'undefined'
      ? clampSidePanelResizeWidth(window.innerWidth, window.innerWidth, minWidth)
      : 920

  return (
    <aside
      ref={panelRef}
      className={clsx(
        styles.panel,
        !exiting && entering && styles.panelOpening,
        exiting && styles.panelExiting,
        resizingWidth !== null && styles.panelResizing
      )}
      style={
        {
          '--side-panel-width': `${panelWidth}px`,
          '--side-panel-min-width': `${minWidth}px`,
        } as CSSProperties
      }
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && !exiting && entering) {
          setEntering(false)
          rightPanel.setAnimating(false)
        }
      }}
    >
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
      <div className={styles.panelInner}>{children}</div>
    </aside>
  )
}
