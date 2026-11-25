import type { CollapsedTransition, SiderMode } from '@deepseek-chat/slice-conversations'
import type { SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'

export type SiderLayoutState =
  | { readonly mode: 'absent'; readonly collapsedExit: CollapsedTransition }
  | { readonly mode: 'collapsed'; readonly reveal: CollapsedTransition }
  | { readonly mode: 'expanded'; readonly collapsedExit: CollapsedTransition }

export type SiderLayoutEvent =
  | { readonly type: 'hydrated'; readonly sessionCount: number }
  | {
      readonly type: 'sessionsChanged'
      readonly sessionCount: number
      readonly fromHistoryReplace: boolean
    }
  | { readonly type: 'setCollapsed'; readonly collapsed: boolean }

export type SessionCountSource = {
  readonly getState: () => { readonly ready: boolean; readonly sessions: readonly unknown[] }
  readonly subscribe: (listener: () => void) => () => void
}

const ABSENT_STATE: SiderLayoutState = { mode: 'absent', collapsedExit: 'fade' }
const EXPANDED_STATE: SiderLayoutState = { mode: 'expanded', collapsedExit: 'morph' }

/** Pure state transition for the desktop sidebar lifecycle (`absent` / `collapsed` / `expanded`). */
export const transitionSiderLayout = (
  state: SiderLayoutState,
  event: SiderLayoutEvent
): SiderLayoutState => {
  switch (event.type) {
    case 'hydrated':
      return event.sessionCount > 0 ? EXPANDED_STATE : ABSENT_STATE
    case 'sessionsChanged':
      if (event.sessionCount === 0) {
        return state.mode === 'absent' ? state : ABSENT_STATE
      }
      if (state.mode === 'absent') {
        return event.fromHistoryReplace ? EXPANDED_STATE : { mode: 'collapsed', reveal: 'fade' }
      }
      return state
    case 'setCollapsed':
      if (state.mode === 'absent') {
        return state
      }
      if (event.collapsed) {
        return state.mode === 'collapsed' ? state : { mode: 'collapsed', reveal: 'morph' }
      }
      return state.mode === 'expanded' ? state : EXPANDED_STATE
  }
}

export const siderModeOf = (state: SiderLayoutState): SiderMode => state.mode

/** Factory-scoped desktop sidebar layout controller bound to a runtime's Spine EventLog. */
export const createSiderLayoutController = (log: EventLog) => {
  const useStore = create<SiderLayoutState>(() => ABSENT_STATE)
  let hydrated = false
  let lastSessionCount = 0
  let pendingHistoryReplace = false
  let unsubSessions: (() => void) | null = null

  const dispatch = (event: SiderLayoutEvent) => {
    const prev = useStore.getState()
    const next = transitionSiderLayout(prev, event)
    if (next !== prev) {
      useStore.setState(next, true)
    }
  }

  const unsubHistory = log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
    pendingHistoryReplace = true
  })

  const syncFromSource = (source: SessionCountSource) => {
    const { ready, sessions } = source.getState()
    if (!ready) {
      return
    }
    const sessionCount = sessions.length
    const fromHistoryReplace = pendingHistoryReplace
    pendingHistoryReplace = false

    if (!hydrated) {
      hydrated = true
      lastSessionCount = sessionCount
      dispatch({ type: 'hydrated', sessionCount })
      return
    }
    if (sessionCount !== lastSessionCount || fromHistoryReplace) {
      lastSessionCount = sessionCount
      dispatch({ type: 'sessionsChanged', sessionCount, fromHistoryReplace })
    }
  }

  const bindSessions = (source: SessionCountSource) => {
    unsubSessions?.()
    syncFromSource(source)
    unsubSessions = source.subscribe(() => syncFromSource(source))
  }

  const setSiderCollapsed = (collapsed: boolean) => {
    dispatch({ type: 'setCollapsed', collapsed })
  }

  const dispose = () => {
    unsubSessions?.()
    unsubSessions = null
    unsubHistory()
  }

  return {
    useStore,
    getState: () => useStore.getState(),
    bindSessions,
    setSiderCollapsed,
    dispose,
  }
}

export type SiderLayoutController = ReturnType<typeof createSiderLayoutController>
