/**
 * Facts produced by the conversations domain (chat sessions).
 * Producer: src/services/chat/store.ts (moves to slices/conversations).
 */

/** A chat session and everything it owns were deleted by the user. Discrete. */
export type SessionDeleted = {
  readonly type: 'SessionDeleted'
  readonly sessionId: string
}

/** Every chat session was discarded and replaced (history import or clear). Discrete. */
export type SessionHistoryReplaced = {
  readonly type: 'SessionHistoryReplaced'
}
