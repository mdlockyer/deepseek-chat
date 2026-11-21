import { create } from 'zustand'

export type RightPanelKind = 'preview' | 'browser' | 'search'

type SidePanelState = {
  activeSessionId: string | null
  activePanels: Record<string, RightPanelKind | null>
  panelAnimating: boolean
  panelResizing: boolean
  overlayLocks: number
  stageSize: { width: number; height: number } | null
}

export const DEFAULT_SIDE_PANEL_WIDTH = 540

export const clampSidePanelResizeWidth = (proposedWidth: number, windowWidth: number): number => {
  const maxWidth = Math.max(360, Math.min(windowWidth - 360, Math.floor(windowWidth * 0.72)))
  return Math.round(Math.min(maxWidth, Math.max(360, proposedWidth)))
}

export const useSidePanelStore = create<SidePanelState>(() => ({
  activeSessionId: null,
  activePanels: {},
  panelAnimating: false,
  panelResizing: false,
  overlayLocks: 0,
  stageSize: null,
}))

const { getState: get, setState: set } = useSidePanelStore

type OverlayListener = (locked: boolean) => void
const overlayListeners = new Set<OverlayListener>()

export const registerOverlayLockListener = (listener: OverlayListener): (() => void) => {
  overlayListeners.add(listener)
  return () => {
    overlayListeners.delete(listener)
  }
}

export const acquireSidePanelOverlayLock = (): (() => void) => {
  const wasUnlocked = get().overlayLocks === 0
  set((state) => ({ overlayLocks: state.overlayLocks + 1 }))
  if (wasUnlocked) {
    for (const listener of overlayListeners) {
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
      for (const listener of overlayListeners) {
        listener(false)
      }
    }
  }
}

export const getActiveRightPanel = (
  sessionId: string | null | undefined,
  state: Pick<SidePanelState, 'activePanels'> = get()
): RightPanelKind | null => {
  if (!sessionId) {
    return null
  }
  return Object.hasOwn(state.activePanels, sessionId) ? state.activePanels[sessionId] : null
}

export const setActiveSidePanelSession = (sessionId: string | null) => {
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

export const openRightPanel = (sessionId: string, kind: RightPanelKind) => {
  const state = get()
  const prev = getActiveRightPanel(sessionId, state)
  if (prev === kind) {
    return
  }
  const isViewing = state.activeSessionId === sessionId
  set({
    activePanels: { ...state.activePanels, [sessionId]: kind },
    ...(isViewing && prev === null ? { panelAnimating: true } : {}),
  })
}

export const closeRightPanel = (sessionId: string, kind?: RightPanelKind) => {
  const state = get()
  const prev = getActiveRightPanel(sessionId, state)
  if (prev === null || (kind !== undefined && prev !== kind)) {
    return
  }
  const isViewing = state.activeSessionId === sessionId
  set({
    activePanels: { ...state.activePanels, [sessionId]: null },
    ...(isViewing ? { panelAnimating: false } : {}),
  })
}

export const closeActiveRightPanelKind = (kind: RightPanelKind) => {
  const state = get()
  const sessionId = state.activeSessionId
  if (sessionId) {
    closeRightPanel(sessionId, kind)
  }
}

export const setRightPanelAnimating = (animating: boolean) => {
  if (get().panelAnimating !== animating) {
    set({ panelAnimating: animating })
  }
}

export const setRightPanelResizing = (resizing: boolean) => {
  if (get().panelResizing !== resizing) {
    set({ panelResizing: resizing })
  }
}

export const setRightPanelStageSize = (size: { width: number; height: number }) => {
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

export const disposeSidePanelSession = (sessionId: string) => {
  set((state) => ({
    activePanels: Object.fromEntries(
      Object.entries(state.activePanels).filter(([key]) => key !== sessionId)
    ),
    ...(state.activeSessionId === sessionId
      ? { activeSessionId: null, panelAnimating: false }
      : {}),
  }))
}

export const clearAllSidePanelSessions = () => {
  set({
    activeSessionId: null,
    activePanels: {},
    panelAnimating: false,
    panelResizing: false,
  })
}
