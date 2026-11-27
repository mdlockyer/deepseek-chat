import type { DeliveredFileRef, ToolStepPresenter } from '@deepseek-chat/lib-tools'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import type { AssistantMessage, ReadingPosition, ReplyBlock } from '../../kernel/index.js'

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

export type TurnSnapshot = {
  readonly sessionId: string
  readonly messageId: string
  readonly status: AssistantMessage['status']
  readonly streaming: boolean
  readonly blocks: readonly ReplyBlock[]
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

/**
 * The chat transcript, as this cell sees it: where the reader is, and a way to bring a turn into
 * view there when the reader picks one in the panel.
 */
export type TranscriptPort = {
  getReadingPosition(sessionId: string): ReadingPosition | null
  subscribeToReading(listener: () => void): () => void
  revealTurn(sessionId: string, messageId: string): void
}

export type ActivityInspectorCellDeps = {
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
