import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { stageHost } from '../../app/rightPanel/stageHost.js'
import { useTranslate } from '../../i18n/index.js'
import { isDesktopApp, openExternalUrl } from '../../platform/desktop.js'
import {
  EMPTY_SESSION_BROWSER_STATE,
  clearBrowserTabData,
  closeBrowserPanel,
  closeBrowserTab,
  createBrowserTab,
  isHttpUrl,
  navigateBrowserTab,
  openBrowserTabDevtools,
  refreshActiveTabSnapshot,
  runBrowserHistory,
  setBrowserPanelBounds,
  setBrowserStageSize,
  setBrowserTabViewport,
  switchBrowserTab,
  useBrowserStore,
} from '../../services/browser/state.js'
import { stopReply } from '../../services/chat/store.js'
import { useSidePanelStore } from '../../app/rightPanel/state.js'
import type { BrowserStageFit } from '@deepseek-chat/spine/design'
import { IconButton } from '@deepseek-chat/spine/design'
import { Menu } from '@deepseek-chat/spine/design'
import {
  IconBrowserOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEllipsisOutline16,
  IconGlobeLanguageOutline14,
  IconLockOutline12,
  IconOpenExternalOutline14,
  IconPlusOutline14,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
} from '@deepseek-chat/spine/design'
import { restoreLastSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { StageFrame } from '@deepseek-chat/spine/design'
import { ViewportMenu } from '@deepseek-chat/spine/design'
import { panelStyles } from '@deepseek-chat/spine/design'
import chrome from './BrowserChrome.module.css'
import styles from './BrowserPanel.module.css'

const displayTabTitle = (url: string, title: string, fallback: string) => {
  if (title.trim()) {
    return title.trim()
  }
  if (!isHttpUrl(url)) {
    return fallback
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/** 右侧内置浏览器面板内容（托管在共享 SidePanel 壳层内） */
export const BrowserPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
  const t = useTranslate()
  const activeSessionId = useBrowserStore((state) => state.activeSessionId)
  const sessionBrowser = useBrowserStore((state) =>
    state.activeSessionId && Object.hasOwn(state.sessions, state.activeSessionId)
      ? state.sessions[state.activeSessionId]
      : EMPTY_SESSION_BROWSER_STATE
  )
  const { tabs, activeTabId } = sessionBrowser
  const overlayLocks = useBrowserStore((state) => state.overlayLocks)
  const panelAnimating = useSidePanelStore((state) => state.panelAnimating)
  const panelResizing = useSidePanelStore((state) => state.panelResizing)
  const controlling = useBrowserStore((state) => state.controlling)
  const controllingAction = useBrowserStore((state) => state.controllingAction)
  const controllingSessionId = useBrowserStore((state) => state.controllingSessionId)
  const storedWidth = useSidePanelStore((state) => state.width)
  const hasLastSearch = useSearchPanel(
    (state) => state.lastEntry !== null && state.lastSources.length > 0
  )

  const viewportRef = useRef<HTMLDivElement>(null)
  const omniboxRef = useRef<HTMLInputElement>(null)
  const [addressDraft, setAddressDraft] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  const [stageFit, setStageFit] = useState<BrowserStageFit | null>(null)

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null
  const activeUrl = activeTab && isHttpUrl(activeTab.url) ? activeTab.url : ''
  const activeViewport = activeTab?.viewport ?? null
  const hasCustomViewport = activeViewport !== null

  // 切换会话时取消未提交的地址栏编辑状态
  useEffect(() => {
    setEditingAddress(false)
  }, [activeSessionId])

  // 同步当前激活标签页 URL 到地址栏（未处于手动编辑时）
  useEffect(() => {
    if (!editingAddress) {
      setAddressDraft(activeUrl)
    }
  }, [activeUrl, activeTab?.id, editingAddress])

  // Cmd+L 聚焦地址栏
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'l'
      ) {
        event.preventDefault()
        omniboxRef.current?.focus()
        omniboxRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleStageSizeChange = useCallback((size: { width: number; height: number }) => {
    setBrowserStageSize(size)
  }, [])

  // 跟踪 DOM 视口区域并把逻辑坐标与缩放比例同步到 Rust 子 Webview
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || panelResizing) {
      return
    }
    const rect = el.getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1) {
      const left = Math.ceil(rect.left)
      const top = Math.ceil(rect.top)
      setBrowserPanelBounds(
        {
          x: left,
          y: top,
          width: Math.max(1, Math.floor(rect.right) - left),
          height: Math.max(1, Math.floor(rect.bottom) - top),
        },
        stageFit?.zoom ?? activeTab?.zoom ?? 1
      )
    }
  }, [
    activeSessionId,
    storedWidth,
    panelResizing,
    activeTab?.id,
    activeTab?.zoom,
    stageFit?.boxWidth,
    stageFit?.boxHeight,
    stageFit?.zoom,
  ])

  if (!isDesktopApp) {
    return null
  }

  const showSnapshotFallback =
    Boolean(activeTab?.snapshotUrl) && (panelAnimating || overlayLocks > 0 || panelResizing)
  const isHttps = activeUrl.startsWith('https://')

  return (
    <>
      <div className={chrome.header}>
        <div className={chrome.topRow} data-tauri-drag-region>
          <div className={chrome.tabsScroll} role="tablist" data-tauri-drag-region>
            {tabs.map((tab) => {
              const active = tab.id === activeTab?.id
              const title = displayTabTitle(tab.url, tab.title, t('browserNewTab'))
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  className={clsx(chrome.tab, active && chrome.tabActive)}
                  onClick={() => void switchBrowserTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void switchBrowserTab(tab.id)
                    }
                  }}
                >
                  <span className={chrome.tabIcon}>
                    {tab.isLoading ? (
                      <span className={styles.tabSpinner} />
                    ) : (
                      <IconGlobeLanguageOutline14 />
                    )}
                  </span>
                  <span className={chrome.tabTitle}>{title}</span>
                  <button
                    type="button"
                    className={chrome.tabClose}
                    aria-label={t('browserCloseTab')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void closeBrowserTab(tab.id)
                    }}
                  >
                    <IconCloseOutline16 />
                  </button>
                </div>
              )
            })}
            <IconButton
              size="xs"
              icon={<IconPlusOutline14 />}
              tooltip={t('browserNewTab')}
              tooltipPlacement="bottom"
              onClick={() =>
                activeSessionId &&
                void createBrowserTab('about:blank', {
                  sessionId: activeSessionId,
                  activate: true,
                })
              }
            />
          </div>
          <div className={panelStyles.topActions}>
            {hasLastSearch ? (
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
            ) : null}
            {topActions}
            <IconButton
              size="xs"
              icon={<IconCloseOutline16 />}
              tooltip={t('closeBrowser')}
              tooltipPlacement="bottom"
              onClick={() => activeSessionId && void closeBrowserPanel(activeSessionId)}
            />
          </div>
        </div>
        <div className={chrome.toolbar}>
          <div className={styles.navGroup}>
            <IconButton
              size="xs"
              icon={<IconChevronLeftOutline14 />}
              tooltip={t('browserBack')}
              disabled={!activeTab?.canGoBack}
              onClick={() => activeTab && void runBrowserHistory(activeTab.id, 'back')}
            />
            <IconButton
              size="xs"
              icon={<IconChevronRightOutline14 />}
              tooltip={t('browserForward')}
              disabled={!activeTab?.canGoForward}
              onClick={() => activeTab && void runBrowserHistory(activeTab.id, 'forward')}
            />
            <IconButton
              size="xs"
              icon={activeTab?.isLoading ? <IconCloseOutline16 /> : <IconRefreshOutline16 />}
              tooltip={activeTab?.isLoading ? t('browserStopLoad') : t('browserReload')}
              disabled={!activeUrl}
              onClick={() =>
                activeTab &&
                void runBrowserHistory(activeTab.id, activeTab.isLoading ? 'stop' : 'reload')
              }
            />
          </div>
          <form
            className={styles.omniboxForm}
            onSubmit={(event) => {
              event.preventDefault()
              if (!activeTab) {
                return
              }
              setEditingAddress(false)
              omniboxRef.current?.blur()
              void navigateBrowserTab(activeTab.id, addressDraft, 'user').catch(() => {})
            }}
          >
            <span className={styles.omniboxIcon}>
              {isHttps ? <IconLockOutline12 /> : <IconGlobeLanguageOutline14 />}
            </span>
            <input
              ref={omniboxRef}
              type="text"
              className={styles.omniboxInput}
              aria-label={t('browserAddressPlaceholder')}
              placeholder={t('browserAddressPlaceholder')}
              value={addressDraft}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onFocus={(event) => {
                setEditingAddress(true)
                event.currentTarget.select()
              }}
              onBlur={() => setEditingAddress(false)}
              onChange={(event) => setAddressDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setEditingAddress(false)
                  setAddressDraft(activeUrl)
                  event.currentTarget.blur()
                }
              }}
            />
            {activeTab?.isLoading ? <span className={styles.loadProgress} /> : null}
          </form>
          {controlling && controllingSessionId === activeSessionId ? (
            <button
              type="button"
              className={styles.agentPill}
              title={controllingAction ?? t('browserControlling')}
              onClick={() => {
                if (controllingSessionId) {
                  stopReply(controllingSessionId)
                }
              }}
            >
              <span className={styles.agentDot} />
              <span className={styles.agentLabel}>
                {controllingAction || t('browserControlling')}
              </span>
              <span className={styles.agentStop}>{t('browserTakeOver')}</span>
            </button>
          ) : null}
          <ViewportMenu
            host={stageHost}
            viewport={activeViewport}
            zoom={stageFit?.zoom ?? activeTab?.zoom ?? 1}
            disabled={!activeTab}
            onSelect={(next) => {
              if (activeTab) {
                void setBrowserTabViewport(activeTab.id, next)
              }
            }}
          />
          {activeUrl ? (
            <IconButton
              size="xs"
              icon={<IconOpenExternalOutline14 />}
              tooltip={t('browserOpenExternal')}
              onClick={() => void openExternalUrl(activeUrl)}
            />
          ) : null}
          <Menu
            options={[
              {
                key: 'clear-data',
                label: t('browserClearSiteData'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: () => activeTab && void clearBrowserTabData(activeTab.id),
              },
              ...(process.env.NODE_ENV !== 'production'
                ? [
                    {
                      key: 'devtools',
                      label: t('browserOpenDevtools'),
                      icon: <IconBrowserOutline14 />,
                      onSelect: () => activeTab && void openBrowserTabDevtools(activeTab.id),
                    },
                  ]
                : []),
            ]}
          >
            {({ toggle }) => (
              <IconButton
                size="xs"
                icon={<IconEllipsisOutline16 />}
                tooltip={t('browserMoreActions')}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      </div>

      <StageFrame
        host={stageHost}
        viewport={activeViewport}
        onStageSizeChange={handleStageSizeChange}
        onFitChange={setStageFit}
        onViewportResizeHoverStart={() => void refreshActiveTabSnapshot()}
        onViewportCommit={(next) =>
          activeTab
            ? setBrowserTabViewport(activeTab.id, next, { preserveSnapshot: true })
            : undefined
        }
        banner={
          activeTab?.error ? <div className={panelStyles.errorBanner}>{activeTab.error}</div> : null
        }
      >
        {(fit, { viewport: liveViewport }) => (
          <>
            <div ref={viewportRef} className={styles.viewport} />
            {!activeUrl ? (
              <div className={panelStyles.emptyState}>
                <div className={panelStyles.emptyIcon}>
                  <IconBrowserOutline14 />
                </div>
                <div className={panelStyles.emptyTitle}>{t('browserEmptyTitle')}</div>
                <div className={panelStyles.emptyDesc}>{t('browserEmptyDescription')}</div>
                {liveViewport ? (
                  <div className={styles.emptyViewportTag}>
                    {liveViewport.width}×{liveViewport.height}
                    {fit && Math.round(fit.zoom * 100) < 100
                      ? ` · ${Math.round(fit.zoom * 100)}%`
                      : ''}
                  </div>
                ) : null}
              </div>
            ) : null}
            {showSnapshotFallback && activeTab?.snapshotUrl ? (
              <img
                src={activeTab.snapshotUrl}
                className={clsx(
                  styles.snapshotFallback,
                  hasCustomViewport && styles.snapshotFallbackFit
                )}
                style={
                  !hasCustomViewport && activeTab.snapshotWidth && activeTab.snapshotHeight
                    ? { width: activeTab.snapshotWidth, height: activeTab.snapshotHeight }
                    : undefined
                }
                alt=""
              />
            ) : null}
          </>
        )}
      </StageFrame>
    </>
  )
}
