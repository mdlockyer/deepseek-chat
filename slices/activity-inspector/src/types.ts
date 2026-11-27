import type {
  CitedSourceMeta,
  DeliveredFileRef,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'

export type ActivityTab = 'activity' | 'sources'

export type ActivityTarget = {
  readonly sessionId: string
  readonly messageId: string
  readonly tab: ActivityTab
}

/**
 * What the panel shows. `follow_reading` tracks the turn the reader is on in the transcript (the
 * latest turn when no transcript port is wired or it has not reported yet); `pinned` holds one turn
 * until the reader moves on to another.
 */
export type ActivitySelection =
  | {
      readonly kind: 'follow_reading'
      readonly sessionId: string
      readonly tab: ActivityTab
    }
  | {
      readonly kind: 'pinned'
      readonly sessionId: string
      readonly messageId: string
      readonly tab: ActivityTab
      readonly focusedCallId?: string | null
      readonly focusNonce?: number
    }

export type SessionTurnSummary = {
  readonly messageId: string
  readonly turnNumber: number
  readonly promptExcerpt: string
  readonly streaming: boolean
  readonly hasActivity: boolean
}

export type TurnThinkingBlock = {
  readonly type: 'thinking'
  readonly thinking: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly elapsedSeconds?: number
}

export type TurnTextBlock = {
  readonly type: 'text'
  readonly text: string
  readonly isTemplate?: boolean
}

export type TurnToolUseBlock = ToolCallRecord & { readonly type: 'tool_use' }
export type TurnToolResultBlock = ToolResultRecord & {
  readonly type: 'tool_result'
  readonly searchResults?: readonly CitedSourceMeta[]
  readonly scrapedPage?: { readonly url: string; readonly title: string | null }
}

export type TurnBlock = TurnThinkingBlock | TurnTextBlock | TurnToolUseBlock | TurnToolResultBlock

export type TurnSnapshot = {
  readonly sessionId: string
  readonly messageId: string
  readonly status: 'pending' | 'streaming' | 'done' | 'stopped' | 'error'
  readonly streaming: boolean
  readonly blocks: readonly TurnBlock[]
  readonly capabilityState?: Readonly<Record<string, unknown>>
}

/** Narrow read-only live view into a conversation turn (avoids putting 60Hz deltas on EventLog). */
export type TurnSnapshotSource = {
  getTurn(sessionId: string, messageId: string): TurnSnapshot | null
  listTurns?(sessionId: string): readonly SessionTurnSummary[]
  subscribe(listener: () => void): () => void
}

export type ActivitySource = {
  readonly url: string
  readonly title: string
  readonly siteName: string
  readonly publishedAt: string | null
  readonly snippet: string | null
  readonly siteIcon: string | null
  readonly index: number
}

/** The turn a chat's transcript is on, and who moved it there (see `TranscriptPort`). */
export type TranscriptReadingPosition = {
  readonly messageId: string
  /** `'reader'` for the reader's own navigation; `'reveal'` when a view (this panel) asked for it. */
  readonly cause: 'reader' | 'reveal'
}

/**
 * The chat transcript, as this panel sees it: where the reader is, and a way to bring a turn into
 * view there when the reader picks one in the panel.
 */
export type TranscriptPort = {
  getReadingPosition(sessionId: string): TranscriptReadingPosition | null
  subscribeToReading(listener: () => void): () => void
  revealTurn(sessionId: string, messageId: string): void
}

export type ActivityInspectorDeps = {
  readonly log: EventLog
  readonly panel: PanelSlot
  readonly turnSource: TurnSnapshotSource
  readonly getPresenter: (
    capabilityId: string | undefined,
    toolName: string
  ) => ToolStepPresenter | null
  readonly openInApp: ((url: string) => void) | null
  readonly openFile?: (sessionId: string, file: DeliveredFileRef) => void
  /** Optional: without it the panel follows the latest turn and scrolling it moves nothing else. */
  readonly transcript?: TranscriptPort
}
