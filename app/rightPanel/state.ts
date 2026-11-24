import { create } from 'zustand'
import { localStore } from '../storage.js'

export type RightPanelKind = 'preview' | 'browser' | 'activity'

type SidePanelState = {
  activeSessionId: string | null
  activePanels: Record<string, RightPanelKind | null>
  /** Last panel displaced on the same session, powering one-click return chips. */
  previousPanels: Record<string, RightPanelKind | null>
  panelAnimating: boolean
  panelResizing: boolean
  overlayLocks: number
  stageSize: { width: number; height: number } | null
  /** 面板宽度（px），跨会话共享并存 localStorage */
  width: number
}

export const DEFAULT_SIDE_PANEL_WIDTH = 540

/** 沿用原有键名（原属内置浏览器设置），已保存的宽度不丢失 */
const WIDTH_KEY = 'chat-demo:browser-panel-width'

const clampStoredWidth = (value: number) =>
  Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), 360), 1100)
    : DEFAULT_SIDE_PANEL_WIDTH

const initialWidth = (): number => {
  const parsed = Number(localStore.get(WIDTH_KEY))
  return parsed > 0 ? clampStoredWidth(parsed) : DEFAULT_SIDE_PANEL_WIDTH
}

export const clampSidePanelResizeWidth = (proposedWidth: number, windowWidth: number): number => {
  const maxWidth = Math.max(360, Math.min(windowWidth - 360, Math.floor(windowWidth * 0.72)))
  return Math.round(Math.min(maxWidth, Math.max(360, proposedWidth)))
}

export const useSidePanelStore = create<SidePanelState>(() => ({
  activeSessionId: null,
  activePanels: {},
  previousPanels: {},
  panelAnimating: false,
  panelResizing: false,
  overlayLocks: 0,
  stageSize: null,
  width: initialWidth(),
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

export const getPreviousRightPanel = (
  sessionId: string | null | undefined,
  state: Pick<SidePanelState, 'previousPanels'> = get()
): RightPanelKind | null => {
  if (!sessionId) {
    return null
  }
  return Object.hasOwn(state.previousPanels, sessionId) ? state.previousPanels[sessionId] : null
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
    previousPanels:
      prev !== null ? { ...state.previousPanels, [sessionId]: prev } : state.previousPanels,
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
    previousPanels: { ...state.previousPanels, [sessionId]: null },
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
    previousPanels: Object.fromEntries(
      Object.entries(state.previousPanels).filter(([key]) => key !== sessionId)
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
    previousPanels: {},
    panelAnimating: false,
    panelResizing: false,
  })
}

export const setSidePanelWidth = (width: number) => {
  const clamped = clampStoredWidth(width)
  localStore.set(WIDTH_KEY, String(clamped))
  set({ width: clamped })
}
