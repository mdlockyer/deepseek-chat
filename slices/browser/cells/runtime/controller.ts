import { fitViewportToStage, type StageFit, type ViewportSpec } from '@deepseek-chat/lib-stage'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import { create } from 'zustand'
import {
  boundsEqual,
  commitNativeSync,
  DEFAULT_BROWSER_BOUNDS,
  EMPTY_NATIVE_SYNC_CACHE,
  findTabOwner,
  getActiveSessionTabs,
  getActiveTab,
  getSessionTabs,
  INITIAL_BROWSER_STATE,
  invalidateNativeSyncCache,
  isBrowserWebviewVisible,
  isHttpUrl,
  isNativeGeometryStale,
  MAX_LIVE_NATIVE_TABS,
  NO_HOST,
  normalizeOmniboxInput,
  planNativeSync,
  projectSessionBrowser,
  reduceBrowser,
  selectEvictableNativeTabs,
  type BrowserBounds,
  type BrowserController,
  type BrowserHost,
  type BrowserKernelAction,
  type BrowserKernelState,
  type BrowserTab,
  type NativeSyncCache,
  type SessionBrowserState,
} from '../../kernel/index.js'
import { createNavWaitTracker } from './navWait.js'

export type BrowserControllerDeps = {
  /** Desktop host; `null` on the web, where the browser is unavailable. */
  readonly host: BrowserHost | null
  /** This slice's slot in the app's right-hand panel. */
  readonly panel: PanelSlot
  readonly allowLocalhost: { get(): boolean; subscribe(listener: () => void): () => void }
  readonly openExternal: (url: string) => Promise<void>
  readonly notify: {
    navigationBlocked(url: string, reason: string): void
    downloadBlocked(reason: string): void
  }
  readonly newId: () => string
}

