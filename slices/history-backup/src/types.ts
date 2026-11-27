import type {
  ArchiveAssistantMessage,
  ArchiveFileAttachment,
  ArchiveMessage,
  ArchiveReplyBlock,
  ArchiveReplyStatus,
  ArchiveSession,
  ArchiveSessionSummary,
  ArchiveTextPart,
  ArchiveThinkingPart,
  ArchiveToolCallPart,
  ArchiveToolResultPart,
  ArchiveUserMessage,
  ChatArchiveSessionsPort,
} from '@deepseek-chat/lib-chat-archive-contract'
import type { ArchiveFragment, ToolCallRecord, ToolResultRecord } from '@deepseek-chat/lib-tools'
import type { BlobStore, NoticePort } from '@deepseek-chat/spine/ports'

export type BackupFileAttachment = ArchiveFileAttachment
export type BackupUserMessage = ArchiveUserMessage
export type BackupThinkingPart = ArchiveThinkingPart
export type BackupTextPart = ArchiveTextPart
export type BackupToolCallPart = ArchiveToolCallPart
export type BackupToolResultPart = ArchiveToolResultPart
export type BackupReplyBlock = ArchiveReplyBlock
export type BackupReplyStatus = ArchiveReplyStatus
export type BackupAssistantMessage = ArchiveAssistantMessage
export type BackupMessage = ArchiveMessage
export type BackupSession = ArchiveSession
export type BackupSessionSummary = ArchiveSessionSummary
export type HistorySessionsPort = ChatArchiveSessionsPort

export type ToolBlockSerializer = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
) => readonly ArchiveFragment[] | null

export type HistoryBackupDeps = {
  readonly blobs: BlobStore
  readonly sessions: HistorySessionsPort
  readonly serializeToolBlock?: ToolBlockSerializer
  readonly notify?: NoticePort
  readonly saveFile?: (name: string, blob: Blob) => Promise<void>
  readonly now?: () => Date
}
