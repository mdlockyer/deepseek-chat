import type { StageHost } from '@deepseek-chat/spine/ports'
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { stageMessages } from './messages.js'
import {
  clampViewportHeight,
  clampViewportWidth,
  computeDraggedViewportSize,
  fitViewportToStage,
  isCustomViewport,
  type StageFit,
  type ViewportDragEdge,
  type ViewportSpec,
} from './viewport.js'
import styles from './stage.module.css'

export type StageFrameProps = {
  host: StageHost
  viewport: ViewportSpec | null
  onStageSizeChange?: (size: { width: number; height: number }) => void
  onFitChange?: (fit: StageFit | null) => void
  onViewportResizeHoverStart?: () => void
  onViewportCommit?: (next: ViewportSpec) => unknown
  renderContent?: (
    fit: StageFit | null,
    meta: { resizing: boolean; viewport: ViewportSpec | null }
  ) => ReactNode
  children?: (
    fit: StageFit | null,
    meta: { resizing: boolean; viewport: ViewportSpec | null }
  ) => ReactNode
  banner?: ReactNode
}

/** Shared responsive viewport stage tracking available bounds, aspect-fit scaling, and drag handles. */
export const StageFrame = ({
  host,
  viewport,
  onStageSizeChange,
  onFitChange,
  onViewportResizeHoverStart,
  onViewportCommit,
  renderContent,
  children,
  banner,
}: StageFrameProps) => {
  const t = stageMessages.useTranslate()
  const stageCanvasRef = useRef<HTMLDivElement>(null)
  const onStageSizeChangeRef = useRef(onStageSizeChange)
  onStageSizeChangeRef.current = onStageSizeChange
  const onFitChangeRef = useRef(onFitChange)
  onFitChangeRef.current = onFitChange
  const onViewportCommitRef = useRef(onViewportCommit)
  onViewportCommitRef.current = onViewportCommit
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const releaseFramesRef = useRef<number[]>([])

  const cancelReleaseFrames = () => {
    for (const id of releaseFramesRef.current) {
      cancelAnimationFrame(id)
    }
    releaseFramesRef.current = []
  }

  const stageSize = host.useStageSize()
  const [dragViewport, setDragViewport] = useState<{ width: number; height: number } | null>(null)
  const [dragEdge, setDragEdge] = useState<ViewportDragEdge | null>(null)

  const canDragResize = Boolean(onViewportCommit) && isCustomViewport(viewport)

  useEffect(() => {
    if (!canDragResize && dragCleanupRef.current) {
      dragCleanupRef.current()
    }
  }, [canDragResize])

  useEffect(
    () => () => {
      cancelReleaseFrames()
      dragCleanupRef.current?.()
    },
    []
  )

  const displayViewport: ViewportSpec | null = useMemo(() => {
    if (!dragViewport) {
      return viewport
    }
    return {
      width: dragViewport.width,
      height: dragViewport.height,
      preset: null,
      aspectRatio: null,
    }
  }, [dragViewport, viewport])

  const hasCustomViewport = displayViewport !== null
  const viewportWidth = displayViewport?.width ?? null
  const viewportHeight = displayViewport?.height ?? null
  const stageWidth = stageSize?.width ?? null
  const stageHeight = stageSize?.height ?? null

  const fit = useMemo(() => {
    if (stageWidth === null || stageHeight === null) {
      return null
    }
    const spec =
      viewportWidth !== null && viewportHeight !== null
        ? { width: viewportWidth, height: viewportHeight }
        : null
    return fitViewportToStage(spec, stageWidth, stageHeight)
  }, [viewportWidth, viewportHeight, stageWidth, stageHeight])

  useLayoutEffect(() => {
    const stageEl = stageCanvasRef.current
    if (!stageEl) {
      return
    }
    const measure = () => {
      const rect = stageEl.getBoundingClientRect()
      if (rect.width > 1 && rect.height > 1) {
        const size = { width: rect.width, height: rect.height }
        host.setStageSize(size)
        onStageSizeChangeRef.current?.(size)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stageEl)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [host, hasCustomViewport, canDragResize])

  useLayoutEffect(() => {
    onFitChangeRef.current?.(fit)
  }, [fit])

  const startDrag = (edge: ViewportDragEdge, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canDragResize || !viewport || !fit) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    cancelReleaseFrames()
    dragCleanupRef.current?.()
    onViewportResizeHoverStart?.()
    host.setResizing(true)

    const target = event.currentTarget
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // Fallback to window capture listeners if pointer capture is unavailable.
    }

    const startX = event.clientX
    const startY = event.clientY
    const startViewport = {
      width: clampViewportWidth(viewport.width),
      height: clampViewportHeight(viewport.height),
    }
    const startZoom = fit.zoom
    let latestSize = startViewport
    let ended = false

    setDragEdge(edge)
    setDragViewport(startViewport)

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor =
      edge === 'right' ? 'ew-resize' : edge === 'bottom' ? 'ns-resize' : 'nwse-resize'
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
        // Ignore if capture was already released.
      }
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      if (dragCleanupRef.current === forceCancel) {
        dragCleanupRef.current = null
      }
    }

    const forceCancel = () => {
      cleanup()
      setDragViewport(null)
      setDragEdge(null)
      host.setResizing(false)
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        onEnd()
        return
      }
      latestSize = computeDraggedViewportSize({
        startViewport,
        startZoom,
        dx: moveEvent.clientX - startX,
        dy: moveEvent.clientY - startY,
        edge,
      })
      setDragViewport(latestSize)
    }

    const onEnd = () => {
      cleanup()
      const changed =
        latestSize.width !== startViewport.width || latestSize.height !== startViewport.height
      const commitResult = changed
        ? onViewportCommitRef.current?.({
            width: latestSize.width,
            height: latestSize.height,
            preset: null,
            aspectRatio: null,
          })
        : undefined
      setDragViewport(null)
      setDragEdge(null)
      const releaseResize = () => {
        cancelReleaseFrames()
        const f1 = requestAnimationFrame(() => {
          const f2 = requestAnimationFrame(() => {
            releaseFramesRef.current = []
            if (dragCleanupRef.current === null && host.isResizing()) {
              host.setResizing(false)
            }
          })
          releaseFramesRef.current = [f2]
        })
        releaseFramesRef.current = [f1]
      }
      if (commitResult instanceof Promise) {
        void commitResult.finally(releaseResize)
      } else {
        releaseResize()
      }
    }

    dragCleanupRef.current = forceCancel
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onEnd, true)
    window.addEventListener('pointercancel', onEnd, true)
    window.addEventListener('blur', onEnd)
  }

  const handleKeyStep = (edge: ViewportDragEdge, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canDragResize || !viewport) {
      return
    }
    const step = event.shiftKey ? 1 : 10
    let nextW = viewport.width
    let nextH = viewport.height
    if ((edge === 'right' || edge === 'corner') && event.key === 'ArrowRight') {
      nextW += step
    } else if ((edge === 'right' || edge === 'corner') && event.key === 'ArrowLeft') {
      nextW -= step
    } else if ((edge === 'bottom' || edge === 'corner') && event.key === 'ArrowDown') {
      nextH += step
    } else if ((edge === 'bottom' || edge === 'corner') && event.key === 'ArrowUp') {
      nextH -= step
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const clampedW = clampViewportWidth(nextW)
    const clampedH = clampViewportHeight(nextH)
    if (clampedW !== viewport.width || clampedH !== viewport.height) {
      void onViewportCommitRef.current?.({
        width: clampedW,
        height: clampedH,
        preset: null,
        aspectRatio: null,
      })
    }
  }

  const zoomPct = fit ? Math.round(fit.zoom * 100) : 100

  return (
    <div
      className={clsx(
        styles.viewportWrap,
        hasCustomViewport && styles.viewportStage,
        canDragResize && styles.viewportStageResizable
      )}
    >
      <div ref={stageCanvasRef} className={styles.stageCanvas}>
        <div
          className={styles.stageBox}
          style={
            hasCustomViewport && fit ? { width: fit.boxWidth, height: fit.boxHeight } : undefined
          }
        >
          <div className={clsx(styles.stageFrame, hasCustomViewport && styles.stageFrameActive)}>
            {(renderContent ?? children)?.(fit, {
              resizing: dragViewport !== null,
              viewport: displayViewport,
            })}
          </div>
          {canDragResize ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('viewportResizeWidth')}
                tabIndex={0}
                className={clsx(
                  styles.stageHandleRight,
                  (dragEdge === 'right' || dragEdge === 'corner') && styles.stageHandleActive
                )}
                onPointerEnter={() => {
                  if (dragViewport === null) {
                    onViewportResizeHoverStart?.()
                  }
                }}
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => startDrag('right', event)}
                onKeyDown={(event) => handleKeyStep('right', event)}
              />
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('viewportResizeHeight')}
                tabIndex={0}
                className={clsx(
                  styles.stageHandleBottom,
                  (dragEdge === 'bottom' || dragEdge === 'corner') && styles.stageHandleActive
                )}
                onPointerEnter={() => {
                  if (dragViewport === null) {
                    onViewportResizeHoverStart?.()
                  }
                }}
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => startDrag('bottom', event)}
                onKeyDown={(event) => handleKeyStep('bottom', event)}
              />
              <div
                role="button"
                aria-label={t('viewportResizeBoth')}
                tabIndex={0}
                className={clsx(
                  styles.stageHandleCorner,
                  dragEdge === 'corner' && styles.stageHandleActive
                )}
                onPointerEnter={() => {
                  if (dragViewport === null) {
                    onViewportResizeHoverStart?.()
                  }
                }}
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => startDrag('corner', event)}
                onKeyDown={(event) => handleKeyStep('corner', event)}
              />
            </>
          ) : null}
        </div>
      </div>
      {dragViewport ? (
        <div className={styles.stageDragHud} aria-hidden="true">
          {dragViewport.width} × {dragViewport.height}
          {zoomPct < 100 ? ` · ${zoomPct}%` : ''}
        </div>
      ) : null}
      {banner}
    </div>
  )
}
