import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
  TurnInspectionRequested,
} from '@deepseek-chat/spine/facts/session'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'
import type { ActivitySelection, ActivityTab, ActivityTarget } from './types.js'

type ActivityPanelStoreState = {
  selection: ActivitySelection | null
  panelOpen: boolean
}

export const createActivityPanelState = (panel: PanelSlot, log: EventLog) => {
  const activeSessionId = () => panel.getLayout().activeSessionId
  let nextFocusNonce = 0

  const stripFocus = (selection: ActivitySelection): ActivitySelection =>
    selection.kind === 'pinned'
      ? {
          kind: 'pinned',
          sessionId: selection.sessionId,
          messageId: selection.messageId,
          tab: selection.tab,
        }
      : selection

  const useStore = create<ActivityPanelStoreState>(() => ({
    selection: null,
    panelOpen: panel.isOpen(activeSessionId()),
  }))

  const openForSession = (sessionId: string, tab?: ActivityTab) => {
    const prev = useStore.getState().selection
    const cleanPrev = prev && prev.sessionId === sessionId ? stripFocus(prev) : null
    const next: ActivitySelection = cleanPrev
      ? tab
        ? { ...cleanPrev, tab }
        : cleanPrev
      : { kind: 'follow_latest', sessionId, tab: tab ?? 'activity' }
    panel.open(sessionId)
    useStore.setState({ selection: next, panelOpen: panel.isOpen(sessionId) })
  }

  const togglePanel = (sessionId: string) => {
    if (panel.isOpen(sessionId)) {
      panel.close(sessionId)
      useStore.setState({ selection: null, panelOpen: false })
      return
    }
    openForSession(sessionId)
  }

  const toggleTurn = (sessionId: string, messageId: string, tab: ActivityTab, callId?: string) => {
    const { selection } = useStore.getState()
    if (
      !callId &&
      selection?.kind === 'pinned' &&
      selection.sessionId === sessionId &&
      selection.messageId === messageId &&
      selection.tab === tab &&
      panel.isOpen(sessionId)
    ) {
      panel.close(sessionId)
      useStore.setState({ selection: null, panelOpen: false })
      return
    }
    const next: ActivitySelection = callId
      ? {
          kind: 'pinned',
          sessionId,
          messageId,
          tab,
          focusedCallId: callId,
          focusNonce: ++nextFocusNonce,
        }
      : { kind: 'pinned', sessionId, messageId, tab }
    panel.open(sessionId)
    useStore.setState({ selection: next, panelOpen: panel.isOpen(sessionId) })
  }

  const selectTurn = (sessionId: string, messageId: string) => {
    const prevTab = useStore.getState().selection?.tab ?? 'activity'
    useStore.setState({
      selection: { kind: 'pinned', sessionId, messageId, tab: prevTab },
    })
  }

  const followLatest = (sessionId: string) => {
    const prevTab = useStore.getState().selection?.tab ?? 'activity'
    useStore.setState({
      selection: { kind: 'follow_latest', sessionId, tab: prevTab },
    })
  }

  const setTab = (tab: ActivityTab) => {
    useStore.setState((curr) => {
      if (!curr.selection || curr.selection.tab === tab) {
        return curr
      }
      return { selection: { ...curr.selection, tab } }
    })
  }

  const close = () => {
    const sessionId = activeSessionId()
    if (sessionId) {
      panel.close(sessionId)
    }
    useStore.setState({ selection: null, panelOpen: false })
  }

  const unsubPanel = panel.subscribe(() => {
    const sessionId = activeSessionId()
    const open = panel.isOpen(sessionId)
    useStore.setState((curr) => {
      if (open && sessionId && curr.selection?.sessionId !== sessionId) {
        return {
          selection: { kind: 'follow_latest', sessionId, tab: 'activity' },
          panelOpen: true,
        }
      }
      if (curr.panelOpen !== open) {
        return { panelOpen: open }
      }
      return curr
    })
  })

  const unsubFacts = [
    log.subscribe<ActiveSessionChanged>('ActiveSessionChanged', ({ fact }) => {
      const open = panel.isOpen(fact.sessionId)
      useStore.setState((curr) => {
        if (fact.sessionId && open) {
          return {
            selection:
              curr.selection?.sessionId === fact.sessionId
                ? curr.selection
                : { kind: 'follow_latest', sessionId: fact.sessionId, tab: 'activity' },
            panelOpen: true,
          }
        }
        return {
          selection: curr.selection?.sessionId === fact.sessionId ? curr.selection : null,
          panelOpen: open,
        }
      })
    }),
    log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      useStore.setState((curr) => ({
        selection: curr.selection?.sessionId === fact.sessionId ? null : curr.selection,
        panelOpen: panel.isOpen(activeSessionId()),
      }))
    }),
    log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      useStore.setState({ selection: null, panelOpen: false })
    }),
    log.subscribe<TurnInspectionRequested>('TurnInspectionRequested', ({ fact }) => {
      toggleTurn(fact.sessionId, fact.messageId, fact.tab, fact.callId)
    }),
  ]

  const getActiveTarget = (): ActivityTarget | null => {
    const { selection, panelOpen } = useStore.getState()
    if (!panelOpen || selection?.kind !== 'pinned') {
      return null
    }
    return {
      sessionId: selection.sessionId,
      messageId: selection.messageId,
      tab: selection.tab,
    }
  }

  return {
    useStore,
    togglePanel,
    toggleTurn,
    selectTurn,
    followLatest,
    setTab,
    close,
    getActiveTarget,
    dispose: () => {
      unsubPanel()
      for (const unsub of unsubFacts) {
        unsub()
      }
    },
  }
}

export type ActivityPanelState = ReturnType<typeof createActivityPanelState>
