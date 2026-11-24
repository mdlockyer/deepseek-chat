import { create } from 'zustand'
import { deps } from '../../env.js'

export type ActivityTab = 'activity' | 'sources'

export type ActivityTarget = {
  sessionId: string
  messageId: string
  tab: ActivityTab
}

type ActivityPanelState = {
  target: ActivityTarget | null
  /** Preserved when switching to another right-hand panel so one-click return works. */
  lastTarget: ActivityTarget | null
}

export const useActivityPanel = create<ActivityPanelState>(() => ({
  target: null,
  lastTarget: null,
}))

const slot = () => deps().ui.panels.activity
const activeSessionId = () => slot().getLayout().activeSessionId

/**
 * Keeps `lastTarget` when the shared right panel switches away from Activity on the same session.
 * Called once when creating the conversations slice.
 */
export const bindActivityPanel = () => {
  let wasOpen = slot().isOpen(activeSessionId())
  let lastSession = activeSessionId()
  return slot().subscribe(() => {
    const sessionId = activeSessionId()
    const open = slot().isOpen(sessionId)
    if (sessionId && sessionId === lastSession && wasOpen && !open) {
      useActivityPanel.setState((curr) =>
        curr.target ? { target: null, lastTarget: curr.target } : curr
      )
    }
    wasOpen = open
    lastSession = sessionId
  })
}

export const toggleActivityPanel = (sessionId: string, messageId: string, tab: ActivityTab) => {
  const { target } = useActivityPanel.getState()
  if (
    target &&
    target.sessionId === sessionId &&
    target.messageId === messageId &&
    target.tab === tab &&
    slot().isOpen(sessionId)
  ) {
    slot().close(sessionId)
    useActivityPanel.setState({ target: null, lastTarget: null })
    return
  }
  const next: ActivityTarget = { sessionId, messageId, tab }
  slot().open(sessionId)
  useActivityPanel.setState({ target: next, lastTarget: next })
}

export const setActivityPanelTab = (tab: ActivityTab) => {
  useActivityPanel.setState((curr) => {
    if (!curr.target || curr.target.tab === tab) {
      return curr
    }
    const next = { ...curr.target, tab }
    return { target: next, lastTarget: next }
  })
}

export const restoreLastActivityPanel = () => {
  const { lastTarget } = useActivityPanel.getState()
  const sessionId = activeSessionId()
  if (!lastTarget || !sessionId || lastTarget.sessionId !== sessionId) {
    return
  }
  slot().open(sessionId)
  useActivityPanel.setState({ target: lastTarget })
}

export const closeActivityPanel = () => {
  const sessionId = activeSessionId()
  if (sessionId) {
    slot().close(sessionId)
  }
  useActivityPanel.setState({ target: null, lastTarget: null })
}
