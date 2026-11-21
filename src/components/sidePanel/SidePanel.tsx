import clsx from 'clsx'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { setBrowserPanelWidth, setSiderCollapsed, useSettings } from '../../services/settings.js'
import {
  DEFAULT_SIDE_PANEL_WIDTH,
  clampSidePanelResizeWidth,
  setRightPanelAnimating,
  setRightPanelResizing,
  useSidePanelStore,
} from '../../services/sidePanel/state.js'
import { PANEL_DURATION_MS, usePresence } from '../../utils/usePresence.js'
import styles from './SidePanel.module.css'

/** 共享右侧面板壳层：开合动画、左侧拖拽调宽、窄屏自动收起侧边栏、移动端全屏抽屉 */
export const SidePanel = ({
  open,
  onResizeHoverStart,
  children,
}: {
  open: boolean
  onResizeHoverStart?: () => void
  children: ReactNode
}) => {
  const storedWidth = useSettings((state) => state.browserPanelWidth)
  const { mounted, exiting } = usePresence(open, PANEL_DURATION_MS)
  const panelRef = useRef<HTMLElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const prevOpenRef = useRef(open)
  const [entering, setEntering] = useState(open)
  const [resizingWidth, setResizingWidth] = useState<number | null>(null)

  if (open !== prevOpenRef.current) {
    prevOpenRef.current = open
    setEntering(open)
  }

  const panelWidth = resizingWidth ?? storedWidth

  // 打开面板时，如果窄屏下侧边栏展开会导致聊天区过窄，自动收起左侧边栏
  useEffect(() => {
    if (!open) {
      return
    }
    const { siderCollapsed } = useSettings.getState()
    if (!siderCollapsed && window.innerWidth - storedWidth - 261 < 420) {
      setSiderCollapsed(true)
    }
  }, [open, storedWidth])

  // 入场兜底：确保系统减弱动效或动画被打断时仍能及时清理动画状态
  useEffect(() => {
    if (!entering) {
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => {
        setEntering(false)
        setRightPanelAnimating(false)
      },
      reduced ? 30 : PANEL_DURATION_MS + 60
    )
    return () => window.clearTimeout(timer)
  }, [entering])

  useEffect(() => () => dragCleanupRef.current?.(), [])

  useEffect(() => {
    if (exiting) {
      setRightPanelAnimating(true)
    }
  }, [exiting])

  useEffect(() => {
    if (!mounted) {
      setRightPanelAnimating(false)
      setRightPanelResizing(false)
    }
  }, [mounted])

  if (!mounted) {
    return null
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || exiting) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    dragCleanupRef.current?.()
    if (entering) {
      setEntering(false)
    }
    setRightPanelAnimating(false)
    setRightPanelResizing(true)

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
      setRightPanelResizing(false)
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        onEnd()
        return
      }
      latestWidth = clampSidePanelResizeWidth(
        startWidth + (startX - moveEvent.clientX),
        window.innerWidth
      )
      setResizingWidth(latestWidth)
    }

    const onEnd = () => {
      cleanup()
      setBrowserPanelWidth(latestWidth)
      setResizingWidth(null)
      requestAnimationFrame(() => {
        if (dragCleanupRef.current === null && useSidePanelStore.getState().panelResizing) {
          setRightPanelResizing(false)
        }
      })
    }

    dragCleanupRef.current = forceCancel
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onEnd, true)
    window.addEventListener('pointercancel', onEnd, true)
    window.addEventListener('blur', onEnd)
  }

  return (
    <aside
      ref={panelRef}
      className={clsx(
        styles.panel,
        !exiting && entering && styles.panelOpening,
        exiting && styles.panelExiting,
        resizingWidth !== null && styles.panelResizing
      )}
      style={{ '--side-panel-width': `${panelWidth}px` } as CSSProperties}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && !exiting && entering) {
          setEntering(false)
          setRightPanelAnimating(false)
        }
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className={clsx(styles.resizer, resizingWidth !== null && styles.resizing)}
        onPointerEnter={() => {
          if (resizingWidth === null) {
            onResizeHoverStart?.()
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={startResize}
        onDoubleClick={() => setBrowserPanelWidth(DEFAULT_SIDE_PANEL_WIDTH)}
      />
      <div className={styles.panelInner}>{children}</div>
    </aside>
  )
}
