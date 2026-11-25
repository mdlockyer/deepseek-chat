import { useCallback, useEffect, useRef } from 'react'
import { useAppRuntime } from '../RuntimeContext.js'
import { SidePanel } from './SidePanel.js'
import { getActiveRightPanel, type RightPanelKind } from './state.js'

/** 右侧面板统一宿主：在同一 SidePanel 壳层内切换文件预览、内置浏览器与本轮活动/来源检查器 */
export const RightPanel = () => {
  const runtime = useAppRuntime()
  const { rightPanel, slices, platform } = runtime
  const { browser, workspaceFiles, activityInspector } = slices

  const activeSessionId = rightPanel.useStore((state) => state.activeSessionId)
  const activePanels = rightPanel.useStore((state) => state.activePanels)
  const activeKind = getActiveRightPanel(activeSessionId, { activePanels })

  const canShowKind = (kind: RightPanelKind | null): boolean => {
    if (kind === 'browser') {
      return Boolean(browser?.available)
    }
    if (kind === 'preview') {
      return workspaceFiles !== null
    }
    if (kind === 'activity') {
      return activityInspector !== null
    }
    return false
  }

  const effectiveKind = canShowKind(activeKind) ? activeKind : null

  const lastKindRef = useRef<RightPanelKind | null>(effectiveKind)
  if (effectiveKind !== null) {
    lastKindRef.current = effectiveKind
  }
  const shownKind = canShowKind(effectiveKind ?? lastKindRef.current)
    ? (effectiveKind ?? lastKindRef.current)
    : null

  const panelWidth = rightPanel.useStore((state) => state.width)
  const panelResizing = rightPanel.useStore((state) => state.panelResizing)
  const lastHoverSnapshotAtRef = useRef(0)

  useEffect(() => {
    if (!panelResizing) {
      lastHoverSnapshotAtRef.current = 0
    }
  }, [panelResizing, panelWidth])

  const handleResizeHoverStart = useCallback(() => {
    const now = Date.now()
    if (now - lastHoverSnapshotAtRef.current <= 800) {
      return
    }
    if (effectiveKind === 'browser' && browser) {
      lastHoverSnapshotAtRef.current = now
      void browser.refreshSnapshot()
    } else if (effectiveKind === 'preview' && workspaceFiles && platform === 'desktop') {
      lastHoverSnapshotAtRef.current = now
      workspaceFiles.refreshSnapshot()
    }
  }, [browser, effectiveKind, platform, workspaceFiles])

  return (
    <SidePanel open={effectiveKind !== null} onResizeHoverStart={handleResizeHoverStart}>
      {shownKind === 'browser' && browser ? (
        <browser.BrowserPanel />
      ) : shownKind === 'preview' && workspaceFiles ? (
        <workspaceFiles.PreviewPanel />
      ) : shownKind === 'activity' && activityInspector ? (
        <activityInspector.ActivityPanel />
      ) : null}
    </SidePanel>
  )
}
