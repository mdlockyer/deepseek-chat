/**
 * Facts produced by the conversations domain (chat sessions).
 * Producer: slices/conversations.
 */

/** One file present on a chat's visible branch (a user attachment or a tool-delivered file). */
export type SessionFileDescriptor = {
  readonly kind: 'upload' | 'delivered'
  readonly fileId: string
  readonly name: string
  readonly size: number
  readonly mimeType: string
  readonly path?: string
  readonly title?: string
  readonly version?: number
  /** Capability ID that produced the delivered file (absent for user uploads). */
  readonly producer?: string
  readonly producedByTool?: string
  readonly messageId: string
  readonly createdAt: number
}

/** A chat session and everything it owns were deleted by the user. Discrete. */
export type SessionDeleted = {
  readonly type: 'SessionDeleted'
  readonly sessionId: string
}

/** Every chat session was discarded and replaced (history import or clear). Discrete. */
export type SessionHistoryReplaced = {
  readonly type: 'SessionHistoryReplaced'
}

/** The chat currently shown on screen (`null` for the new-chat screen). Sticky under key `'unit'`. */
export type ActiveSessionChanged = {
  readonly type: 'ActiveSessionChanged'
  readonly sessionId: string | null
}

/** A reply started streaming or settled (completed, stopped, or failed). Discrete. */
export type ReplyLifecycleChanged = {
  readonly type: 'ReplyLifecycleChanged'
  readonly sessionId: string
  readonly messageId: string
  readonly phase: 'started' | 'settled'
}

/**
 * Projection of all files on a chat's visible branch (uploads + tool-delivered files),
 * in conversation order. Sticky under key `sessionId` (tombstoned when deleted).
 */
export type SessionFilesChanged = {
  readonly type: 'SessionFilesChanged'
  readonly sessionId: string
  readonly files: readonly SessionFileDescriptor[]
}

/** A tool call delivered a new file into a reply and persisted its bytes to BlobStore. Discrete. */
export type ToolFileDelivered = {
  readonly type: 'ToolFileDelivered'
  readonly sessionId: string
  readonly messageId: string
  readonly file: SessionFileDescriptor
  readonly isActiveSession: boolean
}

/** The user requested inspecting a reply's activity or sources in the inspector panel. Discrete. */
export type TurnInspectionRequested = {
  readonly type: 'TurnInspectionRequested'
  readonly sessionId: string
  readonly messageId: string
  readonly tab: 'activity' | 'sources'
  /** Optional tool call ID to expand and scroll into view inside the Activity panel. */
  readonly callId?: string
}
