import type {
  ArchiveAssistantMessage,
  ArchiveFileAttachment,
  ArchiveReplyStatus,
  ArchiveSession,
  ArchiveTextPart,
  ArchiveThinkingPart,
  ArchiveToolCallPart,
  ArchiveToolResultPart,
  ArchiveUserMessage,
} from '@deepseek-chat/lib-chat-archive-contract'
import type { FrontStageNote, ToolProgress } from '@deepseek-chat/lib-tools'

export type FileAttachment = ArchiveFileAttachment

export type UserMessage = ArchiveUserMessage

export type ThinkingPart = ArchiveThinkingPart

export type TextPart = ArchiveTextPart

export type ToolCallPart = ArchiveToolCallPart

export type ToolResultPart = ArchiveToolResultPart & {
  progress?: ToolProgress
  startedAt?: number
  durationMs?: number
  images?: string[]
  previewImages?: string[]
  imageFileIds?: (string | null)[]
  frontStageNote?: FrontStageNote
}

export type ReplyBlock = ThinkingPart | TextPart | ToolCallPart | ToolResultPart

export type ReplyStatus = ArchiveReplyStatus

export type AssistantMessage = Omit<ArchiveAssistantMessage, 'blocks'> & {
  capabilityState?: Record<string, unknown>
  /** Dynamic `<environment_context>` snapshot active on this turn. */
  environmentContext?: string
  /** Legacy persisted CSV reminder from older sessions; normalized via `resolveEnvironmentContext`. */
  latestReminder?: string
  blocks: ReplyBlock[]
}

export type Message = UserMessage | AssistantMessage

export type CompactionTrigger = 'turnStart' | 'betweenRounds' | 'manual' | 'fit' | 'overflow'

export type CompactionCheckpoint = {
  readonly id: string
  /** Last visible-branch message covered by this checkpoint. */
  readonly anchorMessageId: string
  /** Set only for mid-turn compactions: covers `reply.blocks[0..afterBlockIndex]` inclusive. */
  readonly afterBlockIndex?: number
  readonly trigger: CompactionTrigger
  readonly createdAt: number
  /** Frozen wire text sent to the model (immutable across turns and reloads for KV-cache reuse). */
  readonly renderedWireText: string
  /** Model-written summary markdown shown when the user expands the transcript divider. */
  readonly summary: string
  readonly keptMessagesCount: number
  readonly droppedMessagesCount: number
  readonly droppedReasoning: boolean
  readonly tokensBefore: number
  readonly tokensAfter: number
}

export type Session = Omit<ArchiveSession, 'messages'> & {
  messages: Message[]
  checkpoints?: CompactionCheckpoint[]
}

export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>

export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})
