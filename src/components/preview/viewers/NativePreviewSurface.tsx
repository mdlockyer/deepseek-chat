import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stageHost } from '../../../app/rightPanel/stageHost.js'
import {
  previewSetBounds,
  previewSetContent,
  previewSetVisible,
  previewTakeSnapshot,
} from '../../../platform/desktop.js'
import {
  registerNativePreviewSnapshotTrigger,
  triggerNativePreviewSnapshot,
} from '../../../services/preview/state.js'
import { registerOverlayLockListener, useSidePanelStore } from '../../../app/rightPanel/state.js'
import type { BrowserStageFit, BrowserViewportSpec } from '@deepseek-chat/spine/design'
import { StageFrame } from '@deepseek-chat/spine/design'
import { panelStyles } from '@deepseek-chat/spine/design'
import styles from '../PreviewPanel.module.css'

/** 桌面端原生隔离预览子 Webview 宿主：用于 HTML 与 PDF，复用浏览器面板的坐标/缩放/覆盖层快照机制 */
export const NativePreviewSurface = ({
  bytes,
  mimeType,
  viewport,
  reloadKey,
  onViewportCommit,
  banner,
}: {
  bytes: Uint8Array
  mimeType: 'text/html' | 'application/pdf'
  viewport: BrowserViewportSpec | null
  reloadKey: number
  onViewportCommit?: (next: BrowserViewportSpec) => void
  banner?: React.ReactNode
}) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const panelAnimating = useSidePanelStore((state) => state.panelAnimating)
  const panelResizing = useSidePanelStore((state) => state.panelResizing)
  const overlayLocks = useSidePanelStore((state) => state.overlayLocks)
  const storedWidth = useSidePanelStore((state) => state.width)
  const [stageFit, setStageFit] = useState<BrowserStageFit | null>(null)
  const [snapshot, setSnapshot] = useState<{
    dataUrl: string
    width: number
    height: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const occluded = panelAnimating || panelResizing || overlayLocks > 0

  // 推送文件内容到 Rust ds-preview 协议，并在首次挂载/内容变更时显示
  useEffect(() => {
    let cancelled = false
    setError(null)
    setSnapshot(null)
    void previewSetContent(bytes, mimeType).catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })
    return () => {
      cancelled = true
    }
  }, [bytes, mimeType, reloadKey])

  // 订阅弹窗/菜单覆盖锁与拖拽悬停：隐藏前抓取快照，防止原生 Webview 遮挡浮层或留白
  useEffect(() => {
    const captureSnapshot = () => {
      const state = useSidePanelStore.getState()
      if (state.panelAnimating || state.panelResizing) {
        return
      }
      void previewTakeSnapshot(1280)
        .then((snap) => {
          setSnapshot(snap)
        })
        .catch(() => {})
    }
    const unsubHover = registerNativePreviewSnapshotTrigger(captureSnapshot)
    const unsubLock = registerOverlayLockListener((locked) => {
      if (!locked) {
        return
      }
      const state = useSidePanelStore.getState()
      if (state.panelAnimating || state.panelResizing) {
        return
      }
      void previewTakeSnapshot(1280)
        .then((snap) => {
          setSnapshot(snap)
        })
        .catch(() => {})
        .finally(() => {
          void previewSetVisible(false).catch(() => {})
        })
    })
    return () => {
      unsubHover()
      unsubLock()
    }
  }, [])

  // 控制原生子 Webview 显示/隐藏与卸载隐藏
  useEffect(() => {
    void previewSetVisible(!occluded).catch(() => {})
  }, [occluded])

  useEffect(() => {
    return () => {
      void previewSetVisible(false).catch(() => {})
    }
  }, [])

  // 同步舞台区域逻辑坐标与缩放比例到原生 Webview
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || panelResizing) {
      return
    }
    const rect = el.getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1) {
      const left = Math.ceil(rect.left)
      const top = Math.ceil(rect.top)
      void previewSetBounds(
        {
          x: left,
          y: top,
          width: Math.max(1, Math.floor(rect.right) - left),
          height: Math.max(1, Math.floor(rect.bottom) - top),
        },
        stageFit?.zoom ?? 1
      ).catch(() => {})
    }
  }, [
    storedWidth,
    panelResizing,
    occluded,
    stageFit?.boxWidth,
    stageFit?.boxHeight,
    stageFit?.zoom,
  ])

  const hasCustomViewport = viewport !== null
  const showSnapshot = Boolean(snapshot) && occluded

  return (
    <StageFrame
      host={stageHost}
      viewport={viewport}
      onFitChange={setStageFit}
      onViewportResizeHoverStart={triggerNativePreviewSnapshot}
      onViewportCommit={onViewportCommit}
      banner={error ? <div className={panelStyles.errorBanner}>{error}</div> : banner}
    >
      {() => (
        <>
          <div ref={viewportRef} className={styles.nativeViewport} />
          {showSnapshot && snapshot ? (
            <img
              src={snapshot.dataUrl}
              className={clsx(
                styles.snapshotFallback,
                hasCustomViewport && styles.snapshotFallbackFit
              )}
              style={
                !hasCustomViewport && snapshot.width && snapshot.height
                  ? { width: snapshot.width, height: snapshot.height }
                  : undefined
              }
              alt=""
            />
          ) : null}
        </>
      )}
    </StageFrame>
  )
}
