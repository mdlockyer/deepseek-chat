import type { ViewportSpec } from '@deepseek-chat/lib-stage'
import type { PanelLayout } from '@deepseek-chat/spine/ports'
import type { BrowserBounds, BrowserTabStatePayload } from './host.js'
import {
  EMPTY_SESSION_BROWSER_TABS,
  type BrowserControlState,
  type BrowserKernelState,
  type BrowserTab,
  type SessionBrowserState,
  type SessionBrowserTabs,
} from './types.js'
import { boundsEqual, isHttpUrl } from './urls.js'

export const INITIAL_BROWSER_STATE: BrowserKernelState = {
  activeSessionId: null,
  sessions: {},
  control: { kind: 'idle' },
  bounds: null,
  stageSize: null,
  agentAddress: null,
}

export const getSessionTabs = (
  state: Pick<BrowserKernelState, 'sessions'>,
  sessionId: string | null | undefined
): SessionBrowserTabs =>
  sessionId && Object.hasOwn(state.sessions, sessionId)
    ? state.sessions[sessionId]
    : EMPTY_SESSION_BROWSER_TABS

export const getActiveSessionTabs = (
  state: Pick<BrowserKernelState, 'activeSessionId' | 'sessions'>
): SessionBrowserTabs => getSessionTabs(state, state.activeSessionId)

export const projectSessionBrowser = (
  state: Pick<BrowserKernelState, 'sessions'>,
  sessionId: string,
  panelOpen: boolean
): SessionBrowserState => {
  const session = getSessionTabs(state, sessionId)
  return {
    panelOpen,
    tabs: [...session.tabs],
    activeTabId: session.activeTabId,
  }
}

export const findTabOwner = (
  state: Pick<BrowserKernelState, 'sessions'>,
  tabId: string
): { sessionId: string; session: SessionBrowserTabs; tab: BrowserTab } | null => {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const tab = session.tabs.find((t) => t.id === tabId)
    if (tab) {
      return { sessionId, session, tab }
    }
  }
  return null
}

export const getActiveTab = (
  state: Pick<BrowserKernelState, 'activeSessionId' | 'sessions'>,
  sessionId?: string | null
): BrowserTab | null => {
  const targetSessionId = sessionId === undefined ? state.activeSessionId : sessionId
  const session = getSessionTabs(state, targetSessionId)
  return session.tabs.find((t) => t.id === session.activeTabId) ?? session.tabs[0] ?? null
}

export const isControllingSession = (
  state: Pick<BrowserKernelState, 'control'>,
  sessionId: string
): boolean => state.control.kind === 'controlling' && state.control.sessionId === sessionId

export const isBrowserWebviewVisible = (
  state: Pick<BrowserKernelState, 'activeSessionId' | 'sessions'>,
  layout: Pick<PanelLayout, 'animating' | 'resizing' | 'overlayLocked'>,
  desktop: boolean,
  isNativeCreated: (tabId: string) => boolean,
  isActiveRightPanel: boolean
): boolean => {
  if (
    !desktop ||
    !state.activeSessionId ||
    !isActiveRightPanel ||
    layout.animating ||
    layout.resizing ||
    layout.overlayLocked
  ) {
    return false
  }
  const session = getSessionTabs(state, state.activeSessionId)
  const active = session.tabs.find((t) => t.id === session.activeTabId)
  return Boolean(active && isHttpUrl(active.url) && isNativeCreated(active.id))
}

/** Selects inactive native tab IDs to evict when opening another native tab would reach the cap. */
export const selectEvictableNativeTabs = (
  state: Pick<BrowserKernelState, 'activeSessionId' | 'sessions' | 'control'>,
  liveTabIds: ReadonlySet<string>,
  maxLiveTabs: number
): readonly string[] => {
  if (liveTabIds.size < maxLiveTabs) {
    return []
  }
  const controllingSessionId = state.control.kind === 'controlling' ? state.control.sessionId : null
  const victims: string[] = []
  let remaining = liveTabIds.size
  for (const existingId of liveTabIds) {
    if (remaining < maxLiveTabs) {
      break
    }
    const owner = findTabOwner(state, existingId)
    if (
      owner &&
      (owner.sessionId === state.activeSessionId || owner.sessionId === controllingSessionId)
    ) {
      continue
    }
    victims.push(existingId)
    remaining -= 1
  }
  return victims
}

