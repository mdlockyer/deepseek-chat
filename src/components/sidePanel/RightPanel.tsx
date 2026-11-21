import { useCallback, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isDesktopApp } from '../../platform/desktop.js'
import { refreshActiveTabSnapshot } from '../../services/browser/state.js'
import { triggerNativePreviewSnapshot } from '../../services/preview/state.js'
import {
  getActiveRightPanel,
  useSidePanelStore,
  type RightPanelKind,
} from '../../services/sidePanel/state.js'
import { IconSearchOutline16 } from '../base/icons.js'
import { BrowserPanel } from '../browser/BrowserPanel.js'
import { PreviewPanel } from '../preview/PreviewPanel.js'
import { SearchPanel } from '../search/SearchPanel.js'
import { restoreLastSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { SidePanel } from './SidePanel.js'
import panelStyles from './SidePanel.module.css'

/** 右侧面板统一宿主：在同一 SidePanel 壳层内切换文件预览、内置浏览器与搜索结果 */
export const RightPanel = () => {
  const t = useTranslate()
  const activeSessionId = useSidePanelStore((state) => state.activeSessionId)
  const activePanels = useSidePanelStore((state) => state.activePanels)
  const activeKind = getActiveRightPanel(activeSessionId, { activePanels })
  const effectiveKind = activeKind === 'browser' && !isDesktopApp ? null : activeKind

  const hasLastSearch = useSearchPanel(
    (state) => state.lastEntry !== null && state.lastSources.length > 0
  )

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
      void refreshActiveTabSnapshot()
    } else if (effectiveKind === 'preview' && isDesktopApp) {
      lastHoverSnapshotAtRef.current = now
      triggerNativePreviewSnapshot()
    }
  }, [effectiveKind])

  const previewSearchAction =
    shownKind === 'preview' && hasLastSearch ? (
      <button
        type="button"
        className={panelStyles.modeChip}
        title={t('browserBackToResults')}
        aria-label={t('browserBackToResults')}
        onClick={restoreLastSearchPanel}
      >
        <IconSearchOutline16 />
        <span>{t('browserBackToResults')}</span>
      </button>
    ) : null

  return (
    <SidePanel open={effectiveKind !== null} onResizeHoverStart={handleResizeHoverStart}>
      {shownKind === 'browser' ? (
        <BrowserPanel />
      ) : shownKind === 'preview' ? (
        <PreviewPanel topActions={previewSearchAction} />
      ) : shownKind === 'search' ? (
        <SearchPanel />
      ) : null}
    </SidePanel>
  )
}
