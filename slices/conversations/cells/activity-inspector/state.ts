import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'
import type { ActivitySelection, ActivityTab, TranscriptPort } from './types.js'

/** Single-owner selection state; open/closed visibility is owned solely by `PanelSlot`. */
type ActivityPanelStoreState = {
  readonly selection: ActivitySelection | null
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
    useStore.setState({ selection: next })
  }

  const togglePanel = (sessionId: string) => {
    if (panel.isOpen(sessionId)) {
      panel.close(sessionId)
      useStore.setState({ selection: null })
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
      useStore.setState({ selection: null })
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
    useStore.setState({ selection: next })
  }

  /** Pins a turn in the open panel, leaving the transcript where it is. */
  const pinTurn = (sessionId: string, messageId: string) => {
    useStore.setState({
      selection: { kind: 'pinned', sessionId, messageId, tab: currentTab() },
    })
  }

  /** Pins a turn in the open panel and brings it into view in the transcript too. */
  const selectTurn = (sessionId: string, messageId: string) => {
    pinTurn(sessionId, messageId)
    transcript?.revealTurn(sessionId, messageId)
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
    useStore.setState({ selection: null })
  }

  const unsubPanel = panel.subscribe(() => {
    const sessionId = activeSessionId()
    if (!sessionId || !panel.isOpen(sessionId)) {
      return
    }
    useStore.setState((curr) =>
      curr.selection?.sessionId === sessionId
        ? curr
        : { selection: following(sessionId, 'activity') }
    )
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
          return curr.selection?.sessionId === fact.sessionId
            ? curr
            : { selection: following(fact.sessionId, 'activity') }
        }
        return curr.selection?.sessionId === fact.sessionId ? curr : { selection: null }
      })
    }),
    log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      useStore.setState((curr) =>
        curr.selection?.sessionId === fact.sessionId ? { selection: null } : curr
      )
    }),
    log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      useStore.setState({ selection: null })
    }),
  ]

  return {
    useStore,
    togglePanel,
    toggleTurn,
    pinTurn,
    selectTurn,
    setTab,
    close,
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