export type BrowserKernelAction =
  | { readonly type: 'setActiveSession'; readonly sessionId: string | null }
  | {
      readonly type: 'addTab'
      readonly sessionId: string
      readonly tab: BrowserTab
      readonly activate: boolean
    }
  | {
      readonly type: 'rollbackTab'
      readonly sessionId: string
      readonly tabId: string
      readonly restoreActiveTabId: string | null
    }
  | { readonly type: 'closeTab'; readonly sessionId: string; readonly tabId: string }
  | { readonly type: 'switchTab'; readonly sessionId: string; readonly tabId: string }
  | { readonly type: 'applyHostTabState'; readonly payload: BrowserTabStatePayload }
  | { readonly type: 'clearActiveTabSnapshot'; readonly sessionId: string }
  | {
      readonly type: 'setTabSnapshot'
      readonly sessionId: string
      readonly tabId: string
      readonly expectedUrl: string
      readonly dataUrl: string
      readonly width: number
      readonly height: number
    }
  | { readonly type: 'setTabBlank'; readonly sessionId: string; readonly tabId: string }
  | {
      readonly type: 'startTabNavigation'
      readonly sessionId: string
      readonly tabId: string
      readonly url: string
    }
  | {
      readonly type: 'finishTabNavigation'
      readonly sessionId: string
      readonly tabId: string
      readonly finalUrl: string
    }
  | {
      readonly type: 'failTabNavigation'
      readonly sessionId: string
      readonly tabId: string
      readonly error: string
    }
  | {
      readonly type: 'setTabLoading'
      readonly sessionId: string
      readonly tabId: string
      readonly isLoading: boolean
      readonly clearError?: boolean
    }
  | {
      readonly type: 'applyTabHistoryState'
      readonly sessionId: string
      readonly tabId: string
      readonly url: string
      readonly canGoBack: boolean
      readonly canGoForward: boolean
    }
  | {
      readonly type: 'setTabViewport'
      readonly sessionId: string
      readonly tabId: string
      readonly viewport: ViewportSpec | null
      readonly zoom: number
      readonly preserveSnapshot: boolean
    }
  | {
      readonly type: 'setStageSize'
      readonly size: { readonly width: number; readonly height: number }
    }
  | { readonly type: 'setPanelBounds'; readonly bounds: BrowserBounds; readonly zoom?: number }
  | { readonly type: 'setControl'; readonly control: BrowserControlState }
  | { readonly type: 'setAgentAddress'; readonly tabId: string; readonly text: string | null }
  | { readonly type: 'disposeSession'; readonly sessionId: string }
  | { readonly type: 'clearAllSessions' }

const updateSession = (
  state: BrowserKernelState,
  sessionId: string,
  updater: (session: SessionBrowserTabs) => SessionBrowserTabs
): BrowserKernelState => {
  const prev = getSessionTabs(state, sessionId)
  const next = updater(prev)
  if (next === prev) {
    return state
  }
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: next,
    },
  }
}

const mapTab = (
  session: SessionBrowserTabs,
  tabId: string,
  updater: (tab: BrowserTab) => BrowserTab
): SessionBrowserTabs => {
  let changed = false
  const tabs = session.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab
    }
    const next = updater(tab)
    if (next !== tab) {
      changed = true
    }
    return next
  })
  return changed ? { ...session, tabs } : session
}

