import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
  TurnInspectionRequested,
} from '@deepseek-chat/spine/facts/session'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { create } from 'zustand'
import type { ActivityTab, ActivityTarget } from './types.js'

type ActivityPanelStoreState = {
  target: ActivityTarget | null
  lastTarget: ActivityTarget | null
}

export const createActivityPanelState = (panel: PanelSlot, log: EventLog) => {
  const useStore = create<ActivityPanelStoreState>(() => ({
    target: null,
    lastTarget: null,
  }))

  const activeSessionId = () => panel.getLayout().activeSessionId

  const toggle = (sessionId: string, messageId: string, tab: ActivityTab) => {
    const { target } = useStore.getState()
    if (
      target &&
      target.sessionId === sessionId &&
      target.messageId === messageId &&
      target.tab === tab &&
      panel.isOpen(sessionId)
    ) {
      panel.close(sessionId)
      useStore.setState({ target: null, lastTarget: null })
      return
    }
    const next: ActivityTarget = { sessionId, messageId, tab }
    panel.open(sessionId)
    useStore.setState({ target: next, lastTarget: next })
  }

  const setTab = (tab: ActivityTab) => {
    useStore.setState((curr) => {
      if (!curr.target || curr.target.tab === tab) {
        return curr
      }
      const next: ActivityTarget = { ...curr.target, tab }
      return { target: next, lastTarget: next }
    })
  }

  const restoreLast = () => {
    const { lastTarget } = useStore.getState()
    const sessionId = activeSessionId()
    if (!lastTarget || !sessionId || lastTarget.sessionId !== sessionId) {
      return
    }
    panel.open(sessionId)
    useStore.setState({ target: lastTarget })
  }

  const close = () => {
    const sessionId = activeSessionId()
    if (sessionId) {
      panel.close(sessionId)
    }
    useStore.setState({ target: null, lastTarget: null })
  }

  let wasOpen = panel.isOpen(activeSessionId())
  let lastSession = activeSessionId()
  const unsubPanel = panel.subscribe(() => {
    const sessionId = activeSessionId()
    const open = panel.isOpen(sessionId)
    if (sessionId && sessionId === lastSession && wasOpen && !open) {
      useStore.setState((curr) => (curr.target ? { target: null, lastTarget: curr.target } : curr))
    }
    wasOpen = open
    lastSession = sessionId
  })

  const unsubFacts = [
    log.subscribe<ActiveSessionChanged>('ActiveSessionChanged', ({ fact }) => {
      useStore.setState((curr) => {
        if (!curr.target && !curr.lastTarget) {
          return curr
        }
        if (curr.target?.sessionId === fact.sessionId) {
          return curr
        }
        return {
          target: null,
          lastTarget: curr.lastTarget?.sessionId === fact.sessionId ? curr.lastTarget : null,
        }
      })
    }),
    log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      useStore.setState((curr) => ({
        target: curr.target?.sessionId === fact.sessionId ? null : curr.target,
        lastTarget: curr.lastTarget?.sessionId === fact.sessionId ? null : curr.lastTarget,
      }))
    }),
    log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      useStore.setState({ target: null, lastTarget: null })
    }),
    log.subscribe<TurnInspectionRequested>('TurnInspectionRequested', ({ fact }) => {
      toggle(fact.sessionId, fact.messageId, fact.tab)
    }),
  ]

  return {
    useStore,
    toggle,
    setTab,
    restoreLast,
    close,
    dispose: () => {
      unsubPanel()
      for (const unsub of unsubFacts) {
        unsub()
      }
    },
  }
}

export type ActivityPanelState = ReturnType<typeof createActivityPanelState>
