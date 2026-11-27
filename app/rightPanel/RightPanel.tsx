import {
  IconButton,
  IconPanelContractOutline14,
  IconPanelExpandOutline14,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import { useCallback, useEffect, useRef } from 'react'
import { useAppRuntime } from '../RuntimeContext.js'
import { useTranslate } from '../i18n/index.js'
import { SidePanel } from './SidePanel.js'
import {
  DEFAULT_ACTIVITY_PANEL_WIDTH,
  WIDE_ACTIVITY_PANEL_WIDTH,
  getActiveRightPanel,
  getPanelDefaultWidth,
  getPanelMinWidth,
  type RightPanelKind,
} from './state.js'

/** 右侧面板统一宿主：在同一 SidePanel 壳层内切换文件预览、内置浏览器与本轮活动/来源检查器 */
export const RightPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const runtime = useAppRuntime()
  const { rightPanel, slices, platform } = runtime
  const { browser, workspaceFiles, conversations } = slices

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
      return conversations.activity !== null
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

  const panelWidth = rightPanel.useStore((state) =>
    shownKind === 'activity' ? state.activityWidth : state.width
  )
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

  const handleWidthChange = useCallback(
    (nextWidth: number) => {
      if (shownKind) {
        rightPanel.setWidthForKind(shownKind, nextWidth)
      }
    },
    [rightPanel, shownKind]
  )

  const activityWide = panelWidth >= (DEFAULT_ACTIVITY_PANEL_WIDTH + WIDE_ACTIVITY_PANEL_WIDTH) / 2
  const activityWidthToggle =
    !isMobile && shownKind === 'activity' ? (
      <IconButton
        size="xs"
        icon={activityWide ? <IconPanelContractOutline14 /> : <IconPanelExpandOutline14 />}
        tooltip={t(activityWide ? 'narrowPanel' : 'widenPanel')}
        tooltipPlacement="bottom"
        onClick={() =>
          rightPanel.setWidthForKind(
            'activity',
            activityWide ? DEFAULT_ACTIVITY_PANEL_WIDTH : WIDE_ACTIVITY_PANEL_WIDTH
          )
        }
      />
    ) : null

  return (
    <SidePanel
      open={effectiveKind !== null}
      contentKey={shownKind}
      width={panelWidth}
      minWidth={getPanelMinWidth(shownKind)}
      defaultWidth={getPanelDefaultWidth(shownKind)}
      onWidthChange={handleWidthChange}
      onResizeHoverStart={handleResizeHoverStart}
    >
      {shownKind === 'browser' && browser ? (
        <browser.BrowserPanel />
      ) : shownKind === 'preview' && workspaceFiles ? (
        <workspaceFiles.PreviewPanel />
      ) : shownKind === 'activity' && conversations.activity ? (
        <conversations.ActivityPanel topActions={activityWidthToggle} />
      ) : null}
    </SidePanel>
  )
}
