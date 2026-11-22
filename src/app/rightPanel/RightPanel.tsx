import { useCallback, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isDesktopApp } from '../../platform/desktop.js'
import { browser } from '../composition.js'
import { useSessionFileRecords } from '../useSessionFileRecords.js'
import { workspaceFiles } from '../workspaceFiles.js'
import { getActiveRightPanel, useSidePanelStore, type RightPanelKind } from './state.js'
import { IconSearchOutline16 } from '@deepseek-chat/spine/design'
import { conversations } from '../conversations.js'
import { SidePanel } from './SidePanel.js'
import { panelStyles } from '@deepseek-chat/spine/design'

/** 右侧面板统一宿主：在同一 SidePanel 壳层内切换文件预览、内置浏览器与搜索结果 */
export const RightPanel = () => {
  const t = useTranslate()
  const activeSessionId = useSidePanelStore((state) => state.activeSessionId)
  const activePanels = useSidePanelStore((state) => state.activePanels)
  const activeKind = getActiveRightPanel(activeSessionId, { activePanels })
  const effectiveKind = activeKind === 'browser' && !isDesktopApp ? null : activeKind

  const fileRecords = useSessionFileRecords(activeSessionId)

  const hasLastSearch = conversations.useHasLastSearch()

  const lastKindRef = useRef<RightPanelKind | null>(effectiveKind)
  if (effectiveKind !== null) {
    lastKindRef.current = effectiveKind
  }
  const shownKind = effectiveKind ?? lastKindRef.current

  const lastHoverSnapshotAtRef = useRef(0)
  const handleResizeHoverStart = useCallback(() => {
    const now = Date.now()
    if (now - lastHoverSnapshotAtRef.current <= 800) {
      return
    }
    if (effectiveKind === 'browser') {
      lastHoverSnapshotAtRef.current = now
      void browser.refreshSnapshot()
    } else if (effectiveKind === 'preview' && isDesktopApp) {
      lastHoverSnapshotAtRef.current = now
      workspaceFiles.refreshSnapshot()
    }
  }, [effectiveKind])

  // 「返回搜索结果」入口：文件预览与内置浏览器的顶栏都可以带上
  const searchAction =
    hasLastSearch && (shownKind === 'preview' || shownKind === 'browser') ? (
      <button
        type="button"
        className={panelStyles.modeChip}
        title={t('browserBackToResults')}
        aria-label={t('browserBackToResults')}
        onClick={conversations.restoreLastSearchPanel}
      >
        <IconSearchOutline16 />
        <span>{t('browserBackToResults')}</span>
      </button>
    ) : null

  return (
    <SidePanel open={effectiveKind !== null} onResizeHoverStart={handleResizeHoverStart}>
      {shownKind === 'browser' ? (
        <browser.BrowserPanel topActions={searchAction} />
      ) : shownKind === 'preview' ? (
        <workspaceFiles.PreviewPanel records={fileRecords} topActions={searchAction} />
      ) : shownKind === 'search' ? (
        <conversations.SearchPanel />
      ) : null}
    </SidePanel>
  )
}
