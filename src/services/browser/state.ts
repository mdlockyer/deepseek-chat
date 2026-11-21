import { create } from 'zustand'
import {
  browserClearData,
  browserCloseTab,
  browserCreateTab,
  browserGetState,
  browserHistory,
  browserNavigate,
  browserOpenDevtools,
  browserSetActiveTab,
  browserSetBounds,
  browserSetOptions,
  browserSetVisible,
  browserSetZoom,
  browserTakeSnapshot,
  isDesktopApp,
  onBrowserDownloadBlocked,
  onBrowserNavigationBlocked,
  onBrowserNewTabRequested,
  onBrowserState,
  openExternalUrl,
  type BrowserBounds,
} from '../../platform/desktop.js'
import { createId } from '../../utils/id.js'
import { showToast } from '../../components/base/toastState.js'
import { useBrowserPrefs } from './prefs.js'
import {
  acquireSidePanelOverlayLock,
  clampSidePanelResizeWidth,
  clearAllSidePanelSessions,
  closeRightPanel,
  disposeSidePanelSession,
  getActiveRightPanel,
  openRightPanel,
  setActiveSidePanelSession,
  setRightPanelAnimating,
  setRightPanelResizing,
  useSidePanelStore,
} from '../../app/rightPanel/state.js'
import {
  BROWSER_VIEWPORT_PRESETS,
  MIN_VIEWPORT_HEIGHT,
  MIN_VIEWPORT_WIDTH,
  MIN_VIEWPORT_ZOOM,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  clampViewportHeight,
  clampViewportWidth,
  fitViewportToStage,
  parseAspectRatio,
  resolveViewportRequest,
  type BrowserStageFit,
  type BrowserViewportPreset,
  type BrowserViewportSpec,
} from '@deepseek-chat/spine/design'

export {
  BROWSER_VIEWPORT_PRESETS,
  MIN_VIEWPORT_HEIGHT,
  MIN_VIEWPORT_WIDTH,
  MIN_VIEWPORT_ZOOM,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  clampViewportHeight,
  clampViewportWidth,
  fitViewportToStage,
  parseAspectRatio,
  resolveViewportRequest,
  type BrowserStageFit,
  type BrowserViewportPreset,
  type BrowserViewportSpec,
}

const MAX_LIVE_NATIVE_TABS = 14

export type BrowserTab = {
  id: string
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: BrowserViewportSpec | null
  zoom: number
  snapshotUrl: string | null
  snapshotWidth: number | null
  snapshotHeight: number | null
  error: string | null
}

export type SessionBrowserState = {
  panelOpen: boolean
  tabs: BrowserTab[]
  activeTabId: string | null
}

export const EMPTY_SESSION_BROWSER_STATE: SessionBrowserState = {
  panelOpen: false,
  tabs: [],
  activeTabId: null,
}

type BrowserStoreState = {
  activeSessionId: string | null
  sessions: Record<string, SessionBrowserState>
  panelAnimating: boolean
  panelResizing: boolean
  overlayLocks: number
  controlling: boolean
  controllingAction: string | null
  controllingSessionId: string | null
  bounds: BrowserBounds | null
  stageSize: { width: number; height: number } | null
}

const DEFAULT_BOUNDS: BrowserBounds = {
  x: 640,
  y: 96,
  width: 540,
  height: 700,
}

export const getSessionBrowser = (
  state: Pick<BrowserStoreState, 'sessions'>,
  sessionId: string | null | undefined
): SessionBrowserState =>
  sessionId && Object.hasOwn(state.sessions, sessionId)
    ? state.sessions[sessionId]
    : EMPTY_SESSION_BROWSER_STATE

export const getActiveSessionBrowser = (
  state: Pick<BrowserStoreState, 'activeSessionId' | 'sessions'>
): SessionBrowserState => getSessionBrowser(state, state.activeSessionId)

