import type {
  ActiveSessionChanged,
  ReplyLifecycleChanged,
  SessionDeleted,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import type { KeyValueStore, PanelLayout, PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'

export type RightPanelKind = 'preview' | 'browser' | 'activity'

export type PanelRevealPolicy = 'auto' | 'user_overridden'

export type SidePanelState = {
  activeSessionId: string | null
  activePanels: Record<string, RightPanelKind | null>
  /** Per-session reveal policy: resets to `'auto'` when a new reply starts. */
  revealPolicies: Record<string, PanelRevealPolicy>
  panelAnimating: boolean
  panelResizing: boolean
  overlayLocks: number
  stageSize: { width: number; height: number } | null
  /** Browser/preview panel width (px), persisted under `chat-demo:browser-panel-width`. */
  width: number
  /** Activity inspector width (px), defaulting slimmer so chat content stays unclipped. */
  activityWidth: number
}

export const DEFAULT_SIDE_PANEL_WIDTH = 540
export const DEFAULT_ACTIVITY_PANEL_WIDTH = 400
export const WIDE_ACTIVITY_PANEL_WIDTH = 560
export const MIN_SIDE_PANEL_WIDTH = 360
export const MIN_ACTIVITY_PANEL_WIDTH = 320

/** App-shell layout key kept from the original app so saved panel width survives upgrades. */
const WIDTH_KEY = 'chat-demo:browser-panel-width'

const clampStoredWidth = (value: number, minWidth = MIN_SIDE_PANEL_WIDTH) =>
  Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), minWidth), 1100)
    : DEFAULT_SIDE_PANEL_WIDTH

export const getPanelMinWidth = (kind: RightPanelKind | null): number =>
  kind === 'activity' ? MIN_ACTIVITY_PANEL_WIDTH : MIN_SIDE_PANEL_WIDTH

export const getPanelDefaultWidth = (kind: RightPanelKind | null): number =>
  kind === 'activity' ? DEFAULT_ACTIVITY_PANEL_WIDTH : DEFAULT_SIDE_PANEL_WIDTH

export const clampSidePanelResizeWidth = (
  proposedWidth: number,
  windowWidth: number,
  minWidth = MIN_SIDE_PANEL_WIDTH
): number => {
  const floor = Math.max(MIN_ACTIVITY_PANEL_WIDTH, Math.round(minWidth))
  const maxWidth = Math.max(floor, Math.min(windowWidth - 360, Math.floor(windowWidth * 0.72)))
  return Math.round(Math.min(maxWidth, Math.max(floor, proposedWidth)))
}

const toLayout = (state: SidePanelState): PanelLayout => {
  const activeKind = getActiveRightPanel(state.activeSessionId, state)
  return {
    activeSessionId: state.activeSessionId,
    animating: state.panelAnimating,
    resizing: state.panelResizing,
    overlayLocked: state.overlayLocks > 0,
    width: activeKind === 'activity' ? state.activityWidth : state.width,
  }
}

export const getActiveRightPanel = (
  sessionId: string | null | undefined,
  state: Pick<SidePanelState, 'activePanels'>
): RightPanelKind | null => {
  if (!sessionId) {
    return null
  }
  return Object.hasOwn(state.activePanels, sessionId) ? state.activePanels[sessionId] : null
}

const getRevealPolicy = (
  sessionId: string,
  state: Pick<SidePanelState, 'revealPolicies'>
): PanelRevealPolicy =>
  Object.hasOwn(state.revealPolicies, sessionId) ? state.revealPolicies[sessionId] : 'auto'

/**
 * Factory-scoped coordinator for the shared right-hand side panel.
 * Subscribes to Spine session facts and issues isolated `PanelSlot` handles to slices.
 */