const reportHostError = (action: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[browser] ${action} failed:`, error)
}

export const createBrowserController = (deps: BrowserControllerDeps): BrowserController => {
  const desktop = deps.host !== null
  const native = deps.host ?? NO_HOST
  const { panel } = deps

  const useBrowserStore = create<BrowserKernelState>(() => INITIAL_BROWSER_STATE)
  const { getState: get, setState } = useBrowserStore
  const dispatch = (action: BrowserKernelAction) => {
    setState((prev) => reduceBrowser(prev, action))
  }

  const nativeCreated = new Set<string>()
  const pendingCreates = new Map<string, Promise<void>>()
  const navWait = createNavWaitTracker(get)
  let eventsBound = false

  let nativeSyncRunning = false
  let nativeSyncDirty = false
  let nativeSyncForceBounds = false
  let nativeSyncWaiters: (() => void)[] = []
  let syncCache: NativeSyncCache = EMPTY_NATIVE_SYNC_CACHE

  const shouldShowNativeWebview = (state: BrowserKernelState): boolean =>
    isBrowserWebviewVisible(
      state,
      panel.getLayout(),
      desktop,
      (tabId) => nativeCreated.has(tabId),
      panel.isOpen(state.activeSessionId)
    )

  const syncNativeVisibility = (options: { forceBounds?: boolean } = {}): Promise<void> => {
    if (!desktop) {
      return Promise.resolve()
    }
    nativeSyncDirty = true
    if (options.forceBounds) {
      nativeSyncForceBounds = true
    }
    const done = new Promise<void>((resolve) => {
      nativeSyncWaiters.push(resolve)
    })
    if (nativeSyncRunning) {
      return done
    }
    nativeSyncRunning = true
    void (async () => {
      try {
        while (nativeSyncDirty) {
          nativeSyncDirty = false
          const forceBounds = nativeSyncForceBounds
          nativeSyncForceBounds = false
          const state = get()
          const cmd = planNativeSync({
            state,
            layout: panel.getLayout(),
            desktop,
            isActiveRightPanel: panel.isOpen(state.activeSessionId),
            isNativeCreated: (tabId) => nativeCreated.has(tabId),
            cache: syncCache,
            forceBounds,
          })
          if (cmd.kind === 'noop') {
            continue
          }
          let succeeded = true
          try {
            if (cmd.kind === 'hide') {
              await native.setVisible(false)
            } else if (cmd.kind === 'setActiveTab') {
              await native.setActiveTab(cmd.tabId, cmd.bounds, cmd.visible, cmd.zoom)
            } else {
              await native.setBounds(cmd.bounds, cmd.zoom)
            }
          } catch (error) {
            succeeded = false
            reportHostError(`native sync (${cmd.kind})`, error)
          }
          syncCache = commitNativeSync(syncCache, cmd, succeeded)
        }
      } finally {
        nativeSyncRunning = false
        const waiters = nativeSyncWaiters
        nativeSyncWaiters = []
        for (const resolve of waiters) {
          resolve()
        }
      }
    })()
    return done
  }

  const bindBrowserEvents = () => {
    if (!desktop || eventsBound) {
      return () => {}
    }
    eventsBound = true
    void native.setOptions(deps.allowLocalhost.get()).catch((error) => {
      reportHostError('send localhost option', error)
    })
    let allowLocalhost = deps.allowLocalhost.get()
    const unsubSettings = deps.allowLocalhost.subscribe(() => {
      const next = deps.allowLocalhost.get()
      if (next !== allowLocalhost) {
        allowLocalhost = next
        void native.setOptions(next).catch((error) => {
          reportHostError('update localhost option', error)
        })
      }
    })

    const unlistenState = native.onState((payload) => {
      dispatch({ type: 'applyHostTabState', payload })
      if (payload.isLoading === false) {
        navWait.markLoadCompleted(payload.tabId)
        void syncNativeVisibility()
      }
      if (payload.isLoading !== null || Boolean(payload.url)) {
        navWait.notifyNavListeners(payload.tabId)
      }
    })

    const unlistenNewTab = native.onNewTabRequested(({ tabId, url }) => {
      const state = get()
      const ownerId = findTabOwner(state, tabId)?.sessionId ?? state.activeSessionId
      if (!ownerId) {
        return
      }
      void openUrlInBrowserPanel(url, {
        sessionId: ownerId,
        newTab: true,
        initiator: state.control.kind === 'controlling' ? 'model' : 'user',
      })
    })

    const unlistenNavBlocked = native.onNavigationBlocked(({ url, reason }) => {
      deps.notify.navigationBlocked(url, reason)
    })

    const unlistenDlBlocked = native.onDownloadBlocked(({ reason }) => {
      deps.notify.downloadBlocked(reason)
    })

    let prevLayout = panel.getLayout()
    const unsubSidePanel = panel.subscribe(() => {
      const layout = panel.getLayout()
      const overlayLockEngaged = layout.overlayLocked && !prevLayout.overlayLocked
      const resizingEnded = !layout.resizing && prevLayout.resizing
      const current = get()
      const isOpenForActive = panel.isOpen(current.activeSessionId)
      const wasVisibleBeforeLock =
        overlayLockEngaged &&
        isBrowserWebviewVisible(
          current,
          prevLayout,
          desktop,
          (tabId) => nativeCreated.has(tabId),
          isOpenForActive
        )
      if (resizingEnded && current.activeSessionId) {
        dispatch({ type: 'clearActiveTabSnapshot', sessionId: current.activeSessionId })
      }
      prevLayout = layout
      if (wasVisibleBeforeLock) {
        void refreshActiveTabSnapshot().finally(() => {
          void syncNativeVisibility()
        })
      } else {
        void syncNativeVisibility()
      }
    })

    return () => {
      eventsBound = false
      unsubSidePanel()
      unsubSettings()
      unlistenState()
      unlistenNewTab()
      unlistenNavBlocked()
      unlistenDlBlocked()
    }
  }

  const setActiveBrowserSession = (sessionId: string | null) => {
    const state = get()
    if (state.activeSessionId === sessionId) {
      return
    }
    const nextOpen = sessionId !== null && panel.isOpen(sessionId)
    dispatch({ type: 'setActiveSession', sessionId })
    const nextTab = sessionId ? getActiveTab(get(), sessionId) : null
    if (
      nextOpen &&
      nextTab &&
      isHttpUrl(nextTab.url) &&
      desktop &&
      !nativeCreated.has(nextTab.id)
    ) {
      void ensureNativeTab(nextTab.id)
    } else {
      void syncNativeVisibility()
    }
  }

  const disposeSessionBrowser = async (sessionId: string): Promise<void> => {
    const state = get()
    const session = getSessionTabs(state, sessionId)
    const tabIds = session.tabs.map((t) => t.id)
    const wasActive = state.activeSessionId === sessionId
    dispatch({ type: 'disposeSession', sessionId })
    for (const tabId of tabIds) {
      navWait.clearTab(tabId)
      pendingCreates.delete(tabId)
      if (nativeCreated.delete(tabId) && desktop) {
        syncCache = invalidateNativeSyncCache(syncCache, tabId)
        await native.closeTab(tabId).catch((error) => {
          reportHostError(`close native tab ${tabId}`, error)
        })
      }
    }
    if (wasActive) {
      await syncNativeVisibility()
    }
  }

  const clearAllSessionBrowsers = async (): Promise<void> => {
    const state = get()
    const allTabIds = Object.values(state.sessions).flatMap((session) =>
      session.tabs.map((tab) => tab.id)
    )
    dispatch({ type: 'clearAllSessions' })
    for (const tabId of allTabIds) {
      navWait.clearTab(tabId)
      pendingCreates.delete(tabId)
      if (nativeCreated.delete(tabId) && desktop) {
        await native.closeTab(tabId).catch((error) => {
          reportHostError(`close native tab ${tabId}`, error)
        })
      }
    }
    syncCache = EMPTY_NATIVE_SYNC_CACHE
    if (desktop) {
      try {
        await native.setVisible(false)
        syncCache = commitNativeSync(syncCache, { kind: 'hide' }, true)
      } catch (error) {
        reportHostError('hide native webviews on clearAll', error)
        syncCache = EMPTY_NATIVE_SYNC_CACHE
      }
    }
  }

  const evictInactiveNativeWebviewsIfNeeded = async () => {
    if (!desktop) {
      return
    }
    const victims = selectEvictableNativeTabs(get(), nativeCreated, MAX_LIVE_NATIVE_TABS)
    for (const existingId of victims) {
      nativeCreated.delete(existingId)
      await native.closeTab(existingId).catch((error) => {
        reportHostError(`evict native tab ${existingId}`, error)
      })
    }
  }

  const ensureNativeTab = async (
    tabId: string,
    initiator: 'user' | 'model' = 'user'
  ): Promise<void> => {
    if (!desktop) {
      throw new Error('Built-in browser is only available in the desktop app.')
    }
    if (nativeCreated.has(tabId)) {
      return
    }
    const existingPromise = pendingCreates.get(tabId)
    if (existingPromise) {
      return existingPromise
    }
    const owner = findTabOwner(get(), tabId)
    if (!owner) {
      throw new Error(`Browser tab ${tabId} not found.`)
    }
    const { tab } = owner
    const promise = (async () => {
      await evictInactiveNativeWebviewsIfNeeded()
      const state = get()
      const initialUrl = isHttpUrl(tab.url) ? tab.url : 'about:blank'
      await native.createTab({
        tabId,
        url: initialUrl,
        bounds: state.bounds ?? DEFAULT_BROWSER_BOUNDS,
        visible: false,
        zoom: tab.zoom,
        initiator,
      })
      nativeCreated.add(tabId)
    })().finally(() => {
      pendingCreates.delete(tabId)
    })
    pendingCreates.set(tabId, promise)
    await promise
    await syncNativeVisibility()
  }

  const createBrowserTab = async (
    url = 'about:blank',
    options: { sessionId?: string; activate?: boolean; initiator?: 'user' | 'model' } = {}
  ): Promise<BrowserTab> => {
    const state = get()
    const sessionId = options.sessionId ?? state.activeSessionId
    if (!sessionId) {
      throw new Error('Start or select a chat session before opening browser tabs.')
    }
    const activate = options.activate ?? true
    const initiator = options.initiator ?? 'user'
    const id = `tab-${deps.newId()}`
    const normalized =
      url === 'about:blank'
        ? 'about:blank'
        : initiator === 'model'
          ? url.trim()
          : normalizeOmniboxInput(url)
    if (initiator === 'model' && normalized !== 'about:blank' && !isHttpUrl(normalized)) {
      throw new Error(`Unsupported URL: ${normalized}. Only http:// and https:// are allowed.`)
    }
    const prevActiveTabId = getSessionTabs(state, sessionId).activeTabId
    const tab: BrowserTab = {
      id,
      url: normalized,
      title: '',
      isLoading: isHttpUrl(normalized),
      canGoBack: false,
      canGoForward: false,
      viewport: null,
      zoom: 1,
      snapshotUrl: null,
      snapshotWidth: null,
      snapshotHeight: null,
      error: null,
    }
    dispatch({ type: 'addTab', sessionId, tab, activate })
    if (isHttpUrl(normalized) && desktop) {
      try {
        await ensureNativeTab(id, initiator)
        await syncNativeVisibility()
      } catch (error) {
        dispatch({ type: 'rollbackTab', sessionId, tabId: id, restoreActiveTabId: prevActiveTabId })
        throw error
      }
    }
    return tab
  }

  const closeBrowserTab = async (tabId: string): Promise<void> => {
    const owner = findTabOwner(get(), tabId)
    if (!owner) {
      return
    }
    const { sessionId, session } = owner
    const closingLast = session.tabs.length <= 1
    if (closingLast && panel.isOpen(sessionId)) {
      panel.close(sessionId)
    }
    dispatch({ type: 'closeTab', sessionId, tabId })

    navWait.clearTab(tabId)
    pendingCreates.delete(tabId)
    if (nativeCreated.delete(tabId) && desktop) {
      syncCache = invalidateNativeSyncCache(syncCache, tabId)
      await native.closeTab(tabId).catch((error) => {
        reportHostError(`close native tab ${tabId}`, error)
      })
    }
    const latest = get()
    if (latest.activeSessionId === sessionId) {
      const nextTab = getActiveTab(latest, sessionId)
      if (nextTab && isHttpUrl(nextTab.url) && desktop && !nativeCreated.has(nextTab.id)) {
        await ensureNativeTab(nextTab.id)
      }
      await syncNativeVisibility()
    }
  }

  const switchBrowserTab = async (tabId: string): Promise<void> => {
    const owner = findTabOwner(get(), tabId)
    if (!owner) {
      return
    }
    dispatch({ type: 'switchTab', sessionId: owner.sessionId, tabId })
    if (isHttpUrl(owner.tab.url) && desktop && !nativeCreated.has(tabId)) {
      await ensureNativeTab(tabId)
    }
    if (get().activeSessionId === owner.sessionId) {
      await syncNativeVisibility()
    }
  }

  const openBrowserPanel = async (sessionId?: string): Promise<boolean> => {
    const state = get()
    const targetSessionId = sessionId ?? state.activeSessionId
    if (!targetSessionId) {
      return false
    }
    const isViewing = state.activeSessionId === targetSessionId
    const wasOpen = panel.isOpen(targetSessionId)
    panel.open(targetSessionId)
    if (getSessionTabs(get(), targetSessionId).tabs.length === 0) {
      await createBrowserTab('about:blank', { sessionId: targetSessionId, activate: true })
    }
    if (wasOpen && isViewing) {
      await syncNativeVisibility()
    }
    return true
  }

  const revealBrowserPanel = async (sessionId?: string): Promise<boolean> => {
    const state = get()
    const targetSessionId = sessionId ?? state.activeSessionId
    if (!targetSessionId) {
      return false
    }
    const isViewing = state.activeSessionId === targetSessionId
    const wasOpen = panel.isOpen(targetSessionId)
    if (panel.reveal) {
      panel.reveal(targetSessionId)
    } else {
      panel.open(targetSessionId)
    }
    const isNowOpen = panel.isOpen(targetSessionId)
    if (getSessionTabs(get(), targetSessionId).tabs.length === 0) {
      await createBrowserTab('about:blank', { sessionId: targetSessionId, activate: true })
    }
    if (isNowOpen && wasOpen && isViewing) {
      await syncNativeVisibility()
    }
    return isNowOpen
  }

  const closeBrowserPanel = async (sessionId?: string): Promise<void> => {
    const state = get()
    const targetSessionId = sessionId ?? state.activeSessionId
    if (!targetSessionId) {
      return
    }
    const isViewing = state.activeSessionId === targetSessionId
    panel.close(targetSessionId)
    if (isViewing) {
      await syncNativeVisibility()
    }
  }

  const toggleBrowserPanel = async (sessionId?: string): Promise<void> => {
    const targetSessionId = sessionId ?? get().activeSessionId
    if (!targetSessionId) {
      return
    }
    if (panel.isOpen(targetSessionId)) {
      await closeBrowserPanel(targetSessionId)
    } else {
      await openBrowserPanel(targetSessionId)
    }
  }

  const setBrowserStageSize = (size: { width: number; height: number }) => {
    dispatch({ type: 'setStageSize', size })
  }

  const setBrowserPanelBounds = (
    bounds: BrowserBounds,
    zoom?: number,
    options: { force?: boolean } = {}
  ) => {
    const stateBefore = get()
    const activeBefore = getActiveTab(stateBefore)
    const boundsSame = boundsEqual(stateBefore.bounds, bounds)
    const zoomSame =
      zoom === undefined || !activeBefore || Math.abs(activeBefore.zoom - zoom) < 0.001
    if (!boundsSame || !zoomSame) {
      dispatch({ type: 'setPanelBounds', bounds, zoom })
    }
    const layout = panel.getLayout()
    if (!desktop || layout.animating || layout.resizing) {
      return
    }
    const nativeStale = isNativeGeometryStale(syncCache, bounds, zoom, Boolean(options.force))
    if (!boundsSame || !zoomSame || nativeStale) {
      void syncNativeVisibility({ forceBounds: options.force })
    }
  }

  const setBrowserTabViewport = async (
    tabId: string,
    viewport: ViewportSpec | null,
    options: { preserveSnapshot?: boolean } = {}
  ): Promise<StageFit> => {
    const state = get()
    const owner = findTabOwner(state, tabId)
    const stage = state.stageSize ?? {
      width: Math.max(320, (state.bounds?.width ?? 540) - 20),
      height: Math.max(240, (state.bounds?.height ?? 680) - 20),
    }
    const fit = fitViewportToStage(viewport, stage.width, stage.height)
    if (owner) {
      dispatch({
        type: 'setTabViewport',
        sessionId: owner.sessionId,
        tabId,
        viewport,
        zoom: fit.zoom,
        preserveSnapshot: Boolean(options.preserveSnapshot),
      })
    }
    if (desktop && nativeCreated.has(tabId)) {
      await native.setZoom(tabId, fit.zoom).catch((error) => {
        reportHostError(`set native zoom for tab ${tabId}`, error)
      })
      const activeSess = getActiveSessionTabs(get())
      if (activeSess.activeTabId === tabId) {
        await syncNativeVisibility()
      }
    }
    return fit
  }

  const refreshActiveTabSnapshot = async () => {
    if (!desktop) {
      return
    }
    const state = get()
    const layout = panel.getLayout()
    const sessionId = state.activeSessionId
    if (!sessionId || layout.animating || layout.resizing || !panel.isOpen(sessionId)) {
      return
    }
    const session = getSessionTabs(state, sessionId)
    const active = session.tabs.find((t) => t.id === session.activeTabId)
    if (!active || !isHttpUrl(active.url) || !nativeCreated.has(active.id)) {
      return
    }
    const capturedTabId = active.id
    const capturedUrl = active.url
    try {
      const snap = await native.takeSnapshot(capturedTabId, 1280)
      dispatch({
        type: 'setTabSnapshot',
        sessionId,
        tabId: capturedTabId,
        expectedUrl: capturedUrl,
        dataUrl: snap.dataUrl,
        width: snap.width,
        height: snap.height,
      })
    } catch {
      // Snapshot fallback is best-effort for overlays
    }
  }

  const navigateBrowserTab = async (
    tabId: string,
    rawUrl: string,
    initiator: 'user' | 'model' = 'user'
  ): Promise<string> => {
    const owner = findTabOwner(get(), tabId)
    if (!owner) {
      throw new Error(`Browser tab ${tabId} not found.`)
    }
    const { sessionId } = owner
    const normalized = initiator === 'user' ? normalizeOmniboxInput(rawUrl) : rawUrl.trim()
    if (normalized === 'about:blank') {
      dispatch({ type: 'setTabBlank', sessionId, tabId })
      await syncNativeVisibility()
      return 'about:blank'
    }
    dispatch({ type: 'startTabNavigation', sessionId, tabId, url: normalized })
    await ensureNativeTab(tabId)
    try {
      const finalUrl = await native.navigate(tabId, normalized, initiator)
      dispatch({ type: 'finishTabNavigation', sessionId, tabId, finalUrl })
      await syncNativeVisibility()
      return finalUrl
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dispatch({ type: 'failTabNavigation', sessionId, tabId, error: message })
      throw error
    }
  }

  const openUrlInBrowserPanel = async (
    url: string,
    options: { sessionId?: string; newTab?: boolean; initiator?: 'user' | 'model' } = {}
  ): Promise<BrowserTab | null> => {
    const targetSessionId = options.sessionId ?? get().activeSessionId
    if (!targetSessionId) {
      await deps.openExternal(url)
      return null
    }
    await openBrowserPanel(targetSessionId)
    const session = getSessionTabs(get(), targetSessionId)
    const active = session.tabs.find((t) => t.id === session.activeTabId)
    let targetTab: BrowserTab
    if (!options.newTab && active && (!isHttpUrl(active.url) || options.initiator !== 'user')) {
      targetTab = active
      await navigateBrowserTab(targetTab.id, url, options.initiator ?? 'user')
    } else if (options.newTab && active && !isHttpUrl(active.url)) {
      targetTab = active
      await navigateBrowserTab(targetTab.id, url, options.initiator ?? 'user')
    } else if (options.newTab || !active) {
      targetTab = await createBrowserTab(url, {
        sessionId: targetSessionId,
        activate: true,
        initiator: options.initiator ?? 'user',
      })
    } else {
      targetTab = active
      await navigateBrowserTab(targetTab.id, url, options.initiator ?? 'user')
    }
    return (
      getSessionTabs(get(), targetSessionId).tabs.find((t) => t.id === targetTab.id) ?? targetTab
    )
  }

  const runBrowserHistory = async (
    tabId: string,
    action: 'back' | 'forward' | 'reload' | 'stop'
  ): Promise<void> => {
    if (!nativeCreated.has(tabId)) {
      return
    }
    const owner = findTabOwner(get(), tabId)
    if (!owner) {
      return
    }
    if (action === 'reload') {
      dispatch({
        type: 'setTabLoading',
        sessionId: owner.sessionId,
        tabId,
        isLoading: true,
        clearError: true,
      })
    } else if (action === 'stop') {
      dispatch({ type: 'setTabLoading', sessionId: owner.sessionId, tabId, isLoading: false })
      navWait.resolveLoadWaiters(tabId)
    }
    await native.history(tabId, action)
    if (action === 'back' || action === 'forward') {
      const info = await native.getState(tabId).catch(() => null)
      if (info) {
        dispatch({
          type: 'applyTabHistoryState',
          sessionId: owner.sessionId,
          tabId,
          url: info.url,
          canGoBack: info.canGoBack,
          canGoForward: info.canGoForward,
        })
        if (info.url) {
          navWait.notifyNavListeners(tabId)
        }
      }
    }
  }

  const clearBrowserTabData = async (tabId: string): Promise<void> => {
    if (nativeCreated.has(tabId)) {
      await native.clearData(tabId)
      await native.history(tabId, 'reload').catch((error) => {
        reportHostError(`reload tab ${tabId} after clearData`, error)
      })
    }
  }

  const openBrowserTabDevtools = async (tabId: string): Promise<void> => {
    if (nativeCreated.has(tabId)) {
      await native.openDevtools(tabId)
    }
  }

  const setBrowserControlling = (
    controlling: boolean,
    action: string | null = null,
    sessionId: string | null = null
  ) => {
    dispatch({
      type: 'setControl',
      control:
        controlling && sessionId !== null
          ? { kind: 'controlling', sessionId, action }
          : { kind: 'idle' },
    })
  }

  const getActiveBrowserTab = (sessionId?: string | null): BrowserTab | null =>
    getActiveTab(get(), sessionId)

  const setAgentAddress = (tabId: string, text: string | null) => {
    dispatch({ type: 'setAgentAddress', tabId, text })
  }

  /** Whether `tabId` is the page the reader can see right now. */
  const isTabOnScreen = (tabId: string): boolean =>
    shouldShowNativeWebview(get()) && getActiveBrowserTab()?.id === tabId

  const getSession = (sessionId: string): SessionBrowserState =>
    projectSessionBrowser(get(), sessionId, panel.isOpen(sessionId))

  return {
    getState: get,
    useState: useBrowserStore,
    getSession,
    syncNativeVisibility,
    bindBrowserEvents,
    setActiveBrowserSession,
    disposeSessionBrowser,
    clearAllSessionBrowsers,
    ensureNativeTab,
    createBrowserTab,
    closeBrowserTab,
    switchBrowserTab,
    openBrowserPanel,
    revealBrowserPanel,
    closeBrowserPanel,
    toggleBrowserPanel,
    setBrowserStageSize,
    setBrowserPanelBounds,
    setBrowserTabViewport,
    refreshActiveTabSnapshot,
    navigateBrowserTab,
    openUrlInBrowserPanel,
    runBrowserHistory,
    clearBrowserTabData,
    openBrowserTabDevtools,
    beginNavigationWatch: navWait.beginNavigationWatch,
    waitForNavigation: navWait.waitForNavigation,
    waitForTabLoad: navWait.waitForTabLoad,
    setBrowserControlling,
    getActiveBrowserTab,
    isTabOnScreen,
    setAgentAddress,
  }
}
