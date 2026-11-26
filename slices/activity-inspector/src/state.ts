import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
  TurnInspectionRequested,
} from '@deepseek-chat/spine/facts/session'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'
import type { ActivitySelection, ActivityTab, ActivityTarget, TranscriptPort } from './types.js'

type ActivityPanelStoreState = {
  selection: ActivitySelection | null
  panelOpen: boolean
}

export const createActivityPanelState = (
  panel: PanelSlot,
  log: EventLog,
  options: {
    readonly transcript?: TranscriptPort
    /** The turn a selection shows, resolved against the chat's turns and reading position. */
    readonly resolveMessageId: (selection: ActivitySelection) => string | null
  }
) => {
  const { transcript, resolveMessageId } = options
  const activeSessionId = () => panel.getLayout().activeSessionId
  let nextFocusNonce = 0

  const following = (sessionId: string, tab: ActivityTab): ActivitySelection => ({
    kind: 'follow_reading',
    sessionId,
    tab,
  })

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

  const currentTab = () => useStore.getState().selection?.tab ?? 'activity'

  const openForSession = (sessionId: string, tab?: ActivityTab) => {
    const prev = useStore.getState().selection
    const cleanPrev = prev && prev.sessionId === sessionId ? stripFocus(prev) : null
    const next: ActivitySelection = cleanPrev
      ? tab
        ? { ...cleanPrev, tab }
        : cleanPrev
      : following(sessionId, tab ?? 'activity')
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

  /**
   * Shows a turn (and optionally one of its steps). Without `callId`, asking again for the turn and
   * tab the open panel already shows closes the panel, whether it got there by following or pinning.
   */
  const toggleTurn = (sessionId: string, messageId: string, tab: ActivityTab, callId?: string) => {
    const { selection } = useStore.getState()
    if (
      !callId &&
      selection &&
      selection.sessionId === sessionId &&
      selection.tab === tab &&
      resolveMessageId(selection) === messageId &&
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

  /** Pins a turn in the open panel and brings it into view in the transcript too. */
  const selectTurn = (sessionId: string, messageId: string) => {
    useStore.setState({
      selection: { kind: 'pinned', sessionId, messageId, tab: currentTab() },
    })
    transcript?.revealTurn(sessionId, messageId)
  }

  /** Follows the reader again and takes the transcript to its latest output. */
  const followLatest = (sessionId: string) => {
    useStore.setState({ selection: following(sessionId, currentTab()) })
    transcript?.revealLatest(sessionId)
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
        return { selection: following(sessionId, 'activity'), panelOpen: true }
      }
      if (curr.panelOpen !== open) {
        return { panelOpen: open }
      }
      return curr
    })
  })

  // The reader moving to another turn releases a pin; reveals this panel asked for do not.
  const unsubReading =
    transcript?.subscribeToReading(() => {
      const { selection } = useStore.getState()
      if (selection?.kind !== 'pinned') {
        return
      }
      const position = transcript.getReadingPosition(selection.sessionId)
      if (position && position.cause === 'reader' && position.messageId !== selection.messageId) {
        useStore.setState({ selection: following(selection.sessionId, selection.tab) })
      }
    }) ?? (() => undefined)

  const unsubFacts = [
    log.subscribe<ActiveSessionChanged>('ActiveSessionChanged', ({ fact }) => {
      const open = panel.isOpen(fact.sessionId)
      useStore.setState((curr) => {
        if (fact.sessionId && open) {
          return {
            selection:
              curr.selection?.sessionId === fact.sessionId
                ? curr.selection
                : following(fact.sessionId, 'activity'),
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
      unsubReading()
      for (const unsub of unsubFacts) {
        unsub()
      }
    },
  }
}

export type ActivityPanelState = ReturnType<typeof createActivityPanelState>