const findTabOwner = (
  state: Pick<BrowserStoreState, 'sessions'>,
  tabId: string
): { sessionId: string; session: SessionBrowserState; tab: BrowserTab } | null => {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const tab = session.tabs.find((t) => t.id === tabId)
    if (tab) {
      return { sessionId, session, tab }
    }
  }
  return null
}

export const clampBrowserResizeWidth = clampSidePanelResizeWidth

export const isBrowserWebviewVisibleState = (
  state: Pick<
    BrowserStoreState,
    'activeSessionId' | 'sessions' | 'panelAnimating' | 'panelResizing' | 'overlayLocks'
  >,
  desktop = isDesktopApp,
  isNativeCreated = (tabId: string) => nativeCreated.has(tabId),
  isActiveRightPanel = true
): boolean => {
  if (
    !desktop ||
    !state.activeSessionId ||
    !isActiveRightPanel ||
    state.panelAnimating ||
    state.panelResizing ||
    state.overlayLocks > 0
  ) {
    return false
  }
  const session = getSessionBrowser(state, state.activeSessionId)
  if (!session.panelOpen) {
    return false
  }
  const active = session.tabs.find((t) => t.id === session.activeTabId)
  return Boolean(active && isHttpUrl(active.url) && isNativeCreated(active.id))
}

export const isHttpUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Normalizes user omnibox input into a safe URL:
 * - explicit http(s):// -> preserved
 * - localhost / 127.0.0.1 / host:port / domain.tld -> http(s)://
 * - free text query -> Google search
 */