export const reduceBrowser = (
  state: BrowserKernelState,
  action: BrowserKernelAction
): BrowserKernelState => {
  switch (action.type) {
    case 'setActiveSession':
      if (state.activeSessionId === action.sessionId) {
        return state
      }
      return { ...state, activeSessionId: action.sessionId }

    case 'addTab':
      return updateSession(state, action.sessionId, (session) => ({
        tabs: [...session.tabs, action.tab],
        activeTabId: action.activate ? action.tab.id : (session.activeTabId ?? action.tab.id),
      }))

    case 'rollbackTab':
      return updateSession(state, action.sessionId, (session) => {
        const remaining = session.tabs.filter((t) => t.id !== action.tabId)
        return {
          tabs: remaining,
          activeTabId:
            session.activeTabId === action.tabId
              ? (action.restoreActiveTabId ?? remaining.at(-1)?.id ?? null)
              : session.activeTabId,
        }
      })

    case 'closeTab':
      return updateSession(state, action.sessionId, (session) => {
        const idx = session.tabs.findIndex((t) => t.id === action.tabId)
        if (idx === -1) {
          return session
        }
        const remaining = session.tabs.filter((t) => t.id !== action.tabId)
        const nextActive =
          session.activeTabId === action.tabId
            ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
            : session.activeTabId
        return {
          tabs: remaining,
          activeTabId: nextActive,
        }
      })

    case 'switchTab':
      return updateSession(state, action.sessionId, (session) =>
        session.activeTabId === action.tabId ? session : { ...session, activeTabId: action.tabId }
      )

    case 'applyHostTabState': {
      const { payload } = action
      const owner = findTabOwner(state, payload.tabId)
      if (!owner) {
        return state
      }
      return updateSession(state, owner.sessionId, (session) =>
        mapTab(session, payload.tabId, (tab) => {
          const urlChanged = Boolean(payload.url && payload.url !== tab.url)
          return {
            ...tab,
            ...(payload.url ? { url: payload.url } : {}),
            ...(payload.title !== null ? { title: payload.title } : {}),
            ...(payload.isLoading !== null ? { isLoading: payload.isLoading } : {}),
            ...(payload.canGoBack !== null ? { canGoBack: payload.canGoBack } : {}),
            ...(payload.canGoForward !== null ? { canGoForward: payload.canGoForward } : {}),
            ...(urlChanged ? { snapshotUrl: null, snapshotWidth: null, snapshotHeight: null } : {}),
            error: null,
          }
        })
      )
    }

    case 'clearActiveTabSnapshot': {
      const session = getSessionTabs(state, action.sessionId)
      const activeTabId = session.activeTabId
      if (!activeTabId) {
        return state
      }
      const activeTab = session.tabs.find((t) => t.id === activeTabId)
      if (!activeTab?.snapshotUrl) {
        return state
      }
      return updateSession(state, action.sessionId, (curr) =>
        mapTab(curr, activeTabId, (tab) => ({
          ...tab,
          snapshotUrl: null,
          snapshotWidth: null,
          snapshotHeight: null,
        }))
      )
    }

    case 'setTabSnapshot':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) =>
          tab.url !== action.expectedUrl
            ? tab
            : {
                ...tab,
                snapshotUrl: action.dataUrl,
                snapshotWidth: action.width,
                snapshotHeight: action.height,
              }
        )
      )

    case 'setTabBlank':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({
          ...tab,
          url: 'about:blank',
          title: '',
          isLoading: false,
          snapshotUrl: null,
          snapshotWidth: null,
          snapshotHeight: null,
          error: null,
        }))
      )

    case 'startTabNavigation':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({
          ...tab,
          url: action.url,
          isLoading: true,
          ...(tab.url !== action.url
            ? { snapshotUrl: null, snapshotWidth: null, snapshotHeight: null }
            : {}),
          error: null,
        }))
      )

    case 'finishTabNavigation':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({ ...tab, url: action.finalUrl, error: null }))
      )

    case 'failTabNavigation':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({
          ...tab,
          isLoading: false,
          error: action.error,
        }))
      )

    case 'setTabLoading':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({
          ...tab,
          isLoading: action.isLoading,
          ...(action.clearError ? { error: null } : {}),
        }))
      )

    case 'applyTabHistoryState':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({
          ...tab,
          url: action.url || tab.url,
          canGoBack: action.canGoBack,
          canGoForward: action.canGoForward,
        }))
      )

    case 'setTabViewport':
      return updateSession(state, action.sessionId, (session) =>
        mapTab(session, action.tabId, (tab) => ({
          ...tab,
          viewport: action.viewport,
          zoom: action.zoom,
          ...(action.preserveSnapshot
            ? {}
            : { snapshotUrl: null, snapshotWidth: null, snapshotHeight: null }),
        }))
      )

    case 'setStageSize': {
      const prev = state.stageSize
      if (
        prev &&
        Math.abs(prev.width - action.size.width) < 0.5 &&
        Math.abs(prev.height - action.size.height) < 0.5
      ) {
        return state
      }
      return { ...state, stageSize: action.size }
    }

    case 'setPanelBounds': {
      const activeSession = getActiveSessionTabs(state)
      const active = activeSession.tabs.find((t) => t.id === activeSession.activeTabId)
      const boundsSame = boundsEqual(state.bounds, action.bounds)
      const zoomSame =
        action.zoom === undefined || !active || Math.abs(active.zoom - action.zoom) < 0.001
      if (boundsSame && zoomSame) {
        return state
      }
      const next: BrowserKernelState = { ...state, bounds: action.bounds }
      const activeTabId = activeSession.activeTabId
      if (action.zoom !== undefined && state.activeSessionId && activeTabId) {
        const nextZoom = action.zoom
        return updateSession(next, state.activeSessionId, (curr) =>
          mapTab(curr, activeTabId, (tab) => ({ ...tab, zoom: nextZoom }))
        )
      }
      return next
    }

    case 'setControl':
      return { ...state, control: action.control }

    case 'setAgentAddress':
      if (action.text === null) {
        if (state.agentAddress?.tabId !== action.tabId) {
          return state
        }
        return { ...state, agentAddress: null }
      }
      return { ...state, agentAddress: { tabId: action.tabId, text: action.text } }

    case 'disposeSession': {
      const nextSessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([key]) => key !== action.sessionId)
      )
      return {
        ...state,
        sessions: nextSessions,
        ...(state.activeSessionId === action.sessionId ? { activeSessionId: null } : {}),
        ...(state.control.kind === 'controlling' && state.control.sessionId === action.sessionId
          ? { control: { kind: 'idle' } }
          : {}),
      }
    }

    case 'clearAllSessions':
      return {
        ...state,
        activeSessionId: null,
        sessions: {},
        control: { kind: 'idle' },
      }
  }
}
