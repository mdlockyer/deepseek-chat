import { create } from 'zustand'

/**
 * Who moved the transcript to a turn: the reader (scrolling, the minimap, shortcuts, a new
 * reply arriving at the bottom) or a reveal another view asked for (the Activity panel). Views
 * that follow the transcript follow the reader and ignore reveals they caused themselves.
 */
export type ReadingCause = 'reader' | 'reveal'

/** The turn the transcript is on, by its reply's message id. */
export type ReadingPosition = { readonly messageId: string; readonly cause: ReadingCause }

/** A request to bring a turn (or the latest output) into view in a chat's transcript. */
export type RevealRequest = {
  readonly sessionId: string
  readonly target:
    | { readonly kind: 'turn'; readonly messageId: string }
    | { readonly kind: 'latest' }
  readonly nonce: number
}

type ReadingState = {
  readonly positions: Readonly<Record<string, ReadingPosition>>
  readonly reveal: RevealRequest | null
}

/**
 * Factory-scoped record of each chat's reading position, written by the transcript view and read
 * by sibling views through narrow ports, plus the reveal requests those views send back. Changes
 * at most once per turn crossed, never per scroll frame.
 */
export const createReadingPositions = () => {
  let nonce = 0
  const useReadingStore = create<ReadingState>(() => ({ positions: {}, reveal: null }))

  const getReadingPosition = (sessionId: string): ReadingPosition | null =>
    useReadingStore.getState().positions[sessionId] ?? null

  const setReadingPosition = (sessionId: string, messageId: string, cause: ReadingCause) => {
    if (getReadingPosition(sessionId)?.messageId === messageId) {
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

  const request = (sessionId: string, target: RevealRequest['target']) => {
    nonce += 1
    useReadingStore.setState({ reveal: { sessionId, target, nonce } })
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
    useReadingStore,
    getReadingPosition,
    setReadingPosition,
    subscribeToReading,
    /** Brings a turn into view in that chat's transcript, as if the reader had navigated to it. */
    revealTurn: (sessionId: string, messageId: string) =>
      request(sessionId, { kind: 'turn', messageId }),
    /** Scrolls that chat's transcript to its latest output and follows it again. */
    revealLatest: (sessionId: string) => request(sessionId, { kind: 'latest' }),
    forget,
    clear: () => useReadingStore.setState({ positions: {}, reveal: null }),
  }
}

export type ReadingPositions = ReturnType<typeof createReadingPositions>