export const createRightPanelController = (store: KeyValueStore, log: EventLog) => {
  const parsed = Number(store.get(WIDTH_KEY))
  const initialWidth = parsed > 0 ? clampStoredWidth(parsed) : DEFAULT_SIDE_PANEL_WIDTH

  const useStore = create<SidePanelState>(() => ({
    activeSessionId: null,
    activePanels: {},
    revealPolicies: {},
    panelAnimating: false,
    panelResizing: false,
    overlayLocks: 0,
    stageSize: null,
    width: initialWidth,
    activityWidth: DEFAULT_ACTIVITY_PANEL_WIDTH,
  }))

  const { getState: get, setState: set } = useStore
  const overlayListeners = new Set<(locked: boolean) => void>()

  const registerOverlayLockListener = (listener: (locked: boolean) => void): (() => void) => {
    overlayListeners.add(listener)
    return () => {
      overlayListeners.delete(listener)
    }
  }

  const acquireOverlayLock = (): (() => void) => {
    const wasUnlocked = get().overlayLocks === 0
    set((state) => ({ overlayLocks: state.overlayLocks + 1 }))
    if (wasUnlocked) {
      for (const listener of [...overlayListeners]) {
        listener(true)
      }
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const next = Math.max(0, get().overlayLocks - 1)
      set({ overlayLocks: next })
      if (next === 0) {
        for (const listener of [...overlayListeners]) {
          listener(false)
        }
      }
    }
  }

  const getActivePanel = (sessionId: string | null | undefined) =>
    getActiveRightPanel(sessionId, get())

  const setActiveSession = (sessionId: string | null) => {
    const state = get()
    if (state.activeSessionId === sessionId) {
      return
    }
    const prevOpen = getActiveRightPanel(state.activeSessionId, state) !== null
    const nextOpen = getActiveRightPanel(sessionId, state) !== null
    set({
      activeSessionId: sessionId,
      panelAnimating: prevOpen !== nextOpen,
    })
  }

  const openPanel = (sessionId: string, kind: RightPanelKind) => {
    const state = get()
    const prev = getActiveRightPanel(sessionId, state)
    const prevPolicy = getRevealPolicy(sessionId, state)
    if (prev === kind && prevPolicy === 'user_overridden') {
      return
    }
    const isViewing = state.activeSessionId === sessionId
    set({
      activePanels: { ...state.activePanels, [sessionId]: kind },
      revealPolicies: { ...state.revealPolicies, [sessionId]: 'user_overridden' },
      ...(isViewing && prev === null ? { panelAnimating: true } : {}),
    })
  }

  /**
   * Politely reveals `kind` for background/agent work without displacing an already-open panel
   * or re-opening a panel the user explicitly dismissed during the current turn.
   */
  const revealPanel = (sessionId: string, kind: RightPanelKind) => {
    const state = get()
    const prev = getActiveRightPanel(sessionId, state)
    if (prev !== null || getRevealPolicy(sessionId, state) === 'user_overridden') {
      return
    }
    const isViewing = state.activeSessionId === sessionId
    set({
      activePanels: { ...state.activePanels, [sessionId]: kind },
      ...(isViewing ? { panelAnimating: true } : {}),
    })
  }

  const closePanel = (sessionId: string, kind?: RightPanelKind) => {
    const state = get()
    const prev = getActiveRightPanel(sessionId, state)
    if (prev === null || (kind !== undefined && prev !== kind)) {
      return
    }
    const isViewing = state.activeSessionId === sessionId
    set({
      activePanels: { ...state.activePanels, [sessionId]: null },
      revealPolicies: { ...state.revealPolicies, [sessionId]: 'user_overridden' },
      ...(isViewing ? { panelAnimating: false } : {}),
    })
  }

  const closeActivePanelKind = (kind: RightPanelKind) => {
    const sessionId = get().activeSessionId
    if (sessionId) {
      closePanel(sessionId, kind)
    }
  }

  const setAnimating = (animating: boolean) => {
    if (get().panelAnimating !== animating) {
      set({ panelAnimating: animating })
    }
  }

  const setResizing = (resizing: boolean) => {
    if (get().panelResizing !== resizing) {
      set({ panelResizing: resizing })
    }
  }

  const setStageSize = (size: { width: number; height: number }) => {
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

  const disposeSession = (sessionId: string) => {
    set((state) => ({
      activePanels: Object.fromEntries(
        Object.entries(state.activePanels).filter(([key]) => key !== sessionId)
      ),
      revealPolicies: Object.fromEntries(
        Object.entries(state.revealPolicies).filter(([key]) => key !== sessionId)
      ),
      ...(state.activeSessionId === sessionId
        ? { activeSessionId: null, panelAnimating: false }
        : {}),
    }))
  }

  const clearAllSessions = () => {
    set({
      activeSessionId: null,
      activePanels: {},
      revealPolicies: {},
      panelAnimating: false,
      panelResizing: false,
    })
  }

  const setWidth = (width: number) => {
    const clamped = clampStoredWidth(width, MIN_SIDE_PANEL_WIDTH)
    store.set(WIDTH_KEY, String(clamped))
    set({ width: clamped })
  }

  const setWidthForKind = (kind: RightPanelKind, width: number) => {
    if (kind === 'activity') {
      const clamped = clampStoredWidth(width, MIN_ACTIVITY_PANEL_WIDTH)
      set({ activityWidth: clamped })
      return
    }
    setWidth(width)
  }

  const getPanelWidth = (kind: RightPanelKind | null): number =>
    kind === 'activity' ? get().activityWidth : get().width

  const createSlot = (kind: RightPanelKind): PanelSlot => ({
    useStageSize: () => useStore((state) => state.stageSize),
    setStageSize,
    setResizing,
    isResizing: () => get().panelResizing,
    isOpen: (sessionId) => getActivePanel(sessionId) === kind,
    open: (sessionId) => openPanel(sessionId, kind),
    reveal: (sessionId) => revealPanel(sessionId, kind),
    close: (sessionId) => closePanel(sessionId, kind),
    setAnimating,
    getLayout: () => toLayout(get()),
    subscribe: (listener) => useStore.subscribe(() => listener()),
    useLayout: (select) => useStore((state) => select(toLayout(state))),
  })

  const unsubscribers = [
    log.subscribe<ActiveSessionChanged>(
      'ActiveSessionChanged',
      ({ fact }) => {
        setActiveSession(fact.sessionId)
      },
      { replaySticky: true }
    ),
    log.subscribe<ReplyLifecycleChanged>('ReplyLifecycleChanged', ({ fact }) => {
      if (fact.phase !== 'started') {
        return
      }
      const state = get()
      if (getRevealPolicy(fact.sessionId, state) !== 'auto') {
        set({
          revealPolicies: { ...state.revealPolicies, [fact.sessionId]: 'auto' },
        })
      }
    }),
    log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      disposeSession(fact.sessionId)
    }),
    log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      clearAllSessions()
    }),
  ]

  return {
    useStore,
    getActivePanel,
    setActiveSession,
    openPanel,
    revealPanel,
    closePanel,
    closeActivePanelKind,
    setAnimating,
    setResizing,
    setStageSize,
    setWidth,
    setWidthForKind,
    getPanelWidth,
    acquireOverlayLock,
    registerOverlayLockListener,
    createSlot,
    dispose: () => {
      overlayListeners.clear()
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type RightPanelController = ReturnType<typeof createRightPanelController>
