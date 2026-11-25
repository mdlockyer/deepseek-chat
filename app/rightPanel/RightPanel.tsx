import { useCallback, useRef } from 'react'
import {
  Chip,
  IconBrowseOutline16,
  IconGlobeLanguageOutline16,
  IconSearchOutline16,
} from '@deepseek-chat/lib-ui'
import { browser } from '../composition.js'
import { conversations } from '../conversations.js'
import { useTranslate } from '../i18n/index.js'
import { isDesktopApp } from '../platform/desktop.js'
import { useSessionFileRecords } from '../useSessionFileRecords.js'
import { workspaceFiles } from '../workspaceFiles.js'
import { SidePanel } from './SidePanel.js'
import {
  getActiveRightPanel,
  getPreviousRightPanel,
  openRightPanel,
  useSidePanelStore,
  type RightPanelKind,
} from './state.js'

/** 右侧面板统一宿主：在同一 SidePanel 壳层内切换文件预览、内置浏览器与本轮活动/来源检查器 */
export const RightPanel = () => {
  const t = useTranslate()
  const activeSessionId = useSidePanelStore((state) => state.activeSessionId)
  const activePanels = useSidePanelStore((state) => state.activePanels)
  const previousPanels = useSidePanelStore((state) => state.previousPanels)
  const activeKind = getActiveRightPanel(activeSessionId, { activePanels })
  const previousKind = getPreviousRightPanel(activeSessionId, { previousPanels })
  const effectiveKind = activeKind === 'browser' && !isDesktopApp ? null : activeKind

  const fileRecords = useSessionFileRecords(activeSessionId)
  const hasLastActivity = conversations.useHasLastActivity()

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

  // Contextual one-click return chip when one right-hand panel displaced another on this session.
  const returnAction = (() => {
    if (!activeSessionId || !shownKind) {
      return null
    }
    if (shownKind === 'preview' || shownKind === 'browser') {
      if (!hasLastActivity) {
        return null
      }
      return (
        <Chip
          icon={<IconSearchOutline16 />}
          title={t('rightPanelBackToActivity')}
          aria-label={t('rightPanelBackToActivity')}
          onClick={conversations.restoreLastActivityPanel}
        >
          {t('rightPanelBackToActivity')}
        </Chip>
      )
    }
    if (shownKind === 'activity') {
      if (previousKind === 'preview' && fileRecords.length > 0) {
        return (
          <Chip
            icon={<IconBrowseOutline16 />}
            title={t('rightPanelBackToFiles')}
            aria-label={t('rightPanelBackToFiles')}
            onClick={() => openRightPanel(activeSessionId, 'preview')}
          >
            {t('rightPanelBackToFiles')}
          </Chip>
        )
      }
      if (previousKind === 'browser' && isDesktopApp) {
        return (
          <Chip
            icon={<IconGlobeLanguageOutline16 />}
            title={t('rightPanelBackToBrowser')}
            aria-label={t('rightPanelBackToBrowser')}
            onClick={() => openRightPanel(activeSessionId, 'browser')}
          >
            {t('rightPanelBackToBrowser')}
          </Chip>
        )
      }
    }
    return null
  })()

  return (
    <SidePanel open={effectiveKind !== null} onResizeHoverStart={handleResizeHoverStart}>
      {shownKind === 'browser' ? (
        <browser.BrowserPanel topActions={returnAction} />
      ) : shownKind === 'preview' ? (
        <workspaceFiles.PreviewPanel records={fileRecords} topActions={returnAction} />
      ) : shownKind === 'activity' ? (
        <conversations.ActivityPanel topActions={returnAction} />
      ) : null}
    </SidePanel>
  )
}
