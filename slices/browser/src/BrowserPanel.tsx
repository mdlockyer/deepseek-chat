import { fitViewportToStage, StageFrame, ViewportMenu } from '@deepseek-chat/lib-stage'
import {
  Banner,
  EmptyState,
  IconBrowserOutline14,
  IconButton,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEllipsisOutline16,
  IconGlobeLanguageOutline14,
  IconLockOutline12,
  IconPlusOutline14,
  IconRefreshOutline16,
  IconTrashOutline16,
  Menu,
  Spinner,
} from '@deepseek-chat/lib-ui'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import chrome from './BrowserChrome.module.css'
import { browserMessages } from './messages.js'
import { EMPTY_SESSION_BROWSER_STATE, isHttpUrl, type BrowserState } from './state.js'
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

export type BrowserPanelDeps = {
  readonly panel: PanelSlot
  readonly desktop: boolean
  readonly openExternal: (url: string) => Promise<void>
}

/** 右侧内置浏览器面板内容（托管在共享 SidePanel 壳层内） */
export const createBrowserPanel = (state: BrowserState, deps: BrowserPanelDeps) => {
  const {
    clearBrowserTabData,
    closeBrowserPanel,
    closeBrowserTab,
    createBrowserTab,
    navigateBrowserTab,
    openBrowserTabDevtools,
    refreshActiveTabSnapshot,
    runBrowserHistory,
    setBrowserPanelBounds,
    setBrowserStageSize,
    setBrowserTabViewport,
    switchBrowserTab,
    useBrowserStore,
  } = state

  const BrowserPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
    const t = browserMessages.useTranslate()
    const activeSessionId = useBrowserStore((state) => state.activeSessionId)
    const sessionBrowser = useBrowserStore((state) =>
      state.activeSessionId && Object.hasOwn(state.sessions, state.activeSessionId)
        ? state.sessions[state.activeSessionId]
        : EMPTY_SESSION_BROWSER_STATE
    )
    const { tabs, activeTabId } = sessionBrowser
    const overlayLocked = deps.panel.useLayout((layout) => layout.overlayLocked)
    const panelAnimating = deps.panel.useLayout((layout) => layout.animating)
    const panelResizing = deps.panel.useLayout((layout) => layout.resizing)
    const storedWidth = deps.panel.useLayout((layout) => layout.width)
    const stageSize = deps.panel.useStageSize()

    const viewportRef = useRef<HTMLDivElement>(null)
    const omniboxRef = useRef<HTMLInputElement>(null)
    const [addressDraft, setAddressDraft] = useState('')
    const agentAddress = useBrowserStore((state) => state.agentAddress)
    const [editingAddress, setEditingAddress] = useState(false)

    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null
    const activeUrl = activeTab && isHttpUrl(activeTab.url) ? activeTab.url : ''
    const activeViewport = activeTab?.viewport ?? null
    const hasCustomViewport = activeViewport !== null
    const stageWidth = stageSize?.width ?? null
    const stageHeight = stageSize?.height ?? null
    const currentFit = useMemo(() => {
      if (stageWidth === null || stageHeight === null) {
        return null
      }
      return fitViewportToStage(activeViewport, stageWidth, stageHeight)
    }, [activeViewport, stageWidth, stageHeight])
    const resolvedZoom = currentFit?.zoom ?? activeTab?.zoom ?? 1

    const panelAnimatingRef = useRef(panelAnimating)
    panelAnimatingRef.current = panelAnimating
    const resolvedZoomRef = useRef(resolvedZoom)
    resolvedZoomRef.current = resolvedZoom

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

    const measureAndSyncBounds = useCallback((force = false) => {
      const el = viewportRef.current
      if (!el || panelAnimatingRef.current) {
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
          resolvedZoomRef.current,
          { force }
        )
      }
    }, [])

    // 持续监听视口框、舞台容器和窗口尺寸变化，实时同步逻辑坐标与缩放比例
    useLayoutEffect(() => {
      const el = viewportRef.current
      if (!el) {
        return
      }
      const onResize = () => measureAndSyncBounds(false)
      const onWindowResize = () => measureAndSyncBounds(true)
      const observer = new ResizeObserver(onResize)
      observer.observe(el)
      const stageCanvas = el.parentElement?.parentElement?.parentElement
      if (stageCanvas && stageCanvas !== el) {
        observer.observe(stageCanvas)
      }
      window.addEventListener('resize', onWindowResize)
      return () => {
        observer.disconnect()
        window.removeEventListener('resize', onWindowResize)
      }
    }, [measureAndSyncBounds])

    // 跟踪 DOM 视口区域并把逻辑坐标与缩放比例同步到 Rust 子 Webview
    useLayoutEffect(() => {
      measureAndSyncBounds(false)
    }, [
      measureAndSyncBounds,
      activeSessionId,
      storedWidth,
      panelAnimating,
      panelResizing,
      overlayLocked,
      activeTab?.id,
      activeViewport?.width,
      activeViewport?.height,
      stageWidth,
      stageHeight,
      currentFit?.boxWidth,
      currentFit?.boxHeight,
      resolvedZoom,
    ])

    if (!deps.desktop) {
      return null
    }

    const showSnapshotFallback =
      Boolean(activeTab?.snapshotUrl) && (panelAnimating || overlayLocked || panelResizing)
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
                    data-agent-target={`tab:${tab.id}`}
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
                        <Spinner size="sm" className={styles.tabSpinner} />
                      ) : (
                        <IconGlobeLanguageOutline14 />
                      )}
                    </span>
                    <span className={chrome.tabTitle}>{title}</span>
                    <button
                      type="button"
                      className={chrome.tabClose}
                      aria-label={t('browserCloseTab')}
                      data-agent-target={`close:${tab.id}`}
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
                data-agent-target="new-tab"
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
            <div className={chrome.topActions}>
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
                data-agent-target="back"
                tooltip={t('browserBack')}
                disabled={!activeTab?.canGoBack}
                onClick={() => activeTab && void runBrowserHistory(activeTab.id, 'back')}
              />
              <IconButton
                size="xs"
                icon={<IconChevronRightOutline14 />}
                data-agent-target="forward"
                tooltip={t('browserForward')}
                disabled={!activeTab?.canGoForward}
                onClick={() => activeTab && void runBrowserHistory(activeTab.id, 'forward')}
              />
              <IconButton
                size="xs"
                icon={activeTab?.isLoading ? <IconCloseOutline16 /> : <IconRefreshOutline16 />}
                data-agent-target="reload"
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
                value={
                  agentAddress && agentAddress.tabId === activeTab?.id
                    ? agentAddress.text
                    : addressDraft
                }
                data-agent-target="address"
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
            <ViewportMenu
              host={deps.panel}
              viewport={activeViewport}
              zoom={resolvedZoom}
              disabled={!activeTab}
              onSelect={(next) => {
                if (activeTab) {
                  void setBrowserTabViewport(activeTab.id, next)
                }
              }}
            />
            <Menu
              options={[
                ...(activeUrl
                  ? [
                      {
                        key: 'open-external',
                        label: t('browserOpenExternal'),
                        icon: <IconGlobeLanguageOutline14 />,
                        onSelect: () => void deps.openExternal(activeUrl),
                      },
                    ]
                  : []),
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
          host={deps.panel}
          viewport={activeViewport}
          onStageSizeChange={handleStageSizeChange}
          onViewportResizeHoverStart={() => void refreshActiveTabSnapshot()}
          onViewportCommit={(next) =>
            activeTab
              ? setBrowserTabViewport(activeTab.id, next, { preserveSnapshot: true })
              : undefined
          }
          banner={
            activeTab?.error ? (
              <Banner tone="error" className={styles.errorBanner}>
                {activeTab.error}
              </Banner>
            ) : null
          }
        >
          {(fit, { viewport: liveViewport }) => (
            <>
              <div ref={viewportRef} className={styles.viewport} data-browser-viewport="" />
              {!activeUrl ? (
                <div className={styles.emptyOverlay}>
                  <EmptyState
                    compact={hasCustomViewport}
                    icon={<IconBrowserOutline14 />}
                    title={t('browserEmptyTitle')}
                    description={t('browserEmptyDescription')}
                    action={
                      liveViewport ? (
                        <div className={styles.emptyViewportTag}>
                          {liveViewport.width}×{liveViewport.height}
                          {fit && Math.round(fit.zoom * 100) < 100
                            ? ` · ${Math.round(fit.zoom * 100)}%`
                            : ''}
                        </div>
                      ) : null
                    }
                  />
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
  return BrowserPanel
}
