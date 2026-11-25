import type {
  ChatModel,
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '@deepseek-chat/lib-agent'
import type {
  ArchiveFragment,
  CitedSourceMeta,
  DeliveredFileRef,
  ToolCallRecord,
  ToolResultRecord,
} from '@deepseek-chat/lib-tools'
import type { BlobEntry, BlobStore, NoticePort } from '@deepseek-chat/spine/ports'

export type BackupFileAttachment = {
  id: string
  serverId: string | null
  name: string
  size: number
  isImage: boolean
  mimeType: string
}

type BranchLinks = {
  parentId?: string | null
  selectedChildId?: string
}

export type BackupUserMessage = BranchLinks & {
  id: string
  role: 'user'
  content: string
  files: BackupFileAttachment[]
  createdAt: number
}

export type BackupThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  startedAt?: number
  endedAt?: number
  elapsedSeconds?: number
}

export type BackupTextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  isTemplate?: boolean
}

export type BackupToolCallPart = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  inputJson?: string
}

export type BackupToolResultPart = {
  type: 'tool_result'
  tool_use_id: string
  capability?: string
  content: string
  status: 'running' | 'ok' | 'error' | 'aborted'
  files?: readonly DeliveredFileRef[]
  sources?: readonly CitedSourceMeta[]
  searchResults?: readonly CitedSourceMeta[]
  payload?: unknown
  [key: string]: unknown
}

export type BackupReplyBlock =
  | BackupThinkingPart
  | BackupTextPart
  | ServerToolBlock
  | BackupToolCallPart
  | BackupToolResultPart

export type BackupReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type BackupAssistantMessage = BranchLinks & {
  id: string
  role: 'assistant'
  createdAt: number
  model: ChatModel | null
  thinking?: boolean
  search?: boolean
  enabledCapabilities?: Readonly<Record<string, boolean>>
  prefix: boolean
  status: BackupReplyStatus
  blocks: BackupReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  usage?: MessageUsage
  error?: {
    kind: string
    message: string
    status?: number
    [key: string]: unknown
  }
}

export type BackupMessage = BackupUserMessage | BackupAssistantMessage

export type BackupSession = {
  id: string
  title: string
  titleLocked?: boolean
  createdAt: number
  updatedAt: number
  messages: BackupMessage[]
  rootMessageId?: string | null
}

export type BackupSessionSummary = Pick<BackupSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>

export type ToolBlockSerializer = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
) => readonly ArchiveFragment[] | null

export type HistorySessionsPort = {
  snapshotForExport(): {
    readonly summaries: readonly BackupSessionSummary[]
    readonly loadSession: (id: string) => Promise<BackupSession | undefined>
  }
  replaceHistory(
    prepare: () => Promise<{
      readonly sessions: readonly BackupSession[]
      readonly blobs: readonly BlobEntry[]
    }>
  ): Promise<number>
  useState(): { readonly replacing: boolean; readonly empty: boolean }
  describeReplyNotice?(message: BackupAssistantMessage): string | null
}

export type HistoryBackupDeps = {
  readonly blobs: BlobStore
  readonly sessions: HistorySessionsPort
  readonly serializeToolBlock?: ToolBlockSerializer
  readonly notify?: NoticePort
  readonly saveFile?: (name: string, blob: Blob) => Promise<void>
  readonly now?: () => Date
}
