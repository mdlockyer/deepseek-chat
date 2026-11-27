import { create } from 'zustand'
import type {
  ReadingCause,
  ReadingPosition,
  ReadingPositions,
  ReadingState,
  RevealRequest,
} from '../../kernel/index.js'

/**
 * Factory-scoped record of each chat's reading position, written by the transcript view and read
 * by sibling views through narrow ports, plus the reveal requests those views send back. Changes
 * at most once per turn crossed, never per scroll frame.
 */
export const createReadingPositions = (): ReadingPositions => {
  let nonce = 0
  const useReadingStore = create<ReadingState>(() => ({ positions: {}, reveal: null }))

  const getReadingPosition = (sessionId: string): ReadingPosition | null =>
    useReadingStore.getState().positions[sessionId] ?? null

  const setReadingPosition = (sessionId: string, messageId: string, cause: ReadingCause) => {
    const prev = getReadingPosition(sessionId)
    if (prev?.messageId === messageId && prev.cause === cause) {
      return
    }
    useReadingStore.setState((state) => ({
      positions: { ...state.positions, [sessionId]: { messageId, cause } },
    }))
  }

  const subscribeToReading = (listener: () => void) => {
    let previous = useReadingStore.getState().positions
    return useReadingStore.subscribe((state) => {
      if (state.positions !== previous) {
        previous = state.positions
        listener()
      }
    })
  }

  const request = (sessionId: string, messageId: string) => {
    nonce += 1
    useReadingStore.setState({ reveal: { sessionId, messageId, nonce } })
  }

  const forget = (sessionId: string) => {
    useReadingStore.setState((state) => {
      if (!Object.hasOwn(state.positions, sessionId)) {
        return state
      }
      return {
        positions: Object.fromEntries(
          Object.entries(state.positions).filter(([id]) => id !== sessionId)
        ),
      }
    })
  }

  return {
    useReadingState: useReadingStore,
    getRevealRequest: (): RevealRequest | null => useReadingStore.getState().reveal,
    getReadingPosition,
    setReadingPosition,
    subscribeToReading,
    revealTurn: (sessionId: string, messageId: string) => request(sessionId, messageId),
    forget,
    clear: () => useReadingStore.setState({ positions: {}, reveal: null }),
  }
}