export const normalizeOmniboxInput = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return 'about:blank'
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  if (
    !/\s/.test(trimmed) &&
    (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/.*)?$/i.test(trimmed) ||
      /^[^\s.]+\.[^\s]{2,}(\/.*)?$/i.test(trimmed))
  ) {
    const scheme = /^(localhost|127\.0\.0\.1|\[::1\])/i.test(trimmed) ? 'http' : 'https'
    return `${scheme}://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

export const useBrowserStore = create<BrowserStoreState>(() => ({
  activeSessionId: null,
  sessions: {},
  panelAnimating: false,
  panelResizing: false,
  overlayLocks: 0,
  controlling: false,
  controllingAction: null,
  controllingSessionId: null,
  bounds: null,
  stageSize: null,
}))

const { getState: get, setState: set } = useBrowserStore

const nativeCreated = new Set<string>()
const pendingCreates = new Map<string, Promise<void>>()
const loadWaiters = new Map<string, Set<() => void>>()
let eventsBound = false
let onBrowserOpenCallback: (() => void) | null = null

const updateSessionBrowser = (
  sessionId: string,
  updater: (session: SessionBrowserState) => SessionBrowserState
) => {
  set((state) => {
    const prev = getSessionBrowser(state, sessionId)
    const next = updater(prev)
    if (next === prev) {
      return state
    }
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: next,
      },
    }
  })
}

export const registerBrowserOpenListener = (listener: () => void) => {
  onBrowserOpenCallback = listener
}

const resolveLoadWaiters = (tabId: string) => {
  const waiters = loadWaiters.get(tabId)
  if (!waiters) {
    return
  }
  loadWaiters.delete(tabId)
  for (const resolve of waiters) {
    resolve()
  }
}

const shouldShowNativeWebview = (state: BrowserStoreState): boolean =>
  isBrowserWebviewVisibleState(
    state,
    isDesktopApp,
    (tabId) => nativeCreated.has(tabId),
    getActiveRightPanel(state.activeSessionId) === 'browser'
  )

let visibilitySyncSeq = 0

export const syncNativeVisibility = async () => {
  if (!isDesktopApp) {
    return
  }
  const seq = ++visibilitySyncSeq
  const state = get()
  const session = getActiveSessionBrowser(state)
  const active = session.tabs.find((t) => t.id === session.activeTabId)
  const visible = shouldShowNativeWebview(state)
  if (!active || !nativeCreated.has(active.id)) {
    await browserSetVisible(false).catch(() => {})
    return
  }
  await browserSetActiveTab(active.id, state.bounds ?? DEFAULT_BOUNDS, visible).catch(() => {})
  if (seq !== visibilitySyncSeq) {
    return
  }
  if (visible && state.bounds) {
    await browserSetBounds(state.bounds, active.zoom).catch(() => {})
  }
}

export const bindBrowserEvents = () => {
  if (!isDesktopApp || eventsBound) {
    return () => {}
  }
  eventsBound = true
  void browserSetOptions(useBrowserPrefs.getState().allowLocalhost).catch(() => {})
  const unsubSettings = useBrowserPrefs.subscribe((state, prev) => {
    if (state.allowLocalhost !== prev.allowLocalhost) {
      void browserSetOptions(state.allowLocalhost).catch(() => {})
    }
  })

  const unlistenState = onBrowserState((payload) => {
    set((state) => {
      const owner = findTabOwner(state, payload.tabId)
      if (!owner) {
        return state
      }
      return {
        sessions: {
          ...state.sessions,
          [owner.sessionId]: {
            ...owner.session,
            tabs: owner.session.tabs.map((tab) => {
              if (tab.id !== payload.tabId) {
                return tab
              }
              const urlChanged = Boolean(payload.url && payload.url !== tab.url)
              return {
                ...tab,
                ...(payload.url ? { url: payload.url } : {}),
                ...(payload.title !== null ? { title: payload.title } : {}),
                ...(payload.isLoading !== null ? { isLoading: payload.isLoading } : {}),
                ...(payload.canGoBack !== null ? { canGoBack: payload.canGoBack } : {}),
                ...(payload.canGoForward !== null ? { canGoForward: payload.canGoForward } : {}),
                ...(urlChanged
                  ? { snapshotUrl: null, snapshotWidth: null, snapshotHeight: null }
                  : {}),
                error: null,
              }
            }),
          },
        },
      }
    })
    if (payload.isLoading === false) {
      resolveLoadWaiters(payload.tabId)
      void syncNativeVisibility()
    }
  })

  const unlistenNewTab = onBrowserNewTabRequested(({ tabId, url }) => {
    const state = get()
    const ownerId = findTabOwner(state, tabId)?.sessionId ?? state.activeSessionId
    if (!ownerId) {
      return
    }
    void openUrlInBrowserPanel(url, { sessionId: ownerId, newTab: true })
  })

  const unlistenNavBlocked = onBrowserNavigationBlocked(({ url, reason }) => {
    showToast({ key: 'browserNavigationBlocked', params: { url, reason }, type: 'error' })
  })

  const unlistenDlBlocked = onBrowserDownloadBlocked(({ reason }) => {
    showToast({ key: 'browserDownloadBlocked', params: { reason } })
  })

  const unsubSidePanel = useSidePanelStore.subscribe((sideState, prevSideState) => {
    let changed = false
    if (
      sideState.panelAnimating !== prevSideState.panelAnimating ||
      sideState.panelResizing !== prevSideState.panelResizing
    ) {
      set({
        panelAnimating: sideState.panelAnimating,
        panelResizing: sideState.panelResizing,
      })
      changed = true
    }
    if (sideState.activePanels !== prevSideState.activePanels) {
      const current = get()
      let nextSessions = current.sessions
      for (const [sid, session] of Object.entries(current.sessions)) {
        const activeKind = getActiveRightPanel(sid, sideState)
        if (session.panelOpen && activeKind !== 'browser') {
          if (nextSessions === current.sessions) {
            nextSessions = { ...current.sessions }
          }
          nextSessions[sid] = { ...session, panelOpen: false }
          changed = true
        }
      }
      if (nextSessions !== current.sessions) {
        set({ sessions: nextSessions })
      }
    }
    if (changed || sideState.activeSessionId !== prevSideState.activeSessionId) {
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

export const setActiveBrowserSession = (sessionId: string | null) => {
  setActiveSidePanelSession(sessionId)
  const state = get()
  if (state.activeSessionId === sessionId) {
    return
  }
  const prevOpen = getSessionBrowser(state, state.activeSessionId).panelOpen
  const nextOpen = sessionId !== null && getSessionBrowser(state, sessionId).panelOpen
  set({
    activeSessionId: sessionId,
    panelAnimating: prevOpen !== nextOpen,
  })
  const nextTab = sessionId ? getActiveBrowserTab(sessionId) : null
  if (
    nextOpen &&
    nextTab &&
    isHttpUrl(nextTab.url) &&
    isDesktopApp &&
    !nativeCreated.has(nextTab.id)
  ) {
    void ensureNativeTab(nextTab.id)
  } else {
    void syncNativeVisibility()
  }
}

export const disposeSessionBrowser = async (sessionId: string): Promise<void> => {
  disposeSidePanelSession(sessionId)
  const state = get()
  const session = getSessionBrowser(state, sessionId)
  const tabIds = session.tabs.map((t) => t.id)
  const wasActive = state.activeSessionId === sessionId
  set((current) => ({
    sessions: Object.fromEntries(
      Object.entries(current.sessions).filter(([key]) => key !== sessionId)
    ),
    ...(current.activeSessionId === sessionId
      ? { activeSessionId: null, panelAnimating: false }
      : {}),
    ...(current.controllingSessionId === sessionId
      ? { controlling: false, controllingAction: null, controllingSessionId: null }
      : {}),
  }))
  for (const tabId of tabIds) {
    resolveLoadWaiters(tabId)
    pendingCreates.delete(tabId)
    if (nativeCreated.delete(tabId) && isDesktopApp) {
      await browserCloseTab(tabId).catch(() => {})
    }
  }
  if (wasActive) {
    await syncNativeVisibility()
  }
}

export const clearAllSessionBrowsers = async (): Promise<void> => {
  clearAllSidePanelSessions()
  const state = get()
  const allTabIds = Object.values(state.sessions).flatMap((session) =>
    session.tabs.map((tab) => tab.id)
  )
  set({
    activeSessionId: null,
    sessions: {},
    panelAnimating: false,
    panelResizing: false,
    controlling: false,
    controllingAction: null,
    controllingSessionId: null,
  })
  for (const tabId of allTabIds) {
    resolveLoadWaiters(tabId)
    pendingCreates.delete(tabId)
    if (nativeCreated.delete(tabId) && isDesktopApp) {
      await browserCloseTab(tabId).catch(() => {})
    }
  }
  if (isDesktopApp) {
    await browserSetVisible(false).catch(() => {})
  }
}

const evictInactiveNativeWebviewsIfNeeded = async () => {
  if (!isDesktopApp || nativeCreated.size < MAX_LIVE_NATIVE_TABS) {
    return
  }
  const state = get()
  for (const existingId of nativeCreated) {
    if (nativeCreated.size < MAX_LIVE_NATIVE_TABS) {
      break
    }
    const owner = findTabOwner(state, existingId)
    if (
      owner &&
      (owner.sessionId === state.activeSessionId || owner.sessionId === state.controllingSessionId)
    ) {
      continue
    }
    nativeCreated.delete(existingId)
    await browserCloseTab(existingId).catch(() => {})
  }
}

export const ensureNativeTab = async (tabId: string): Promise<void> => {
  if (!isDesktopApp) {
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
    await browserCreateTab({
      tabId,
      url: initialUrl,
      bounds: state.bounds ?? DEFAULT_BOUNDS,
      visible: false,
      zoom: tab.zoom,
    })
    nativeCreated.add(tabId)
  })().finally(() => {
    pendingCreates.delete(tabId)
  })
  pendingCreates.set(tabId, promise)
  await promise
  await syncNativeVisibility()
}

export const createBrowserTab = async (
  url = 'about:blank',
  options: { sessionId?: string; activate?: boolean } = {}
): Promise<BrowserTab> => {
  const state = get()
  const sessionId = options.sessionId ?? state.activeSessionId
  if (!sessionId) {
    throw new Error('Start or select a chat session before opening browser tabs.')
  }
  const activate = options.activate ?? true
  const id = `tab-${createId()}`
  const normalized = url === 'about:blank' ? 'about:blank' : normalizeOmniboxInput(url)
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
  updateSessionBrowser(sessionId, (session) => ({
    ...session,
    tabs: [...session.tabs, tab],
    activeTabId: activate ? id : (session.activeTabId ?? id),
  }))
  if (isHttpUrl(normalized) && isDesktopApp) {
    await ensureNativeTab(id)
    await syncNativeVisibility()
  }
  return tab
}

export const closeBrowserTab = async (tabId: string): Promise<void> => {
  const state = get()
  const owner = findTabOwner(state, tabId)
  if (!owner) {
    return
  }
  const { sessionId, session } = owner
  const idx = session.tabs.findIndex((t) => t.id === tabId)
  const remaining = session.tabs.filter((t) => t.id !== tabId)
  const closingLast = remaining.length === 0
  const nextActive =
    session.activeTabId === tabId
      ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
      : session.activeTabId

  if (closingLast && getActiveRightPanel(sessionId) === 'browser') {
    closeRightPanel(sessionId, 'browser')
  }
  set((current) => {
    const currSession = getSessionBrowser(current, sessionId)
    return {
      sessions: {
        ...current.sessions,
        [sessionId]: {
          ...currSession,
          tabs: remaining,
          activeTabId: nextActive,
          panelOpen: closingLast ? false : currSession.panelOpen,
        },
      },
      ...(closingLast && current.activeSessionId === sessionId ? { panelAnimating: false } : {}),
    }
  })

  resolveLoadWaiters(tabId)
  pendingCreates.delete(tabId)
  if (nativeCreated.delete(tabId) && isDesktopApp) {
    await browserCloseTab(tabId).catch(() => {})
  }
  if (get().activeSessionId === sessionId) {
    const nextTab = remaining.find((t) => t.id === nextActive)
    if (nextTab && isHttpUrl(nextTab.url) && isDesktopApp && !nativeCreated.has(nextTab.id)) {
      await ensureNativeTab(nextTab.id)
    }
    await syncNativeVisibility()
  }
}

export const switchBrowserTab = async (tabId: string): Promise<void> => {
  const owner = findTabOwner(get(), tabId)
  if (!owner) {
    return
  }
  updateSessionBrowser(owner.sessionId, (session) => ({
    ...session,
    activeTabId: tabId,
  }))
  if (isHttpUrl(owner.tab.url) && isDesktopApp && !nativeCreated.has(tabId)) {
    await ensureNativeTab(tabId)
  }
  if (get().activeSessionId === owner.sessionId) {
    await syncNativeVisibility()
  }
}

export const openBrowserPanel = async (sessionId?: string): Promise<boolean> => {
  const state = get()
  const targetSessionId = sessionId ?? state.activeSessionId
  if (!targetSessionId) {
    return false
  }
  const isViewing = state.activeSessionId === targetSessionId
  if (isViewing) {
    onBrowserOpenCallback?.()
  }
  openRightPanel(targetSessionId, 'browser')
  const existing = getSessionBrowser(state, targetSessionId)
  const wasOpen = existing.panelOpen
  if (!wasOpen) {
    set((current) => ({
      sessions: {
        ...current.sessions,
        [targetSessionId]: {
          ...getSessionBrowser(current, targetSessionId),
          panelOpen: true,
        },
      },
      ...(current.activeSessionId === targetSessionId ? { panelAnimating: true } : {}),
    }))
  }
  if (getSessionBrowser(get(), targetSessionId).tabs.length === 0) {
    await createBrowserTab('about:blank', { sessionId: targetSessionId, activate: true })
  }
  if (wasOpen && isViewing) {
    await syncNativeVisibility()
  }
  return true
}

export const closeBrowserPanel = async (sessionId?: string): Promise<void> => {
  const state = get()
  const targetSessionId = sessionId ?? state.activeSessionId
  if (!targetSessionId) {
    return
  }
  const isViewing = state.activeSessionId === targetSessionId
  closeRightPanel(targetSessionId, 'browser')
  set((current) => ({
    sessions: {
      ...current.sessions,
      [targetSessionId]: {
        ...getSessionBrowser(current, targetSessionId),
        panelOpen: false,
      },
    },
    ...(current.activeSessionId === targetSessionId ? { panelAnimating: false } : {}),
  }))
  if (isViewing) {
    await syncNativeVisibility()
  }
}

export const toggleBrowserPanel = async (sessionId?: string): Promise<void> => {
  const targetSessionId = sessionId ?? get().activeSessionId
  if (!targetSessionId) {
    return
  }
  if (
    getSessionBrowser(get(), targetSessionId).panelOpen &&
    getActiveRightPanel(targetSessionId) === 'browser'
  ) {
    await closeBrowserPanel(targetSessionId)
  } else {
    await openBrowserPanel(targetSessionId)
  }
}

export const hideBrowserPanelForOtherView = async (): Promise<void> => {
  const activeSessionId = get().activeSessionId
  if (!activeSessionId || !getSessionBrowser(get(), activeSessionId).panelOpen) {
    return
  }
  await closeBrowserPanel(activeSessionId)
}

export const setBrowserPanelAnimating = (animating: boolean) => {
  setRightPanelAnimating(animating)
  if (get().panelAnimating === animating) {
    return
  }
  set({ panelAnimating: animating })
  void syncNativeVisibility()
}

export const setBrowserPanelResizing = (resizing: boolean) => {
  setRightPanelResizing(resizing)
  if (get().panelResizing === resizing) {
    return
  }
  set({ panelResizing: resizing })
  void syncNativeVisibility()
}

export const setBrowserStageSize = (size: { width: number; height: number }) => {
  const prev = get().stageSize
  if (
    prev &&
    Math.abs(prev.width - size.width) < 0.5 &&
    Math.abs(prev.height - size.height) < 0.5
  ) {
    return
  }
  set({ stageSize: size })
}

export const setBrowserPanelBounds = (bounds: BrowserBounds, zoom?: number) => {
  const state = get()
  const prev = state.bounds
  const sessionId = state.activeSessionId
  const activeSession = getSessionBrowser(state, sessionId)
  const active = activeSession.tabs.find((t) => t.id === activeSession.activeTabId)
  const boundsSame =
    prev !== null &&
    Math.abs(prev.x - bounds.x) < 0.5 &&
    Math.abs(prev.y - bounds.y) < 0.5 &&
    Math.abs(prev.width - bounds.width) < 0.5 &&
    Math.abs(prev.height - bounds.height) < 0.5
  const zoomSame = zoom === undefined || !active || Math.abs(active.zoom - zoom) < 0.001
  if (boundsSame && zoomSame) {
    return
  }
  set((current) => {
    const currSessionId = current.activeSessionId
    const currSession = getSessionBrowser(current, currSessionId)
    return {
      bounds,
      ...(zoom !== undefined && currSessionId && currSession.activeTabId
        ? {
            sessions: {
              ...current.sessions,
              [currSessionId]: {
                ...currSession,
                tabs: currSession.tabs.map((tab) =>
                  tab.id === currSession.activeTabId ? { ...tab, zoom } : tab
                ),
              },
            },
          }
        : {}),
    }
  })
  if (shouldShowNativeWebview(get()) && isDesktopApp) {
    void browserSetBounds(bounds, zoom).catch(() => {})
  }
}

export const setBrowserTabViewport = async (
  tabId: string,
  viewport: BrowserViewportSpec | null,
  options: { preserveSnapshot?: boolean } = {}
): Promise<BrowserStageFit> => {
  const state = get()
  const owner = findTabOwner(state, tabId)
  const stage = state.stageSize ?? {
    width: Math.max(320, (state.bounds?.width ?? 540) - 20),
    height: Math.max(240, (state.bounds?.height ?? 680) - 20),
  }
  const fit = fitViewportToStage(viewport, stage.width, stage.height)
  if (owner) {
    updateSessionBrowser(owner.sessionId, (session) => ({
      ...session,
      tabs: session.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              viewport,
              zoom: fit.zoom,
              ...(options.preserveSnapshot
                ? {}
                : { snapshotUrl: null, snapshotWidth: null, snapshotHeight: null }),
            }
          : tab
      ),
    }))
  }
  if (isDesktopApp && nativeCreated.has(tabId)) {
    await browserSetZoom(tabId, fit.zoom).catch(() => {})
  }
  return fit
}

export const refreshActiveTabSnapshot = async () => {
  if (!isDesktopApp) {
    return
  }
  const state = get()
  const sessionId = state.activeSessionId
  if (!sessionId || state.panelAnimating || state.panelResizing) {
    return
  }
  const session = getSessionBrowser(state, sessionId)
  if (!session.panelOpen) {
    return
  }
  const active = session.tabs.find((t) => t.id === session.activeTabId)
  if (!active || !isHttpUrl(active.url) || !nativeCreated.has(active.id)) {
    return
  }
  try {
    const snap = await browserTakeSnapshot(active.id, 1280)
    if (get().panelResizing) {
      return
    }
    updateSessionBrowser(sessionId, (curr) => ({
      ...curr,
      tabs: curr.tabs.map((t) =>
        t.id === active.id
          ? {
              ...t,
              snapshotUrl: snap.dataUrl,
              snapshotWidth: snap.width,
              snapshotHeight: snap.height,
            }
          : t
      ),
    }))
  } catch {
    // Snapshot fallback is best-effort for overlays
  }
}

/**
 * Temporarily hides the native child webview while a React Modal / Menu / Drawer
 * is mounted above the viewport, preserving a snapshot behind the backdrop.
 */
export const acquireBrowserOverlayLock = (): (() => void) => {
  const releaseSideLock = acquireSidePanelOverlayLock()
  const current = get()
  const needsSnapshot = current.overlayLocks === 0 && shouldShowNativeWebview(current)
  set((state) => ({ overlayLocks: state.overlayLocks + 1 }))
  if (needsSnapshot) {
    void refreshActiveTabSnapshot().finally(() => {
      void syncNativeVisibility()
    })
  } else {
    void syncNativeVisibility()
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    releaseSideLock()
    set((state) => ({ overlayLocks: Math.max(0, state.overlayLocks - 1) }))
    void syncNativeVisibility()
  }
}

export const navigateBrowserTab = async (
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
    updateSessionBrowser(sessionId, (session) => ({
      ...session,
      tabs: session.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              url: 'about:blank',
              title: '',
              isLoading: false,
              snapshotUrl: null,
              snapshotWidth: null,
              snapshotHeight: null,
              error: null,
            }
          : t
      ),
    }))
    await syncNativeVisibility()
    return 'about:blank'
  }
  updateSessionBrowser(sessionId, (session) => ({
    ...session,
    tabs: session.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            url: normalized,
            isLoading: true,
            ...(t.url !== normalized
              ? { snapshotUrl: null, snapshotWidth: null, snapshotHeight: null }
              : {}),
            error: null,
          }
        : t
    ),
  }))
  await ensureNativeTab(tabId)
  try {
    const finalUrl = await browserNavigate(tabId, normalized, initiator)
    updateSessionBrowser(sessionId, (session) => ({
      ...session,
      tabs: session.tabs.map((t) => (t.id === tabId ? { ...t, url: finalUrl, error: null } : t)),
    }))
    await syncNativeVisibility()
    return finalUrl
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateSessionBrowser(sessionId, (session) => ({
      ...session,
      tabs: session.tabs.map((t) =>
        t.id === tabId ? { ...t, isLoading: false, error: message } : t
      ),
    }))
    throw error
  }
}

export const openUrlInBrowserPanel = async (
  url: string,
  options: { sessionId?: string; newTab?: boolean; initiator?: 'user' | 'model' } = {}
): Promise<BrowserTab | null> => {
  const targetSessionId = options.sessionId ?? get().activeSessionId
  if (!targetSessionId) {
    await openExternalUrl(url)
    return null
  }
  await openBrowserPanel(targetSessionId)
  const session = getSessionBrowser(get(), targetSessionId)
  const active = session.tabs.find((t) => t.id === session.activeTabId)
  let targetTab: BrowserTab
  if (!options.newTab && active && (!isHttpUrl(active.url) || options.initiator !== 'user')) {
    targetTab = active
    await navigateBrowserTab(targetTab.id, url, options.initiator ?? 'user')
  } else if (options.newTab && active && !isHttpUrl(active.url)) {
    targetTab = active
    await navigateBrowserTab(targetTab.id, url, options.initiator ?? 'user')
  } else if (options.newTab || !active) {
    targetTab = await createBrowserTab(url, { sessionId: targetSessionId, activate: true })
  } else {
    targetTab = active
    await navigateBrowserTab(targetTab.id, url, options.initiator ?? 'user')
  }
  return (
    getSessionBrowser(get(), targetSessionId).tabs.find((t) => t.id === targetTab.id) ?? targetTab
  )
}

export const runBrowserHistory = async (
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
    updateSessionBrowser(owner.sessionId, (session) => ({
      ...session,
      tabs: session.tabs.map((t) => (t.id === tabId ? { ...t, isLoading: true, error: null } : t)),
    }))
  } else if (action === 'stop') {
    updateSessionBrowser(owner.sessionId, (session) => ({
      ...session,
      tabs: session.tabs.map((t) => (t.id === tabId ? { ...t, isLoading: false } : t)),
    }))
    resolveLoadWaiters(tabId)
  }
  await browserHistory(tabId, action)
  if (action === 'back' || action === 'forward') {
    const info = await browserGetState(tabId).catch(() => null)
    if (info) {
      updateSessionBrowser(owner.sessionId, (session) => ({
        ...session,
        tabs: session.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                url: info.url || t.url,
                canGoBack: info.canGoBack,
                canGoForward: info.canGoForward,
              }
            : t
        ),
      }))
    }
  }
}

export const clearBrowserTabData = async (tabId: string): Promise<void> => {
  if (nativeCreated.has(tabId)) {
    await browserClearData(tabId)
    await browserHistory(tabId, 'reload').catch(() => {})
  }
}

export const openBrowserTabDevtools = async (tabId: string): Promise<void> => {
  if (nativeCreated.has(tabId)) {
    await browserOpenDevtools(tabId)
  }
}

export const waitForTabLoad = (
  tabId: string,
  signal: AbortSignal,
  timeoutMs = 15_000
): Promise<void> => {
  const owner = findTabOwner(get(), tabId)
  const tab = owner?.tab
  if (!tab || !tab.isLoading) {
    return Promise.resolve()
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      loadWaiters.get(tabId)?.delete(onDone)
    }
    const onDone = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const onAbort = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      // Timed out waiting for full network load; resolve so snapshot can inspect partially rendered SPAs
      onDone()
    }, timeoutMs)
    let setForTab = loadWaiters.get(tabId)
    if (!setForTab) {
      setForTab = new Set()
      loadWaiters.set(tabId, setForTab)
    }
    setForTab.add(onDone)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const setBrowserControlling = (
  controlling: boolean,
  action: string | null = null,
  sessionId: string | null = null
) => {
  set({
    controlling,
    controllingAction: controlling ? action : null,
    controllingSessionId: controlling ? sessionId : null,
  })
}

export const getActiveBrowserTab = (sessionId?: string | null): BrowserTab | null => {
  const state = get()
  const targetSessionId = sessionId === undefined ? state.activeSessionId : sessionId
  const session = getSessionBrowser(state, targetSessionId)
  return session.tabs.find((t) => t.id === session.activeTabId) ?? session.tabs[0] ?? null
}
