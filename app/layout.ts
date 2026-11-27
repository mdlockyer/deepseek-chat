import type { SiderMode } from '@deepseek-chat/slice-conversations'
import type { SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'

export type SiderLayoutState = { readonly mode: SiderMode }

/**
 * Single-owner discriminated state for the desktop sidebar lifecycle.
 * Holds hydration phase, visible mode, last observed session count, and pending history-replace
 * marker with zero external closure flags.
 */
export type SiderLayoutMachineState =
  | {
      readonly phase: 'unhydrated'
      readonly mode: 'absent'
      readonly pendingHistoryReplace: boolean
    }
  | {
      readonly phase: 'ready'
      readonly mode: SiderMode
      readonly sessionCount: number
      readonly pendingHistoryReplace: boolean
    }

export type SiderLayoutEvent =
  | { readonly type: 'historyReplaced' }
  | { readonly type: 'sessionsSynced'; readonly ready: boolean; readonly sessionCount: number }
  | { readonly type: 'setCollapsed'; readonly collapsed: boolean }

export type SessionCountSource = {
  readonly getState: () => { readonly ready: boolean; readonly sessions: readonly unknown[] }
  readonly subscribe: (listener: () => void) => () => void
}

export const INITIAL_SIDER_LAYOUT: SiderLayoutMachineState = {
  phase: 'unhydrated',
  mode: 'absent',
  pendingHistoryReplace: false,
}

/** Pure state transition covering the entire desktop sidebar lifecycle (`absent` / `collapsed` / `expanded`). */
export const stepSiderLayout = (
  state: SiderLayoutMachineState,
  event: SiderLayoutEvent
): SiderLayoutMachineState => {
  switch (event.type) {
    case 'historyReplaced':
      return state.pendingHistoryReplace ? state : { ...state, pendingHistoryReplace: true }
    case 'sessionsSynced': {
      if (!event.ready) {
        return state
      }
      if (state.phase === 'unhydrated') {
        return {
          phase: 'ready',
          mode: event.sessionCount > 0 ? 'expanded' : 'absent',
          sessionCount: event.sessionCount,
          pendingHistoryReplace: false,
        }
      }
      if (event.sessionCount === state.sessionCount && !state.pendingHistoryReplace) {
        return state
      }
      const nextMode: SiderMode =
        event.sessionCount === 0
          ? 'absent'
          : state.mode === 'absent'
            ? state.pendingHistoryReplace
              ? 'expanded'
              : 'collapsed'
            : state.mode
      return {
        phase: 'ready',
        mode: nextMode,
        sessionCount: event.sessionCount,
        pendingHistoryReplace: false,
      }
    }
    case 'setCollapsed': {
      if (state.mode === 'absent') {
        return state
      }
      const nextMode: SiderMode = event.collapsed ? 'collapsed' : 'expanded'
      return state.mode === nextMode ? state : { ...state, mode: nextMode }
    }
  }
}

export const siderModeOf = (state: Pick<SiderLayoutMachineState, 'mode'>): SiderMode => state.mode

/** Factory-scoped desktop sidebar layout controller wired eagerly to `log` and `sessions`. */
export const createSiderLayoutController = (log: EventLog, sessions: SessionCountSource) => {
  const syncEvent = (): SiderLayoutEvent => {
    const { ready, sessions: list } = sessions.getState()
    return { type: 'sessionsSynced', ready, sessionCount: list.length }
  }

  const useStore = create<SiderLayoutMachineState>(() =>
    stepSiderLayout(INITIAL_SIDER_LAYOUT, syncEvent())
  )

  const dispatch = (event: SiderLayoutEvent) => {
    const prev = useStore.getState()
    const next = stepSiderLayout(prev, event)
    if (next !== prev) {
      useStore.setState(next, true)
    }
  }

  const unsubHistory = log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
    dispatch({ type: 'historyReplaced' })
  })
  const unsubSessions = sessions.subscribe(() => {
    dispatch(syncEvent())
  })

  const setSiderCollapsed = (collapsed: boolean) => {
    dispatch({ type: 'setCollapsed', collapsed })
  }

  const dispose = () => {
    unsubSessions()
    unsubHistory()
  }

  return {
    useStore,
    getState: (): SiderLayoutState => ({ mode: useStore.getState().mode }),
    setSiderCollapsed,
    dispose,
  }
}

export type SiderLayoutController = ReturnType<typeof createSiderLayoutController>
