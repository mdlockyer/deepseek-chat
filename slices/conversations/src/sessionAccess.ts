import { useMemo } from 'react'
import { getVisibleMessages } from './branches.js'
import { useChatStore } from './store.js'
import type { Message } from './types.js'

const NO_MESSAGES: readonly Message[] = []

/** A loaded chat's visible branch (empty while the chat is not loaded). */
export const getChatMessages = (sessionId: string): readonly Message[] => {
  const { sessionCache } = useChatStore.getState()
  return Object.hasOwn(sessionCache, sessionId)
    ? getVisibleMessages(sessionCache[sessionId])
    : NO_MESSAGES
}

/** React: a chat's visible branch (empty while the chat is not loaded). */
export const useChatMessages = (sessionId: string | null): readonly Message[] => {
  const session = useChatStore((state) =>
    sessionId && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
  )
  return useMemo(() => (session ? getVisibleMessages(session) : NO_MESSAGES), [session])
}

/** React: history import/clear in progress, and whether there are any chats. */
export const useHistoryState = () => ({
  replacing: useChatStore((state) => state.importingHistory),
  empty: useChatStore((state) => state.sessions.length === 0),
})
