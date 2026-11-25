import {
  Chip,
  IconBrowseOutline16,
  IconGlobeLanguageOutline16,
  IconSearchOutline16,
} from '@deepseek-chat/lib-ui'
import { useCallback, useRef } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useAppRuntime } from '../RuntimeContext.js'
import { SidePanel } from './SidePanel.js'
import { getActiveRightPanel, getPreviousRightPanel, type RightPanelKind } from './state.js'

const useFalse = () => false

/** 右侧面板统一宿主：在同一 SidePanel 壳层内切换文件预览、内置浏览器与本轮活动/来源检查器 */
export const RightPanel = () => {
  const t = useTranslate()
  const runtime = useAppRuntime()
  const { rightPanel, slices, platform } = runtime
  const { browser, workspaceFiles, activityInspector } = slices

  const activeSessionId = rightPanel.useStore((state) => state.activeSessionId)
  const activePanels = rightPanel.useStore((state) => state.activePanels)
  const previousPanels = rightPanel.useStore((state) => state.previousPanels)
  const activeKind = getActiveRightPanel(activeSessionId, { activePanels })
  const previousKind = getPreviousRightPanel(activeSessionId, { previousPanels })

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

  const useHasFiles = workspaceFiles ? workspaceFiles.useHasFiles : useFalse
  const hasFiles = useHasFiles(activeSessionId)
  const useHasLastActivity = activityInspector ? activityInspector.useHasLastActivity : useFalse
  const hasLastActivity = useHasLastActivity()

  const lastKindRef = useRef<RightPanelKind | null>(effectiveKind)
  if (effectiveKind !== null) {
    lastKindRef.current = effectiveKind
  }
  const shownKind = canShowKind(effectiveKind ?? lastKindRef.current)
    ? (effectiveKind ?? lastKindRef.current)
    : null

  const lastHoverSnapshotAtRef = useRef(0)
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

  const returnAction = (() => {
    if (!activeSessionId || !shownKind) {
      return null
    }
    if (shownKind === 'preview' || shownKind === 'browser') {
      if (!activityInspector || !hasLastActivity) {
        return null
      }
      return (
        <Chip
          icon={<IconSearchOutline16 />}
          title={t('rightPanelBackToActivity')}
          aria-label={t('rightPanelBackToActivity')}
          onClick={activityInspector.restoreLastActivity}
        >
          {t('rightPanelBackToActivity')}
        </Chip>
      )
    }
    if (shownKind === 'activity') {
      if (previousKind === 'preview' && workspaceFiles && hasFiles) {
        return (
          <Chip
            icon={<IconBrowseOutline16 />}
            title={t('rightPanelBackToFiles')}
            aria-label={t('rightPanelBackToFiles')}
            onClick={() => rightPanel.openPanel(activeSessionId, 'preview')}
          >
            {t('rightPanelBackToFiles')}
          </Chip>
        )
      }
      if (previousKind === 'browser' && browser?.available) {
        return (
          <Chip
            icon={<IconGlobeLanguageOutline16 />}
            title={t('rightPanelBackToBrowser')}
            aria-label={t('rightPanelBackToBrowser')}
            onClick={() => rightPanel.openPanel(activeSessionId, 'browser')}
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
      {shownKind === 'browser' && browser ? (
        <browser.BrowserPanel topActions={returnAction} />
      ) : shownKind === 'preview' && workspaceFiles ? (
        <workspaceFiles.PreviewPanel topActions={returnAction} />
      ) : shownKind === 'activity' && activityInspector ? (
        <activityInspector.ActivityPanel topActions={returnAction} />
      ) : null}
    </SidePanel>
  )
}
