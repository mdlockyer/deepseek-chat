/**
 * Who moved the transcript to a turn: the reader (scrolling, the minimap, shortcuts, a new
 * reply arriving at the bottom) or a reveal another view asked for (the Activity panel). Views
 * that follow the transcript follow the reader and ignore reveals they caused themselves.
 */
export type ReadingCause = 'reader' | 'reveal'

/** The turn the transcript is on, by its reply's message id. */
export type ReadingPosition = { readonly messageId: string; readonly cause: ReadingCause }

/** A request to bring a turn into view in a chat's transcript. */
export type RevealRequest = {
  readonly sessionId: string
  readonly messageId: string
  readonly nonce: number
}

export type ReadingState = {
  readonly positions: Readonly<Record<string, ReadingPosition>>
  readonly reveal: RevealRequest | null
}

/** Narrow port shared by transcript views and the Activity Inspector cell. */
export type ReadingPositions = {
  useReadingState<T>(selector: (state: ReadingState) => T): T
  getRevealRequest(): RevealRequest | null
  getReadingPosition(sessionId: string): ReadingPosition | null
  setReadingPosition(sessionId: string, messageId: string, cause: ReadingCause): void
  subscribeToReading(listener: () => void): () => void
  revealTurn(sessionId: string, messageId: string): void
  forget(sessionId: string): void
  clear(): void
}
